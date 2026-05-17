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
import { createTenantPortalRoutes, TENANT_ROUTE_SPECS } from "./tenant-portal/routes";

// Tenant Portal route subtree mounted at the top level. The factory's `/`
// overview spec is intentionally dropped here: `/` is already owned by
// `indexRoute`, which selects `TenantPortalShell` from the hydrated identity —
// mounting another `/` child under `rootRoute` would be a route-id collision.
// The remaining paths (`/usage|/keys|/members|/alerts|/billing`) live under
// `rootRoute`, so their full paths never overlap with the legacy `/manage/*`
// subtree (which keeps its own `manageRoute` parent and 301 behavior).
// `createTenantPortalRoutes` maps `TENANT_ROUTE_SPECS` in order, so we drop the
// entries whose spec path is "/" by the same index.
const tenantPortalRoutes = createTenantPortalRoutes(rootRoute).filter(
  (_route, i) => TENANT_ROUTE_SPECS[i].path !== "/",
);

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
  ...tenantPortalRoutes,
]);

export type RouterContext = {
  /** Resolved role, seeded by SSR identity; may be undefined before useMe resolves. */
  role?: "admin" | "user" | "none";
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
