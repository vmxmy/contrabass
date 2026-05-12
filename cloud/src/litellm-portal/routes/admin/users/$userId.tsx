import React from "react";
import { createRoute } from "@tanstack/react-router";
import { adminUsersRoute } from "./route";

export const adminUsersUserIdRoute = createRoute({
  getParentRoute: () => adminUsersRoute,
  path: "/$userId",
  component: AdminUserDetailPage,
});

function AdminUserDetailPage() {
  // Placeholder for user detail view — implemented in a follow-up change.
  const { userId } = adminUsersUserIdRoute.useParams();
  return (
    <div className="py-8 text-center text-kumo-subtle">
      用户详情页（{userId}）— 待实现
    </div>
  );
}
