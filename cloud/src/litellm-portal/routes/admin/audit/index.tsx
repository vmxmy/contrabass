import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { adminAuditRoute } from "./route";

export const adminAuditIndexRoute = createRoute({
  getParentRoute: () => adminAuditRoute,
  path: "/",
  component: lazyRouteComponent(() => import("./index.lazy"), "AdminAuditPage"),
});
