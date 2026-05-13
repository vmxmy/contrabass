import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { adminRoute } from "./route";

export const adminIndexRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/",
  component: lazyRouteComponent(() => import("./index.lazy"), "AdminOverview"),
});
