/**
 * Admin layout route with role guard.
 *
 * `beforeLoad` runs before the route component mounts. It reads the resolved
 * role from the router context (seeded by SSR identity or the useMe query
 * that the parent layout fetches). Non-admin users are redirected to `/`
 * before any admin child component renders, which means no `/api/admin/*`
 * requests are ever issued by non-admin clients.
 *
 * Note on TanStack Router context timing: `context.role` is populated when
 * `createPortalRouter` is called with the identity resolved from auth middleware.
 * On the client, the context is seeded from the hydrated `__initial-data__` role
 * field, so the guard works without an extra network round-trip.
 */

import React from "react";
import { createRoute, Outlet, redirect } from "@tanstack/react-router";
import { rootRoute } from "../__root";

export const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin",
  beforeLoad: ({ context }) => {
    if (context.role !== "admin") {
      throw redirect({ to: "/", replace: true });
    }
  },
  component: AdminLayout,
});

function AdminLayout() {
  return <Outlet />;
}
