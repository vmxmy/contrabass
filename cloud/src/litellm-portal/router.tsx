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
  createRootRoute,
  createRoute,
  createMemoryHistory,
  createBrowserHistory,
  redirect,
} from "@tanstack/react-router";
import { rootRoute } from "./routes/__root";
import { indexRoute } from "./routes/index";
import { adminRoute } from "./routes/admin/route";
import { adminIndexRoute } from "./routes/admin/index";
import { adminUsersRoute } from "./routes/admin/users/route";
import { adminUsersIndexRoute } from "./routes/admin/users/index";
import { adminUsersUserIdRoute } from "./routes/admin/users/$userId";
import { adminTeamsRoute } from "./routes/admin/teams/route";
import { adminTeamsIndexRoute } from "./routes/admin/teams/index";
import { adminTeamsTeamIdRoute } from "./routes/admin/teams/$teamId";
import { adminAuditRoute } from "./routes/admin/audit/route";
import { adminAuditIndexRoute } from "./routes/admin/audit/index";
import { adminAuditEventIdRoute } from "./routes/admin/audit/$eventId";
import { adminUsageRoute } from "./routes/admin/usage/route";

// Wire up parent/child relationships using `addChildren`.
const routeTree = rootRoute.addChildren([
  indexRoute,
  adminRoute.addChildren([
    adminIndexRoute,
    adminUsersRoute.addChildren([
      adminUsersIndexRoute,
      adminUsersUserIdRoute,
    ]),
    adminTeamsRoute.addChildren([
      adminTeamsIndexRoute,
      adminTeamsTeamIdRoute,
    ]),
    adminAuditRoute.addChildren([
      adminAuditIndexRoute,
      adminAuditEventIdRoute,
    ]),
    adminUsageRoute,
  ]),
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
