import React from "react";
import { createRoute } from "@tanstack/react-router";
import { adminAuditRoute } from "./route";

export const adminAuditEventIdRoute = createRoute({
  getParentRoute: () => adminAuditRoute,
  path: "/$eventId",
  component: AdminAuditEventPage,
});

function AdminAuditEventPage() {
  const { eventId } = adminAuditEventIdRoute.useParams();
  return (
    <div className="py-8 text-center text-kumo-subtle">
      审计事件详情（{eventId}）— 待实现
    </div>
  );
}
