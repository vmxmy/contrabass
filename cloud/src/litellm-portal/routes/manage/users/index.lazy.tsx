import React from "react";
import { t } from "@lingui/core/macro";
import { AdminCard, AdminUsersTable } from "../../../admin-components";

export function ManageUsersPage() {
  return (
    <section className="space-y-6" aria-label={t`用户管理`}>
      <AdminCard title="全员账户">
        <AdminUsersTable />
      </AdminCard>
    </section>
  );
}
