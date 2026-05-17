// @vitest-environment happy-dom

/**
 * Hydration regression guard (React #418).
 *
 * Reproduces the production incident on https://zhiyun.ziikoo.com: the SSR
 * markup and the client's first (hydration) render diverge, so React 19
 * discards the server tree and warns ("Hydration failed..." / "did not
 * match...", with the offending element). In production React is minified so
 * the only signal is the opaque #418 code. Vitest uses the React
 * **development** build, so the assertion failure names the exact element.
 *
 * This file is the permanent guard: it asserts ZERO hydration errors. The
 * absence of such a test is why two #418 incidents shipped.
 */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@lingui/react";
import { RouterProvider } from "@tanstack/react-router";
import { QueryClient } from "@tanstack/react-query";
import { renderPortalSSR } from "./server-impl";
import { AppShell } from "./routes/__root";
import { Shell } from "./shell";
import { readClientHydrationState } from "./client-hydration-state";
import { createPortalRouter, createBrowserHistory } from "./router";
import { detectLocale, setupI18n } from "./i18n/setup";
import type { LiteLLMPortalEnv, PortalIdentity } from "./types";

// React.act requires this flag to be set in non-RTL test environments;
// without it React logs a noisy (non-hydration) console.error on every
// update. Setting it keeps the captured console output limited to real
// hydration diagnostics.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type PortalRole = "admin" | "user" | "none";

function makeEnv(): LiteLLMPortalEnv {
  return { LITELLM_PORTAL_COMPANY_NAME: "gz-zhiyun" };
}

function makeIdentity(role: PortalRole): PortalIdentity {
  return {
    email: "operator@gz-zhiyun.com",
    userId: "u_operator",
    domain: "gz-zhiyun.com",
    litellmUserId: "litellm_operator",
    role,
    tenantRole: null,
    tenantTeamId: null,
  };
}

/**
 * Mirror the real client bootstrap (client.tsx): parse the #initial-data
 * script the server emitted, build a browser router, and hydrate the existing
 * document WITHOUT a seeded query client — the client only has the
 * dehydrated state, exactly the production client condition.
 */
type ReactRoot = { unmount: () => void };
let activeRoot: ReactRoot | null = null;

async function hydrateLikeClient(path?: string): Promise<void> {
  const { hydrateRoot } = await import("react-dom/client");
  const { title, nonce, shellInitialData, dehydratedState, role, initialTheme } = readClientHydrationState(document);

  const ssrLocale = document.documentElement.lang || null;
  const locale = detectLocale(ssrLocale);
  const i18n = setupI18n(locale);

  // Production parity: client.tsx builds the router from createBrowserHistory()
  // which reads window.location — and in a real browser the address bar IS the
  // SSR-rendered path (the server rendered that path via createMemoryHistory).
  // loadSsrDocument's document.write does NOT change happy-dom's location, so
  // for non-"/" SSR paths the harness must set the URL to the same path the
  // server rendered, or createBrowserHistory() resolves "/" while the server
  // rendered e.g. /usage → a HARNESS-only route-subtree divergence that is not
  // a production bug. The 7 existing "/" cases pass undefined and are
  // unchanged. This keeps the SSR-string-vs-hydrate harness intact (it is NOT
  // a client-only router mount — renderPortalSSR→loadSsrDocument→hydrateRoot
  // with console-error capture is preserved).
  if (path != null) window.history.replaceState(null, "", path);

  const history = createBrowserHistory();
  const router = createPortalRouter(history, { role });

  // Fresh QueryClient per case. Production's client bootstrap (client.tsx)
  // uses a module-level QueryClient singleton — correct for a browser, where
  // one page load == one client that starts EMPTY and is then populated by
  // <HydrationBoundary state={dehydratedState}>. This single test process
  // runs many "page loads" against that one singleton, so without a fresh
  // client per case the previous case's seeded ME_QUERY_KEY (its company
  // name) leaks into the next case's first render — e.g. the unauthenticated
  // case, whose SSR DOM has NO me, would hydrate against a stale me.company
  // and report a spurious #418. A fresh empty client + the same
  // HydrationBoundary is exactly the production first-load condition, per
  // case, so the parity assertion stays faithful while cases stay isolated.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: 60_000, refetchOnWindowFocus: false } },
  });

  // Mirror the fixed client bootstrap: resolve matches before hydrateRoot so
  // the client's first render matches the server's resolved subtree (React #418
  // root cause 1: without this the router renders Suspense null vs server <main>).
  await router.load();

  // Mirror the Phase-3 client.tsx Step-5(b) fail-soft warm-up VERBATIM
  // (NEW-C-A + MAJOR-1). client.tsx does exactly this try/catch after its
  // `await router.load()`; the harness must match or it tests a path that is
  // not production.
  try {
    const { warmUsageCharts } = await import("./dashboard/views/usage-charts-lazy");
    await warmUsageCharts();
  } catch {
    // Swallow — proceed to hydrate (mirrors client.tsx MAJOR-1).
  }

  // Hydrate document (not #root) with the full tree including Shell — mirrors
  // client.tsx. Shell adds one component depth level; without it every useId
  // in Base UI components is shifted by one level vs the server → id attribute
  // mismatches (React #418 root cause 2).
  await React.act(async () => {
    activeRoot = hydrateRoot(
      document,
      <I18nProvider i18n={i18n}>
        <Shell
          title={title}
          nonce={nonce}
          initialData={shellInitialData}
          initialTheme={initialTheme}
          locale={locale}
        >
          <AppShell dehydratedState={dehydratedState} queryClient={queryClient}>
            <RouterProvider router={router} />
          </AppShell>
        </Shell>
      </I18nProvider>,
    ) as ReactRoot;
  });
  // Flush post-hydration effects.
  await new Promise((r) => setTimeout(r, 50));
}

/**
 * Replace the live document with the SSR HTML without going through
 * documentElement.innerHTML (which would discard <html>/<head> and the
 * useId-bearing markup). Parsing the doctype+html string and adopting it
 * preserves the exact server DOM that hydrateRoot must match.
 */
async function loadSsrDocument(html: string): Promise<void> {
  // Detach the previous case's hydrated root before adopting the next SSR
  // document so its post-hydration effects/router microtasks cannot fire
  // against the new DOM. (QueryClient isolation between cases is handled by
  // the per-case client in hydrateLikeClient — the production singleton is
  // shared process-wide here, which is correct for one browser but not for a
  // multi-"page-load" test process.)
  if (activeRoot) {
    await React.act(async () => {
      activeRoot?.unmount();
    });
    activeRoot = null;
  }

  const body = html.slice(html.indexOf("<html"));
  document.open();
  document.write(body);
  document.close();
}

describe("litellm-portal SSR hydration (#418 guard)", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  const captured: string[] = [];

  beforeEach(() => {
    captured.length = 0;
    const sink = (...args: unknown[]) => {
      captured.push(
        args.map((a) => (a instanceof Error ? `${a.message}` : String(a))).join(" "),
      );
    };
    errorSpy = vi.spyOn(console, "error").mockImplementation(sink);
    warnSpy = vi.spyOn(console, "warn").mockImplementation(sink);
  });

  afterEach(() => {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("client bootstrap reuses the server Shell head payload", async () => {
    const html = await renderPortalSSR(
      makeEnv(),
      makeIdentity("admin"),
      { role: "admin" } as unknown as Parameters<typeof renderPortalSSR>[2],
      "test-nonce",
      "http://localhost/",
      "zh-CN",
    );
    await loadSsrDocument(html);

    // The FOUC script may have resolved auto -> dark/light before hydration, but
    // the client Shell must still render the original server theme ("auto") so
    // the inline script text matches during hydration.
    document.documentElement.dataset.mode = "dark";
    const state = readClientHydrationState(document);

    expect(state.nonce).toBe("test-nonce");
    expect(state.initialTheme).toBe("auto");
    expect(state.shellInitialData).not.toBeNull();
    expect(state.shellInitialData).toHaveProperty("queryClient");
    expect(state.initialData).not.toHaveProperty("queryClient");
    expect(state.role).toBe("admin");
  });

  for (const role of ["user", "admin"] as const) {
    it(`server and client first render are identical for role=${role}`, async () => {
      const env = makeEnv();
      const identity = makeIdentity(role);
      const initialData = { role } as unknown as Parameters<typeof renderPortalSSR>[2];

      const html = await renderPortalSSR(
        env,
        identity,
        initialData,
        "test-nonce",
        "http://localhost/",
        "zh-CN",
      );
      expect(html).toContain("<!doctype html>");

      await loadSsrDocument(html);
      await hydrateLikeClient();

      const hydrationErrors = captured.filter(
        (m) =>
          /hydrat/i.test(m) ||
          /did not match/i.test(m) ||
          /server rendered|client/i.test(m) && /server/i.test(m) ||
          /Text content does not match/i.test(m),
      );

      if (hydrationErrors.length > 0) {
        require("node:fs").writeFileSync(
          `/tmp/h2-${role}.txt`,
          hydrationErrors.join("\n--- next ---\n"),
        );
        throw new Error(
          `React hydration mismatch (#418) for role=${role}:\n\n` +
            hydrationErrors.join("\n--- next ---\n"),
        );
      }
      expect(hydrationErrors).toEqual([]);
    });
  }

  /**
   * Phase 1 Task 1w shipped a new `/` host branch: `PortalIndex` selects
   * `TenantPortalShell` (tenant_admin 6-item nav / member 3-item nav /
   * pure-Owner Phase-2 notice) vs the legacy `UserView` from the hydrated
   * `useMe()`. The pre-Task-1w role loop above only exercised the
   * makeIdentity (null tenant fields) Owner/member-by-default branches; the
   * shell variants and the unauthenticated→UserView path were NOT hydrate-
   * tested. These cases extend the SAME SSR→hydrateRoot harness so a markup
   * divergence in ANY of the four Task-1w `/` branches fails the #418 guard.
   */
  const TASK_1W_CASES: ReadonlyArray<{
    name: string;
    identity: PortalIdentity;
    initialData: Parameters<typeof renderPortalSSR>[2];
  }> = [
    {
      name: "tenant_admin full-nav shell at /",
      identity: {
        email: "a@x.com",
        userId: "u1",
        domain: "x.com",
        litellmUserId: "u1",
        role: "user",
        tenantRole: "tenant_admin",
        tenantTeamId: "t1",
      },
      initialData: { role: "user" } as unknown as Parameters<typeof renderPortalSSR>[2],
    },
    {
      name: "member 3-item-nav shell at /",
      identity: {
        email: "m@x.com",
        userId: "u2",
        domain: "x.com",
        litellmUserId: "u2",
        role: "user",
        tenantRole: "member",
        tenantTeamId: "t1",
      },
      initialData: { role: "user" } as unknown as Parameters<typeof renderPortalSSR>[2],
    },
    {
      name: "pure-Owner Phase-2 notice at /",
      identity: {
        email: "owner@x.com",
        userId: "u3",
        domain: "x.com",
        litellmUserId: "u3",
        role: "admin",
        tenantRole: null,
        tenantTeamId: null,
      },
      initialData: { role: "admin" } as unknown as Parameters<typeof renderPortalSSR>[2],
    },
    {
      // Mirrors the index.ts unauthenticated request path exactly: empty
      // identity + null initialData. server-impl.tsx skips seeding
      // ME_QUERY_KEY (dataWithIdentity is null), so useMe() resolves
      // undefined on BOTH server and client → PortalIndex renders legacy
      // UserView (#usage-panel-root) on both sides.
      name: "unauthenticated → legacy UserView at /",
      identity: {
        email: "",
        userId: "",
        domain: "",
        litellmUserId: "",
        role: "none",
        tenantRole: null,
        tenantTeamId: null,
      },
      initialData: null,
    },
  ];

  for (const tc of TASK_1W_CASES) {
    it(`server and client first render are identical: ${tc.name}`, async () => {
      const html = await renderPortalSSR(
        makeEnv(),
        tc.identity,
        tc.initialData,
        "test-nonce",
        "http://localhost/",
        "zh-CN",
      );
      expect(html).toContain("<!doctype html>");

      await loadSsrDocument(html);
      await hydrateLikeClient();

      const hydrationErrors = captured.filter(
        (m) =>
          /hydrat/i.test(m) ||
          /did not match/i.test(m) ||
          /server rendered|client/i.test(m) && /server/i.test(m) ||
          /Text content does not match/i.test(m),
      );

      if (hydrationErrors.length > 0) {
        require("node:fs").writeFileSync(
          `/tmp/h2-task1w-${tc.name.replace(/\W+/g, "-")}.txt`,
          hydrationErrors.join("\n--- next ---\n"),
        );
        throw new Error(
          `React hydration mismatch (#418) for "${tc.name}":\n\n` +
            hydrationErrors.join("\n--- next ---\n"),
        );
      }
      expect(hydrationErrors).toEqual([]);
    });
  }

  /**
   * Phase-3 §A.3 (NEW-C-A, verified Open-Question (b)): the new UsageDashboard's
   * useDashboard key is UNSEEDED at SSR (server-impl.tsx seeds the OLD
   * hooks/use-dashboard ["dashboard"] key + DashboardSchema; the new
   * dashboard/use-dashboard key ["dashboard","self","","30d"] +
   * DashboardResponseSchema is different). So renderPortalSSR("/usage")
   * renders the loading placeholder (加载中…), NOT <TrendChart>; the client
   * first-hydrate render renders the SAME loading placeholder (same unseeded
   * key) → server == client → NO #418 from the lazy boundary by construction.
   * These cases PROVE that parity (no hydration mismatch) and PIN the verified
   * real behavior (SSR has the loading marker, NOT data-chart="trend") so a
   * future regression that SSR-resolves the chart without warm-up flips the
   * pin and the NEGATIVE-CONTROL case below would then catch the #418.
   */
  const USAGE_LAZY_PARITY_CASES: ReadonlyArray<{
    name: string;
    identity: PortalIdentity;
    initialData: Parameters<typeof renderPortalSSR>[2];
    url: string;
    loadingMarker: string;
  }> = [
    {
      name: "tenant_admin /usage (lazy chart chain) SSR==hydrate, both loading",
      identity: {
        email: "a@x.com", userId: "u1", domain: "x.com", litellmUserId: "u1",
        role: "user", tenantRole: "tenant_admin", tenantTeamId: "t1",
      },
      initialData: { role: "user" } as unknown as Parameters<typeof renderPortalSSR>[2],
      url: "http://localhost/usage",
      // Verified-real SSR (Open-Question (b), confirmed via TDD against the
      // production renderPortalSSR): /usage resolves its route component
      // server-side, UsageDashboard mounts and renders its OWN loading state
      // `<DashboardStatus>加载中…</>` because the new dashboard/use-dashboard
      // query key is UNSEEDED at SSR (server-impl.tsx seeds only the OLD
      // hooks/use-dashboard ["dashboard"] key). It renders the loading <p>,
      // NOT <TrendChart>, and never enters the lazy Suspense boundary →
      // server == client == loading → no #418 by construction.
      loadingMarker: "加载中…",
    },
    {
      name: "owner /ops/usage (global lazy chart chain) SSR==hydrate, both loading",
      identity: {
        email: "o@x.com", userId: "u2", domain: "x.com", litellmUserId: "u2",
        role: "admin", tenantRole: null, tenantTeamId: null,
      },
      initialData: { role: "admin" } as unknown as Parameters<typeof renderPortalSSR>[2],
      url: "http://localhost/ops/usage",
      // TDD run-fail discovery (Task-3): for /ops/usage the OPS route
      // component IS resolved server-side, so UsageDashboard mounts SSR and
      // renders its OWN loading state — `<DashboardStatus>加载中…</>` — because
      // the new dashboard/use-dashboard query key is UNSEEDED at SSR (exactly
      // Open-Question (b)). It renders the loading <p>, NOT <TrendChart>, and
      // never enters the lazy Suspense boundary. (Distinct from /usage, whose
      // tenant SCREEN route component is itself lazy-unresolved server-side —
      // both are loading states; both prove no #418 by construction.)
      loadingMarker: "加载中…",
    },
  ];

  for (const tc of USAGE_LAZY_PARITY_CASES) {
    it(`server and client first render are identical (both loading): ${tc.name}`, async () => {
      const html = await renderPortalSSR(
        makeEnv(), tc.identity, tc.initialData, "test-nonce", tc.url, "zh-CN",
      );
      expect(html).toContain("<!doctype html>");
      // Verified real SSR behavior: a loading state is rendered server-side.
      // TenantUsageScreen / OpsGlobalUsageScreen are STATIC imports (no lazy
      // screen at the route level); the screen DOES mount SSR. UsageDashboard
      // renders `加载中…` because the new dashboard/use-dashboard key
      // ["dashboard","self","","30d"] is UNSEEDED at SSR (server-impl.tsx
      // seeds only the old flat ["dashboard"] key) → loading branch taken,
      // lazy chart boundary never entered. Pin BOTH directions so a future
      // regression that SSR-resolves the chart flips these and is caught (here
      // + by the negative control).
      expect(html).toContain(tc.loadingMarker);
      expect(html).not.toContain('data-chart="trend"');
      expect(html).not.toContain("data-panel-skeleton");

      await loadSsrDocument(html);
      await hydrateLikeClient(new URL(tc.url).pathname);

      const hydrationErrors = captured.filter(
        (m) =>
          /hydrat/i.test(m) ||
          /did not match/i.test(m) ||
          (/server rendered|client/i.test(m) && /server/i.test(m)) ||
          /Text content does not match/i.test(m),
      );
      if (hydrationErrors.length > 0) {
        throw new Error(
          `React hydration mismatch (#418) for "${tc.name}":\n\n` +
            hydrationErrors.join("\n--- next ---\n"),
        );
      }
      expect(hydrationErrors).toEqual([]);
    });
  }

  /**
   * NEGATIVE CONTROL (CRITICAL-1 (ii)) — proves the harness is non-blind
   * (detection power). The injected mismatch is produced by the CLIENT-SEEDED
   * dashboard query (`queryClient.setQueryData(DASHBOARD_QUERY_KEY, fixture)`)
   * vs the UNSEEDED SSR loading state — i.e. the construction itself. SSR
   * renders `加载中…` (new dashboard key unseeded, as proven by the parity
   * cases above); the client QueryClient is pre-seeded with a
   * DashboardResponseSchema-valid available:true fixture BEFORE hydrateRoot →
   * client first-renders the resolved chart → React #418 mismatch detected.
   * `warmUsageCharts` is NOT what drives this mismatch: it only affects whether
   * the seeded chart renders synchronously vs via a transient Suspense
   * re-render; BOTH paths diverge from SSR `加载中…`. Empirically verified by
   * fault-injection: neutralising warm-up → control still passes; neutralising
   * the client seed → control fails. This proves the harness's detection power
   * / non-blindness (consistent with OQ-(b)): the real `/usage` path is
   * #418-safe by construction; `warmUsageCharts` is defense-in-depth + UX,
   * NOT what prevents #418 today. NOT that production has this bug — this is a
   * controlled fault-injection that must be observable.
   */
  it("negative control: a client-only resolved chart vs SSR loading IS detected as a #418", async () => {
    const identity: PortalIdentity = {
      email: "a@x.com", userId: "u1", domain: "x.com", litellmUserId: "u1",
      role: "user", tenantRole: "tenant_admin", tenantTeamId: "t1",
    };
    // NOTE (Task-3 TDD fix): the verbatim plan block swapped the identity /
    // initialData args here vs the parity cases (which use the canonical
    // renderPortalSSR(env, identity, initialData, …) order). The swap left
    // the SSR `["me"]` query unseeded so TenantLayout rendered its
    // me===undefined `tenant-portal-loading-root` branch instead of the
    // dashboard's `加载中…`, making the desync (resolved chart vs loading)
    // unreproducible and the control vacuous. Use the canonical arg order
    // (matching USAGE_LAZY_PARITY_CASES exactly) so SSR seeds `me`, resolves
    // TenantLayout, and renders UsageDashboard's own `加载中…` loading state —
    // the precise state the seeded-client chart must then diverge from.
    const html = await renderPortalSSR(
      makeEnv(),
      identity,
      { role: "user" } as unknown as Parameters<typeof renderPortalSSR>[2],
      "test-nonce",
      "http://localhost/usage",
      "zh-CN",
    );
    // SSR renders a loading state for /usage (UsageDashboard's own `加载中…`
    // because the new dashboard key is unseeded server-side — Open-Q (b)),
    // NOT the resolved chart.
    expect(html).toContain("加载中…");
    expect(html).not.toContain('data-chart="trend"');

    await loadSsrDocument(html);

    /**
     * hydrateLikeClient PLUS a pre-hydrate
     * `qc.setQueryData(DASHBOARD_QUERY_KEY({kind:"self"},"30d"), fixture)`.
     * Returns whether a #418 mismatch was captured (same filter as the
     * positive cases). Keeps the production try/catch warm-up mirror.
     */
    async function hydrateAndCaptureMismatch_withSeededDashboard(): Promise<boolean> {
      const { hydrateRoot } = await import("react-dom/client");
      const { title, nonce, shellInitialData, dehydratedState, role, initialTheme } =
        readClientHydrationState(document);

      const ssrLocale = document.documentElement.lang || null;
      const locale = detectLocale(ssrLocale);
      const i18n = setupI18n(locale);

      // Same production-parity URL set as hydrateLikeClient: the server
      // rendered /usage, so the client router must resolve /usage too — the
      // ONLY intended desync here is the seeded resolved-chart vs the SSR
      // loading state, NOT a route-subtree divergence.
      window.history.replaceState(null, "", "/usage");

      const history = createBrowserHistory();
      const router = createPortalRouter(history, { role });

      const queryClient = new QueryClient({
        defaultOptions: { queries: { staleTime: 60_000, refetchOnWindowFocus: false } },
      });

      const { DASHBOARD_QUERY_KEY } = await import("./dashboard/use-dashboard");
      const { DashboardResponseSchema } = await import("./dashboard/dashboard-schemas");
      const fixture = DashboardResponseSchema.parse({
        available: true,
        empty: false,
        scope: "self",
        window: "30d",
        grain: "day",
        grainFallback: false,
        timezone: "Asia/Shanghai",
        kpi: {
          spend: { current: 12.5, previous: 10, deltaPct: 25 },
          requests: { current: 100, previous: 80, deltaPct: 25 },
          totalTokens: { current: 5000, previous: 4000, deltaPct: 25 },
        },
        trend: [
          { startMs: 1_715_000_000_000, label: "D1", totalTokens: 1000, requests: 20, spend: 2.5 },
          { startMs: 1_715_086_400_000, label: "D2", totalTokens: 1500, requests: 30, spend: 3.5 },
        ],
        models: [
          { model: "gpt-4o", spend: 8, totalTokens: 3000, requests: 60 },
        ],
      });
      queryClient.setQueryData(DASHBOARD_QUERY_KEY({ kind: "self" }, "30d"), fixture);

      await router.load();

      // Mirror the production fail-soft warm-up VERBATIM (so this variant
      // differs from hydrateLikeClient ONLY by the seeded query key).
      try {
        const { warmUsageCharts } = await import("./dashboard/views/usage-charts-lazy");
        await warmUsageCharts();
      } catch {
        // Swallow — proceed to hydrate (mirrors client.tsx MAJOR-1).
      }

      await React.act(async () => {
        activeRoot = hydrateRoot(
          document,
          <I18nProvider i18n={i18n}>
            <Shell
              title={title}
              nonce={nonce}
              initialData={shellInitialData}
              initialTheme={initialTheme}
              locale={locale}
            >
              <AppShell dehydratedState={dehydratedState} queryClient={queryClient}>
                <RouterProvider router={router} />
              </AppShell>
            </Shell>
          </I18nProvider>,
        ) as ReactRoot;
      });
      await new Promise((r) => setTimeout(r, 50));

      return captured.some(
        (m) =>
          /hydrat/i.test(m) ||
          /did not match/i.test(m) ||
          (/server rendered|client/i.test(m) && /server/i.test(m)) ||
          /Text content does not match/i.test(m),
      );
    }

    // Seed the NEW dashboard/use-dashboard key so the client first render
    // resolves the chart. This client seed is what drives the mismatch (the
    // construction): SSR is unseeded → `加载中…`; client is seeded → resolved
    // chart → divergence → #418. The fixture is DashboardResponseSchema.parse-d
    // so it cannot drift from the real consumer contract (dashboard-schemas.ts).
    // Injected via a hydrateLikeClient variant that pre-seeds the per-case
    // QueryClient with that key BEFORE the warm-up + hydrateRoot (the
    // try/catch warm-up mirror is preserved — production parity). Note:
    // warm-up only affects sync vs async chart render; both diverge from SSR.
    const sawMismatch = await hydrateAndCaptureMismatch_withSeededDashboard();
    expect(sawMismatch).toBe(true); // the harness CAN observe a real #418
  });
});
