import React from "react";
import { t } from "@lingui/core/macro";
import { AdminCard, AdminUsersTable } from "../../../admin-components";
import { BlockErrorBoundary } from "../../../errors/error-boundary";

export function ManageUsersPage() {
  return (
    <section className="space-y-6" aria-label={t`用户管理`}>
      <AdminCard title="全员账户">
        <BlockErrorBoundary blockLabel="用户管理">
          <AdminUsersTable />
        </BlockErrorBoundary>
      </AdminCard>
    </section>
  );
}
