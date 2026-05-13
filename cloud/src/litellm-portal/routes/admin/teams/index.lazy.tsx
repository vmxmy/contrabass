import React from "react";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { AdminCard, AdminTeamsTable } from "../../../admin-components";
import { AdminBreadcrumbs } from "../navigation";

export function AdminTeamsPage() {
  return (
    <section className="space-y-6" aria-label={t`团队管理`}>
      <AdminBreadcrumbs segments={[{ label: <Trans>团队</Trans> }]} />
      <AdminCard title="全部团队">
        <AdminTeamsTable />
      </AdminCard>
    </section>
  );
}
