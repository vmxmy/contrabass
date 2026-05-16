import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { manageAuditRoute } from "./route";

export const manageAuditIndexRoute = createRoute({
  getParentRoute: () => manageAuditRoute,
  path: "/",
  component: lazyRouteComponent(() => import("./index.lazy"), "ManageAuditPage"),
});
