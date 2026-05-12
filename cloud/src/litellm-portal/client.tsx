/**
 * Client-side hydration entry point for the LiteLLM portal.
 *
 * This module is the Vite entry (`src/litellm-portal/client.tsx`) — it runs
 * only in the browser.  The Worker SSR path imports `app.tsx` directly; this
 * file is NOT imported by the Worker bundle.
 */
import { hydrateRoot } from "react-dom/client";
import { App, type InitialDashboardData } from "./app";

const root = document.getElementById("root");
if (root) {
  let initialData: InitialDashboardData | null = null;
  const dataEl = document.getElementById("initial-data");
  if (dataEl && dataEl.textContent) {
    try {
      initialData = JSON.parse(dataEl.textContent) as InitialDashboardData;
    } catch {
      // malformed JSON — start with no data
    }
  }
  const roleRaw = initialData?.role;
  const role: "admin" | "user" | "none" | undefined =
    roleRaw === "admin" || roleRaw === "user" || roleRaw === "none" ? roleRaw : undefined;
  hydrateRoot(root, <App initialData={initialData} role={role} />);
}
