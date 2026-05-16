import React from "react";
import { createRoute, Outlet } from "@tanstack/react-router";
import { manageRoute } from "../route";
import { requireAdminRoute } from "../admin-guard";

export const manageUsersRoute = createRoute({
  getParentRoute: () => manageRoute,
  path: "/users",
  beforeLoad: ({ context }) => requireAdminRoute(context),
  component: () => <Outlet />,
});
