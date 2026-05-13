/**
 * Admin layout route with role guard.
 *
 * Admin UI is loaded through TanStack Router's lazy route component so
 * non-admin/user-first sessions do not download the Sidebar chunk.
 */

import { createRoute, lazyRouteComponent, redirect } from "@tanstack/react-router";
import { rootRoute } from "../__root";

export const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin",
  beforeLoad: ({ context }) => {
    if (context.role !== "admin") {
      throw redirect({ to: "/", replace: true });
    }
  },
  component: lazyRouteComponent(() => import("./route.lazy"), "AdminLayout"),
});
