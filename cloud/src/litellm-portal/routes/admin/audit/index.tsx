import React from "react";
import { createRoute } from "@tanstack/react-router";
import { adminAuditRoute } from "./route";
import { AdminSection } from "../../../app";

export const adminAuditIndexRoute = createRoute({
  getParentRoute: () => adminAuditRoute,
  path: "/",
  component: AdminAuditPage,
});

function AdminAuditPage() {
  return <AdminSection role="admin" />;
}
