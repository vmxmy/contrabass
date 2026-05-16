import React from "react";
import { createRoute, Outlet } from "@tanstack/react-router";
import { manageRoute } from "../route";
import { requireAdminRoute } from "../admin-guard";

export const manageAuditRoute = createRoute({
  getParentRoute: () => manageRoute,
  path: "/audit",
  beforeLoad: ({ context }) => requireAdminRoute(context),
  component: () => <Outlet />,
});
