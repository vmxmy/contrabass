import React from "react";
import { createRoute } from "@tanstack/react-router";
import { Text } from "@cloudflare/kumo/components/text";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { adminTeamsRoute } from "./route";
import { AdminBreadcrumbs } from "../navigation";
import { useAdminTeams } from "../../../hooks/use-admin-teams";

export const adminTeamsTeamIdRoute = createRoute({
  getParentRoute: () => adminTeamsRoute,
  path: "/$teamId",
  component: AdminTeamDetailPage,
});

function AdminTeamDetailPage() {
  const { teamId } = adminTeamsTeamIdRoute.useParams();
  const { data } = useAdminTeams();
  const team = data?.teams.find((item) => item.id === teamId || item.alias === teamId);
  const teamDisplay = team?.alias ?? team?.id ?? teamId;

  return (
    <section className="space-y-6" aria-label={t`团队详情`}>
      <AdminBreadcrumbs segments={[
        { label: <Trans>团队</Trans>, href: "/admin/teams" },
        { label: teamDisplay },
      ]} />
      <div className="py-8 text-center text-kumo-subtle">
        <Text variant="secondary" as="p"><Trans>团队详情页</Trans>（{teamDisplay}）— <Trans>待实现</Trans></Text>
      </div>
    </section>
  );
}
