import React from "react";
import { createRoute } from "@tanstack/react-router";
import { Text } from "@cloudflare/kumo/components/text";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { adminRoute } from "./route";
import { AdminBreadcrumbs } from "./navigation";
import { AdminHeroStats } from "../../app";

export const adminIndexRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/",
  component: AdminOverview,
});

function AdminOverview() {
  return (
    <section className="space-y-6" aria-label={t`管理员概览`}>
      <AdminBreadcrumbs segments={[]} />
      <div className="space-y-2">
        <Text variant="heading2" as="h2"><Trans>管理员概览</Trans></Text>
        <Text variant="secondary" as="p"><Trans>从左侧导航进入用户、团队、审计、用量和设置子页面。</Trans></Text>
      </div>
      <AdminHeroStats />
    </section>
  );
}
