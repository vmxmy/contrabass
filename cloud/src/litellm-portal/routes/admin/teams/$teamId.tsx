import React from "react";
import { createRoute } from "@tanstack/react-router";
import { adminTeamsRoute } from "./route";

export const adminTeamsTeamIdRoute = createRoute({
  getParentRoute: () => adminTeamsRoute,
  path: "/$teamId",
  component: AdminTeamDetailPage,
});

function AdminTeamDetailPage() {
  const { teamId } = adminTeamsTeamIdRoute.useParams();
  return (
    <div className="py-8 text-center text-kumo-subtle">
      团队详情页（{teamId}）— 待实现
    </div>
  );
}
