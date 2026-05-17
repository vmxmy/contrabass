import React from "react";
import { useParams } from "@tanstack/react-router";
import { OpsTenantDetailBody } from "../../../ops-console/screens/tenant-detail";

export function ManageTeamDetailPage() {
  const { teamId } = useParams({ strict: false }) as { teamId?: string };

  return (
    <section className="space-y-6">
      <OpsTenantDetailBody teamId={teamId ?? ""} />
    </section>
  );
}
