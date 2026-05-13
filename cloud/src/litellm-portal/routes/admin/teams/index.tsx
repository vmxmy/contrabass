import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { adminTeamsRoute } from "./route";

export const adminTeamsIndexRoute = createRoute({
  getParentRoute: () => adminTeamsRoute,
  path: "/",
  component: lazyRouteComponent(() => import("./index.lazy"), "AdminTeamsPage"),
});
