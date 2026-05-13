import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { adminTeamsRoute } from "./route";

export const adminTeamsTeamIdRoute = createRoute({
  getParentRoute: () => adminTeamsRoute,
  path: "/$teamId",
  component: lazyRouteComponent(() => import("./$teamId.lazy"), "AdminTeamDetailPage"),
});
