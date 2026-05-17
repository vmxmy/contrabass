import { test, expect } from "@playwright/test";

import { issueSession, SESSION_COOKIE_NAME } from "../../src/litellm-portal/auth/session";
import type { LiteLLMPortalEnv } from "../../src/litellm-portal/types";

// MUST stay identical to `PERF_DEV_SESSION_SECRET` in playwright.config.ts —
// the perf webServer pins it on the served worker via
// `--var PORTAL_SESSION_SECRET:...`, so the cookie we mint here verifies
// (sign == verify). A spec cannot import the Playwright config (Playwright
// forbids config-imported test files), hence the deliberate duplication.
const PERF_DEV_SESSION_SECRET = "perf-e2e-portal-session-secret-32b!!";

// §F.2 (V2.0 §2.1): CLS < 0.1 is a HARD GATE on the three primary routes.
// LCP/INP are collected and printed (observational, like §A.3's bundle delta
// — recorded in DESIGN.md, not a CI gate). No Lighthouse/new dep — uses the
// browser's own PerformanceObserver via the existing Playwright harness.
//
// Auth: a REAL signed `portal_session` cookie (the only auth path —
// `authenticateRequest` is session-cookie-only; the old
// `x-litellm-portal-dev-email` header was a reverted dead shim and is a NO-OP,
// so measuring with it measured the UNAUTHENTICATED legacy pages, not the
// Phase-3 restyled authenticated shells). We mint the cookie with the project's
// own `issueSession` over the SAME `PERF_DEV_SESSION_SECRET` the perf webServer
// pins via `--var PORTAL_SESSION_SECRET:...` (playwright.config.ts), so the
// served worker verifies it (sign == verify locally). An auth-proof assertion
// runs BEFORE CLS is measured so a regression to the unauth page can no longer
// silently pass this gate. Email must be portal-allowed (wrangler
// `LITELLM_PORTAL_ALLOWED_EMAILS`).

const ALLOWED_EMAIL = "blueyang@gmail.com";

// Minimal env: only the field `issueSession` reads. Same idiom as the unit
// specs (ops-routes.test.ts) — construct a thin env carrying the secret.
const minterEnv = {
  PORTAL_SESSION_SECRET: PERF_DEV_SESSION_SECRET,
} as unknown as LiteLLMPortalEnv;

test.beforeEach(async ({ context }) => {
  const value = await issueSession(minterEnv, {
    email: ALLOWED_EMAIL,
    userId: ALLOWED_EMAIL,
  });
  await context.addCookies([
    {
      name: SESSION_COOKIE_NAME,
      value,
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
});

const ROUTES = ["/", "/usage", "/ops"] as const;
const CLS_HARD_MAX = 0.1;

// The authenticated, Phase-3 restyled shell each route renders. `/` and
// `/usage` mount the tenant portal shell (`#tenant-portal-shell-root` +
// `[data-brand-summary-bar]`); `/ops` mounts the Ops console shell
// (`#ops-console-shell-root`). None of these markers exist on the
// unauthenticated legacy page — so this assertion proves the session cookie
// actually authenticated before any CLS is measured.
const AUTH_PROOF_SELECTOR: Record<(typeof ROUTES)[number], string> = {
  "/": "#tenant-portal-shell-root, [data-brand-summary-bar]",
  "/usage": "#tenant-portal-shell-root, [data-brand-summary-bar]",
  "/ops": "#ops-console-shell-root",
};

async function collectVitals(page: import("@playwright/test").Page) {
  // Install observers BEFORE navigation-driven layout settles, then read after
  // the page is visually complete + a small settle window.
  return page.evaluate(
    () =>
      new Promise<{ cls: number; lcp: number }>((resolve) => {
        let cls = 0;
        let lcp = 0;
        const clsObs = new PerformanceObserver((l) => {
          for (const e of l.getEntries() as unknown as Array<{ value: number; hadRecentInput: boolean }>) {
            if (!e.hadRecentInput) cls += e.value;
          }
        });
        clsObs.observe({ type: "layout-shift", buffered: true });
        const lcpObs = new PerformanceObserver((l) => {
          const es = l.getEntries();
          lcp = (es[es.length - 1] as unknown as { startTime: number })?.startTime ?? lcp;
        });
        lcpObs.observe({ type: "largest-contentful-paint", buffered: true });
        // Settle window: CLS accrues across the load; 2.5s after load is a
        // pragmatic, stable cut for these data screens.
        setTimeout(() => {
          clsObs.disconnect();
          lcpObs.disconnect();
          resolve({ cls, lcp });
        }, 2500);
      }),
  );
}

for (const route of ROUTES) {
  test(`§F.2 perf budget: ${route} CLS < ${CLS_HARD_MAX} (hard gate); LCP observed`, async ({ page }) => {
    await page.goto(route, { waitUntil: "load" });
    // AUTH PROOF: the authenticated restyled shell must be present BEFORE we
    // measure — otherwise we are measuring the unauth legacy page and the gate
    // is meaningless (Blocker-2).
    await expect(
      page.locator(AUTH_PROOF_SELECTOR[route]).first(),
      `auth proof failed on ${route}: authenticated Phase-3 shell did not render — ` +
        `the portal_session cookie did not authenticate (would measure the unauth legacy page)`,
    ).toBeVisible({ timeout: 15_000 });
    const { cls, lcp } = await collectVitals(page);
    // Observational (printed to the run log, mirrored into DESIGN.md by Step 4):
    console.log(`[perf] route=${route} CLS=${cls.toFixed(4)} LCP=${Math.round(lcp)}ms`);
    // HARD GATE: CLS only.
    expect(cls, `CLS budget breached on ${route} (V2.0 §2.1 < 0.1)`).toBeLessThan(CLS_HARD_MAX);
    // LCP is observed (not gated); assert it is a finite number was measured.
    expect(Number.isFinite(lcp)).toBe(true);
  });
}
