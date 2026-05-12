import React from "react";
import { createRoute } from "@tanstack/react-router";
import { Empty } from "@cloudflare/kumo/components/empty";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { adminRoute } from "./route";
import { AdminBreadcrumbs } from "./navigation";

export const adminSettingsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/settings",
  component: AdminSettingsPage,
});

function AdminSettingsPage() {
  return (
    <section className="space-y-6" aria-label={t`设置管理`}>
      <AdminBreadcrumbs segments={[{ label: <Trans>设置</Trans> }]} />
      <Empty size="sm" title={t`设置暂未开放`} description={t`后续写操作与偏好同步能力会放在这里。`} />
    </section>
  );
}
