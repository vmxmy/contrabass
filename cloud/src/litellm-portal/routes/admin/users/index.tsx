import React from "react";
import { createRoute } from "@tanstack/react-router";
import { adminUsersRoute } from "./route";
import { AdminSection } from "../../../app";

export const adminUsersIndexRoute = createRoute({
  getParentRoute: () => adminUsersRoute,
  path: "/",
  component: AdminUsersPage,
});

function AdminUsersPage() {
  // Reuses the full AdminSection for now; per tasks.md 2.5 this can be
  // extracted to a standalone AdminUsersTable page in a later change.
  return <AdminSection role="admin" />;
}
