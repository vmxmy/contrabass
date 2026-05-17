import { test, expect } from "@playwright/test";

// §F.2 (V2.0 §2.1): CLS < 0.1 is a HARD GATE on the three primary routes.
// LCP/INP are collected and printed (observational, like §A.3's bundle delta
// — recorded in DESIGN.md, not a CI gate). No Lighthouse/new dep — uses the
// browser's own PerformanceObserver via the existing Playwright harness.

// Dev-auth header: the existing test:e2e harness authenticates via the
// x-litellm-portal-dev-email request header (LITELLM_PORTAL_DEV_AUTH=true on
// the wrangler-dev webServer). Without it the SSR portal redirects to login
// and the measured routes never render real content. Same identity wiring the
// other specs in tests/e2e/ use — not a new server.
test.use({
  extraHTTPHeaders: {
    "x-litellm-portal-dev-email": "blueyang@gmail.com",
  },
});

const ROUTES = ["/", "/usage", "/ops"] as const;
const CLS_HARD_MAX = 0.1;

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
    const { cls, lcp } = await collectVitals(page);
    // Observational (printed to the run log, mirrored into DESIGN.md by Step 4):
    console.log(`[perf] route=${route} CLS=${cls.toFixed(4)} LCP=${Math.round(lcp)}ms`);
    // HARD GATE: CLS only.
    expect(cls, `CLS budget breached on ${route} (V2.0 §2.1 < 0.1)`).toBeLessThan(CLS_HARD_MAX);
    // LCP is observed (not gated); assert it is a finite number was measured.
    expect(Number.isFinite(lcp)).toBe(true);
  });
}
