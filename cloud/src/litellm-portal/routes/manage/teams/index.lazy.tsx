import React from "react";
import { t } from "@lingui/core/macro";
import { AdminCard, AdminTeamsTable } from "../../../admin-components";
import { BlockErrorBoundary } from "../../../errors/error-boundary";

export function ManageTeamsPage() {
  return (
    <section className="space-y-6" aria-label={t`团队管理`}>
      <AdminCard title="全部团队">
        <BlockErrorBoundary blockLabel="团队管理">
          <AdminTeamsTable />
        </BlockErrorBoundary>
      </AdminCard>
    </section>
  );
}
