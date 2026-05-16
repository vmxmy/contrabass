/**
 * Client-side hydration entry point for the LiteLLM portal.
 *
 * This module is the Vite entry (`src/litellm-portal/client.tsx`) — it runs
 * only in the browser.  The Worker SSR path imports `app.tsx` directly; this
 * file is NOT imported by the Worker bundle.
 */
import { I18nProvider } from "@lingui/react";
import { detectLocale, setupI18n } from "./i18n/setup";
import type { InitialDashboardData } from "./app";
import type { UserPreferences } from "./schemas";

type PortalRole = "admin" | "user" | "none";

// react-dom/client is CJS; under esbuild `splitting:true` a dynamic import of
// a CJS module resolves to a default-wrapped namespace (no named exports), so
// `{ hydrateRoot }` destructuring yields undefined. Unwrap the CJS default.
const interopDefault = <T,>(mod: T): T => (mod as { default?: T }).default ?? mod;

let initialData: InitialDashboardData | null = null;
let dehydratedState: unknown = undefined;
const dataEl = document.getElementById("initial-data");
if (dataEl && dataEl.textContent) {
  try {
    const parsed = JSON.parse(dataEl.textContent) as InitialDashboardData & { queryClient?: unknown };
    dehydratedState = parsed.queryClient;
    const { queryClient: _qc, ...rest } = parsed;
    void _qc;
    initialData = rest as InitialDashboardData;
  } catch {
    // malformed JSON — start with no data
  }
}

const roleRaw = initialData?.role;
const role: PortalRole | undefined =
  roleRaw === "admin" || roleRaw === "user" || roleRaw === "none" ? roleRaw : undefined;

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
const title = document.title;
// initialTheme: read from documentElement.dataset.mode set by foucScript.
// Cast is safe: foucScript only ever writes "dark" | "light".
const modeAttr = document.documentElement.dataset.mode;
const initialTheme: UserPreferences["theme"] =
  modeAttr === "dark" || modeAttr === "light" ? modeAttr : "auto";

Promise.all([
  import("react-dom/client").then(interopDefault),
  import("@tanstack/react-router"),
  import("./router"),
  import("./routes/__root"),
  import("./shell"),
]).then(async ([{ hydrateRoot }, { RouterProvider }, { createPortalRouter, createBrowserHistory }, { AppShell }, { Shell }]) => {
  const history = createBrowserHistory();
  const router = createPortalRouter(history, { role });

  // The server resolves matches (await router.load()) before renderToString,
  // so the SSR HTML contains the matched route subtree. The client MUST do
  // the same before hydrateRoot, otherwise its first render is the router's
  // `<Suspense fallback={null}>` (null) while the server rendered the
  // resolved <main> — a server/client first-render divergence (React #418,
  // full client re-render).
  await router.load();

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
        nonce=""
        initialData={null}
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
