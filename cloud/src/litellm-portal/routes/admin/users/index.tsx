import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { adminUsersRoute } from "./route";

export const adminUsersIndexRoute = createRoute({
  getParentRoute: () => adminUsersRoute,
  path: "/",
  component: lazyRouteComponent(() => import("./index.lazy"), "AdminUsersPage"),
});
