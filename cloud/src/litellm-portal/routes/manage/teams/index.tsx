import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { manageTeamsRoute } from "./route";

export const manageTeamsIndexRoute = createRoute({
  getParentRoute: () => manageTeamsRoute,
  path: "/",
  component: lazyRouteComponent(() => import("./index.lazy"), "ManageTeamsPage"),
});
