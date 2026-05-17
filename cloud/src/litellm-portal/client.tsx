/**
 * Client-side hydration entry point for the LiteLLM portal.
 *
 * This module is the Vite entry (`src/litellm-portal/client.tsx`) — it runs
 * only in the browser.  The Worker SSR path imports `app.tsx` directly; this
 * file is NOT imported by the Worker bundle.
 */
import { I18nProvider } from "@lingui/react";
import { detectLocale, setupI18n } from "./i18n/setup";
import { readClientHydrationState } from "./client-hydration-state";

// react-dom/client is CJS; under esbuild `splitting:true` a dynamic import of
// a CJS module resolves to a default-wrapped namespace (no named exports), so
// `{ hydrateRoot }` destructuring yields undefined. Unwrap the CJS default.
const interopDefault = <T,>(mod: T): T => (mod as { default?: T }).default ?? mod;

const {
  title,
  nonce,
  shellInitialData,
  dehydratedState,
  role,
  initialTheme,
} = readClientHydrationState(document);

// Hydrate with the SAME locale the server rendered with (written into
// <html lang>). Re-detecting from navigator.languages here would diverge from
// the server's first render and trigger a hydration mismatch (React #418).
const ssrLocale = document.documentElement.lang || null;
const locale = detectLocale(ssrLocale ?? navigator.languages?.join(",") ?? navigator.language ?? null);
const i18n = setupI18n(locale);

// Read Shell props back from the already-rendered DOM so the client tree
// structure is byte-identical to the server tree. Shell is a pure React
// component with no browser-incompatible logic, so it is safe to render on
// the client. Crucially, including Shell in the client tree matches the server
// tree depth — React 19 useId encodes the component tree path as a bitfield,
// so a missing wrapper shifts every subsequent useId by one level, producing
// id attribute mismatches on every Base UI component (Switch, Tabs, Dialog,
// …) that calls useId internally → React #418.
Promise.all([
  import("react-dom/client").then(interopDefault),
  import("@tanstack/react-router"),
  import("./router"),
  import("./routes/__root"),
  import("./shell"),
  import("./dashboard/views/usage-charts-lazy"),
]).then(async ([{ hydrateRoot }, { RouterProvider }, { createPortalRouter, createBrowserHistory }, { AppShell }, { Shell }, { warmUsageCharts }]) => {
  const history = createBrowserHistory();
  const router = createPortalRouter(history, { role });

  // The server resolves matches (await router.load()) before renderToString,
  // so the SSR HTML contains the matched route subtree. The client MUST do
  // the same before hydrateRoot, otherwise its first render is the router's
  // `<Suspense fallback={null}>` (null) while the server rendered the
  // resolved <main> — a server/client first-render divergence (React #418,
  // full client re-render).
  await router.load();

  // Phase-3 §A.3 (NEW-C-A): warm the usage-charts dynamic chunk before
  // hydrateRoot. On the real SSR path the new UsageDashboard's useDashboard
  // key is unseeded (verified Open-Question (b)) so SSR == client == loading
  // state and there is NO #418 from the lazy boundary; this warm-up is
  // defense-in-depth (keeps client==server if a future change SSR-seeds the
  // new dashboard key → server would then render the resolved chart) plus a
  // post-hydration UX win (no skeleton flash when the dashboard query
  // resolves). MAJOR-1: MUST be fail-soft — a rejected chunk fetch (CDN blip,
  // post-redeploy chunk 404, cache evict) must NEVER prevent hydrateRoot;
  // worst case without it is a one-time chart-only client re-render, which is
  // strictly better than a global white screen on EVERY route (incl.
  // chart-less /ops/settings and login). Same pre-hydrate discipline as the
  // `await router.load()` above.
  try {
    await warmUsageCharts();
  } catch {
    // Swallow — proceed to hydrate. (See MAJOR-1 rationale above.)
  }

  // Hydrate the full document (not just #root) so the React tree root is
  // identical to the server's: <I18nProvider><Shell><AppShell>…
  // Shell adds one component-tree level; without it every useId call inside
  // Base UI components shifts by one depth level → id attribute mismatches
  // on Switch, Tabs, Dialog, etc → React #418.
  hydrateRoot(
    document,
    <I18nProvider i18n={i18n}>
      <Shell
        title={title}
        nonce={nonce}
        initialData={shellInitialData}
        initialTheme={initialTheme}
        locale={locale}
      >
        <AppShell dehydratedState={dehydratedState}>
          <RouterProvider router={router} />
        </AppShell>
      </Shell>
    </I18nProvider>,
  );
});
