import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { manageUsersRoute } from "./route";

export const manageUsersIndexRoute = createRoute({
  getParentRoute: () => manageUsersRoute,
  path: "/",
  component: lazyRouteComponent(() => import("./index.lazy"), "ManageUsersPage"),
});
