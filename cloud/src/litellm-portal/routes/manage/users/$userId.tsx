import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { manageUsersRoute } from "./route";

export const manageUsersUserIdRoute = createRoute({
  getParentRoute: () => manageUsersRoute,
  path: "/$userId",
  component: lazyRouteComponent(() => import("./$userId.lazy"), "ManageUserDetailPage"),
});
