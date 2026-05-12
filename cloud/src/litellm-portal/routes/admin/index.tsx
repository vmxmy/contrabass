import React from "react";
import { createRoute } from "@tanstack/react-router";
import { adminRoute } from "./route";
import { AdminSection } from "../../app";

export const adminIndexRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/",
  component: AdminOverview,
});

function AdminOverview() {
  // AdminSection renders the 4 admin cards (AdminHeroStats, AdminGlobalUsage,
  // AdminUsersTable, AdminTeamsTable, AdminAuditFeed).  The role guard in the
  // parent adminRoute already ensures only admins reach this component, so we
  // can pass "admin" directly.
  return <AdminSection role="admin" />;
}
