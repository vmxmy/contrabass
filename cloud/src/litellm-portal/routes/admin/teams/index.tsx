import React from "react";
import { createRoute } from "@tanstack/react-router";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { adminTeamsRoute } from "./route";
import { AdminBreadcrumbs } from "../navigation";
import { AdminCard, AdminTeamsTable } from "../../../app";

export const adminTeamsIndexRoute = createRoute({
  getParentRoute: () => adminTeamsRoute,
  path: "/",
  component: AdminTeamsPage,
});

function AdminTeamsPage() {
  return (
    <section className="space-y-6" aria-label={t`团队管理`}>
      <AdminBreadcrumbs segments={[{ label: <Trans>团队</Trans> }]} />
      <AdminCard title="全部团队">
        <AdminTeamsTable />
      </AdminCard>
    </section>
  );
}
