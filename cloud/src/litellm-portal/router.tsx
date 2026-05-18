/**
 * TanStack Router instance for the LiteLLM Portal.
 *
 * We use **code-based** route definition (no file-system codegen plugin) to
 * avoid adding a Vite plugin or a separate build step; esbuild bundles this
 * directly. This means we import every route module explicitly and call
 * `createRouter` once.
 *
 * SSR note: `createRouter` is called once per request on the server (via
 * `createMemoryHistory`) and once on the client (via `createBrowserHistory`).
 * Do NOT store mutable per-request state on the module-level router object —
 * always pass the router as a prop/argument.
 */

import {
  createRouter,
  createMemoryHistory,
  createBrowserHistory,
  redirect,
} from "@tanstack/react-router";
import { rootRoute } from "./routes/__root";
import { indexRoute } from "./routes/index";
import { manageRoute } from "./routes/manage/route";
import { manageIndexRoute } from "./routes/manage/index";
import { manageKeysRoute } from "./routes/manage/keys";
import { managePreferencesRoute } from "./routes/manage/preferences";
import { manageUsersRoute } from "./routes/manage/users/route";
import { manageUsersIndexRoute } from "./routes/manage/users/index";
import { manageUsersUserIdRoute } from "./routes/manage/users/$userId";
import { manageTeamsRoute } from "./routes/manage/teams/route";
import { manageTeamsIndexRoute } from "./routes/manage/teams/index";
import { manageTeamsTeamIdRoute } from "./routes/manage/teams/$teamId";
import { manageAuditRoute } from "./routes/manage/audit/route";
import { manageAuditIndexRoute } from "./routes/manage/audit/index";
import { manageAuditEventIdRoute } from "./routes/manage/audit/$eventId";
import { manageSettingsRoute } from "./routes/manage/settings";
import {
  legacyAdminAuditEventRoute,
  legacyAdminAuditRoute,
  legacyAdminRoute,
  legacyAdminSettingsRoute,
  legacyAdminTeamDetailRoute,
  legacyAdminTeamsRoute,
  legacyAdminUsageRoute,
  legacyAdminUserDetailRoute,
  legacyAdminUsersRoute,
  legacyPreferencesRoute,
} from "./routes/legacy/redirects";
import { createTenantPortalLayoutRoute } from "./tenant-portal/routes";
import { createOpsConsoleRoutes } from "./ops-console/routes";

// Tenant Portal subtree: a single pathless layout route (id-only, never
// matches a URL itself) whose `/usage|/keys|/members|/alerts|/billing`
// children own the tenant chrome via `TenantPortalShell`. The `/` exclusion
// is now structural inside the layout factory: `/` is already owned by
// `indexRoute` (which selects `TenantPortalShell` from the hydrated
// identity), so the layout owns ONLY the non-`/` subroutes and there is no
// route-id collision. Symmetric to `opsLayoutRoute` below.
const tenantLayoutRoute = createTenantPortalLayoutRoute(rootRoute);

// Operations Console subtree: a single pathless layout route (id-only, never
// matches a URL itself) whose `/ops*` children own the Owner-gated Ops chrome.
// `/ops*` paths never overlap `/`, `/manage/*`, or the tenant subtree, so the
// subtree mounts cleanly under `rootRoute` alongside them.
const opsLayoutRoute = createOpsConsoleRoutes(rootRoute);

// Wire up parent/child relationships using `addChildren`.
const routeTree = rootRoute.addChildren([
  indexRoute,
  manageRoute.addChildren([
    manageIndexRoute,
    manageKeysRoute,
    managePreferencesRoute,
    manageUsersRoute.addChildren([
      manageUsersIndexRoute,
      manageUsersUserIdRoute,
    ]),
    manageTeamsRoute.addChildren([
      manageTeamsIndexRoute,
      manageTeamsTeamIdRoute,
    ]),
    manageAuditRoute.addChildren([
      manageAuditIndexRoute,
      manageAuditEventIdRoute,
    ]),
    manageSettingsRoute,
  ]),
  legacyAdminRoute,
  legacyAdminUsageRoute,
  legacyAdminUsersRoute,
  legacyAdminUserDetailRoute,
  legacyAdminTeamsRoute,
  legacyAdminTeamDetailRoute,
  legacyAdminAuditRoute,
  legacyAdminAuditEventRoute,
  legacyAdminSettingsRoute,
  legacyPreferencesRoute,
  tenantLayoutRoute,
  opsLayoutRoute,
]);

export type RouterContext = {
  /** Resolved role, seeded by SSR identity; may be undefined before useMe resolves. */
  role?: "admin" | "admin_viewer" | "user" | "none";
};

/**
 * Create a new router instance bound to the given history.
 *
 * Call with `createBrowserHistory()` on the client and
 * `createMemoryHistory({ initialEntries: [url] })` on the server.
 */
export function createPortalRouter(
  history: ReturnType<typeof createMemoryHistory> | ReturnType<typeof createBrowserHistory>,
  context: RouterContext = {},
) {
  return createRouter({
    routeTree,
    history,
    context,
  });
}

// Re-export helpers so callers don't need to import from @tanstack/react-router directly.
export { createMemoryHistory, createBrowserHistory, redirect };
export type { RouterContext as PortalRouterContext };
