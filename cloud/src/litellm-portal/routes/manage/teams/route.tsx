import React from "react";
import { createRoute, Outlet } from "@tanstack/react-router";
import { manageRoute } from "../route";
import { requireAdminRoute } from "../admin-guard";

export const manageTeamsRoute = createRoute({
  getParentRoute: () => manageRoute,
  path: "/teams",
  beforeLoad: ({ context }) => requireAdminRoute(context),
  component: () => <Outlet />,
});
