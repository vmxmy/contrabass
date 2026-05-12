import React from "react";
import { createRoute } from "@tanstack/react-router";
import { adminRoute } from "../route";
import { AdminSection } from "../../../app";

export const adminUsageRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/usage",
  component: AdminUsagePage,
});

function AdminUsagePage() {
  return <AdminSection role="admin" />;
}
