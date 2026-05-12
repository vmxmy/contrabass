import React from "react";
import { createRoute } from "@tanstack/react-router";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { adminAuditRoute } from "./route";
import { AdminBreadcrumbs } from "../navigation";
import { AdminAuditFeed, AdminCard } from "../../../app";

export const adminAuditIndexRoute = createRoute({
  getParentRoute: () => adminAuditRoute,
  path: "/",
  component: AdminAuditPage,
});

function AdminAuditPage() {
  return (
    <section className="space-y-6" aria-label={t`审计管理`}>
      <AdminBreadcrumbs segments={[{ label: <Trans>审计</Trans> }]} />
      <AdminCard title="审计日志">
        <AdminAuditFeed />
      </AdminCard>
    </section>
  );
}
