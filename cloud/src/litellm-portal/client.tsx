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

type PortalRole = "admin" | "user" | "none";

const root = document.getElementById("root");
if (root) {
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
  const locale = detectLocale(navigator.languages?.join(",") ?? navigator.language ?? null);
  const i18n = setupI18n(locale);

  Promise.all([
    import("react-dom/client"),
    import("@tanstack/react-router"),
    import("./router"),
    import("./routes/__root"),
  ]).then(([{ hydrateRoot }, { RouterProvider }, { createPortalRouter, createBrowserHistory }, { AppShell }]) => {
    const history = createBrowserHistory();
    const router = createPortalRouter(history, { role });
    hydrateRoot(
      root,
      <I18nProvider i18n={i18n}>
        <AppShell dehydratedState={dehydratedState}>
          <RouterProvider router={router} />
        </AppShell>
      </I18nProvider>,
    );
  });
}
