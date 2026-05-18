import React from "react";
import { t } from "@lingui/core/macro";
import { AdminAuditFeed, AdminCard } from "../../../admin-components";
import { BlockErrorBoundary } from "../../../errors/error-boundary";

export function ManageAuditPage() {
  return (
    <section className="space-y-6" aria-label={t`审计管理`}>
      <AdminCard title="审计日志">
        <BlockErrorBoundary blockLabel="审计日志">
          <AdminAuditFeed />
        </BlockErrorBoundary>
      </AdminCard>
    </section>
  );
}
