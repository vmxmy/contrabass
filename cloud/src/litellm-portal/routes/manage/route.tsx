import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { rootRoute } from "../__root";

export const manageRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/manage",
  component: lazyRouteComponent(() => import("./route.lazy"), "ManageLayout"),
});
