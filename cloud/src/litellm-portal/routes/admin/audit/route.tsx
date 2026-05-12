import React from "react";
import { createRoute, Outlet } from "@tanstack/react-router";
import { adminRoute } from "../route";

export const adminAuditRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/audit",
  component: () => <Outlet />,
});
