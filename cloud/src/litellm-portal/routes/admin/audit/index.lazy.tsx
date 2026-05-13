import React from "react";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { AdminAuditFeed, AdminCard } from "../../../admin-components";
import { AdminBreadcrumbs } from "../navigation";

export function AdminAuditPage() {
  return (
    <section className="space-y-6" aria-label={t`审计管理`}>
      <AdminBreadcrumbs segments={[{ label: <Trans>审计</Trans> }]} />
      <AdminCard title="审计日志">
        <AdminAuditFeed />
      </AdminCard>
    </section>
  );
}
