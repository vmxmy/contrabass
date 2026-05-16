import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { manageAuditRoute } from "./route";

export const manageAuditEventIdRoute = createRoute({
  getParentRoute: () => manageAuditRoute,
  path: "/$eventId",
  component: lazyRouteComponent(() => import("./$eventId.lazy"), "ManageAuditEventPage"),
});
