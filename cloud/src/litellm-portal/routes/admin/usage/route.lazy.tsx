import React from "react";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { AdminCard, AdminGlobalUsage } from "../../../admin-components";
import { AdminBreadcrumbs } from "../navigation";

export function AdminUsagePage() {
  return (
    <section className="space-y-6" aria-label={t`用量管理`}>
      <AdminBreadcrumbs segments={[{ label: <Trans>用量</Trans> }]} />
      <AdminCard title="全局用量趋势">
        <AdminGlobalUsage />
      </AdminCard>
    </section>
  );
}
