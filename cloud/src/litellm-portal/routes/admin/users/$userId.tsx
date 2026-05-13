import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { adminUsersRoute } from "./route";

export const adminUsersUserIdRoute = createRoute({
  getParentRoute: () => adminUsersRoute,
  path: "/$userId",
  component: lazyRouteComponent(() => import("./$userId.lazy"), "AdminUserDetailPage"),
});
