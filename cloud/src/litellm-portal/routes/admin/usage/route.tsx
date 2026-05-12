import React from "react";
import { createRoute } from "@tanstack/react-router";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { adminRoute } from "../route";
import { AdminBreadcrumbs } from "../navigation";
import { AdminCard, AdminGlobalUsage } from "../../../app";

export const adminUsageRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/usage",
  component: AdminUsagePage,
});

function AdminUsagePage() {
  return (
    <section className="space-y-6" aria-label={t`用量管理`}>
      <AdminBreadcrumbs segments={[{ label: <Trans>用量</Trans> }]} />
      <AdminCard title="全局用量趋势">
        <AdminGlobalUsage />
      </AdminCard>
    </section>
  );
}
