import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { adminAuditRoute } from "./route";

export const adminAuditEventIdRoute = createRoute({
  getParentRoute: () => adminAuditRoute,
  path: "/$eventId",
  component: lazyRouteComponent(() => import("./$eventId.lazy"), "AdminAuditEventPage"),
});
