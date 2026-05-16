import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { manageTeamsRoute } from "./route";

export const manageTeamsTeamIdRoute = createRoute({
  getParentRoute: () => manageTeamsRoute,
  path: "/$teamId",
  component: lazyRouteComponent(() => import("./$teamId.lazy"), "ManageTeamDetailPage"),
});
