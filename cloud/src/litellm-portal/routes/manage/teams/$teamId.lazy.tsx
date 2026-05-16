import React from "react";
import { Text } from "@cloudflare/kumo/components/text";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useAdminTeams } from "../../../hooks/use-admin-teams";
import { manageTeamsTeamIdRoute } from "./$teamId";

export function ManageTeamDetailPage() {
  const { teamId } = manageTeamsTeamIdRoute.useParams();
  const { data } = useAdminTeams();
  const team = data?.teams.find((item) => item.id === teamId || item.alias === teamId);
  const teamDisplay = team?.alias ?? team?.id ?? teamId;

  return (
    <section className="space-y-6" aria-label={t`团队详情`}>
      <div className="py-8 text-center text-kumo-subtle">
        <Text variant="secondary" as="p"><Trans>团队详情页</Trans>（{teamDisplay}）— <Trans>待实现</Trans></Text>
      </div>
    </section>
  );
}
