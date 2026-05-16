import { createRoute, redirect } from "@tanstack/react-router";
import { manageRoute } from "./route";

export const manageIndexRoute = createRoute({
  getParentRoute: () => manageRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/manage/keys", replace: true });
  },
  component: () => null,
});
