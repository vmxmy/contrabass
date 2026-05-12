import React from "react";
import { createRoute } from "@tanstack/react-router";
import { adminTeamsRoute } from "./route";
import { AdminSection } from "../../../app";

export const adminTeamsIndexRoute = createRoute({
  getParentRoute: () => adminTeamsRoute,
  path: "/",
  component: AdminTeamsPage,
});

function AdminTeamsPage() {
  return <AdminSection role="admin" />;
}
