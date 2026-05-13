import React from "react";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { AdminCard, AdminUsersTable } from "../../../admin-components";
import { AdminBreadcrumbs } from "../navigation";

export function AdminUsersPage() {
  return (
    <section className="space-y-6" aria-label={t`用户管理`}>
      <AdminBreadcrumbs segments={[{ label: <Trans>用户</Trans> }]} />
      <AdminCard title="全员账户">
        <AdminUsersTable />
      </AdminCard>
    </section>
  );
}
