import React from "react";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { AdminView } from "../../../dashboard/views/admin-view";
import { AdminBreadcrumbs } from "../navigation";

export function AdminUsagePage() {
  return (
    <section className="space-y-6" aria-label={t`用量管理`}>
      <AdminBreadcrumbs segments={[{ label: <Trans>用量</Trans> }]} />
      <AdminView />
    </section>
  );
}
