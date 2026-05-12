import React from "react";
import { createRoute, Outlet } from "@tanstack/react-router";
import { adminRoute } from "../route";

export const adminTeamsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/teams",
  component: () => <Outlet />,
});
