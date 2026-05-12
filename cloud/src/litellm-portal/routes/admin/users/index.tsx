import React from "react";
import { createRoute } from "@tanstack/react-router";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { adminUsersRoute } from "./route";
import { AdminBreadcrumbs } from "../navigation";
import { AdminCard, AdminUsersTable } from "../../../app";

export const adminUsersIndexRoute = createRoute({
  getParentRoute: () => adminUsersRoute,
  path: "/",
  component: AdminUsersPage,
});

function AdminUsersPage() {
  return (
    <section className="space-y-6" aria-label={t`用户管理`}>
      <AdminBreadcrumbs segments={[{ label: <Trans>用户</Trans> }]} />
      <AdminCard title="全员账户">
        <AdminUsersTable />
      </AdminCard>
    </section>
  );
}
