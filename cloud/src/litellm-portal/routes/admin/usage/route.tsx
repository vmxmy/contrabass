import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { adminRoute } from "../route";

export const adminUsageRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/usage",
  component: lazyRouteComponent(() => import("./route.lazy"), "AdminUsagePage"),
});
