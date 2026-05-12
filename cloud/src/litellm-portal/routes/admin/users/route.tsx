import React from "react";
import { createRoute, Outlet } from "@tanstack/react-router";
import { adminRoute } from "../route";

export const adminUsersRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/users",
  component: () => <Outlet />,
});
