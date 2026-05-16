import React from "react";
import { Outlet, useMatchRoute, useRouter } from "@tanstack/react-router";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Tabs, type TabsItem } from "@cloudflare/kumo/components/tabs";
import { Text } from "@cloudflare/kumo/components/text";
import { Trans } from "@lingui/react/macro";
import { useMe } from "../../hooks/use-me";
import { useAdminAudit } from "../../hooks/use-admin-audit";

type ManageTab = TabsItem & { to: string; matchTo: string };

const personalTabs: ManageTab[] = [
  { value: "/manage/keys", to: "/manage/keys", matchTo: "/manage/keys", label: <Trans>API Key</Trans> },
  { value: "/manage/preferences", to: "/manage/preferences", matchTo: "/manage/preferences", label: <Trans>偏好</Trans> },
];

function auditBadge(count: number) {
  if (count <= 0) return <Trans>审计</Trans>;
  return (
    <span className="inline-flex items-center gap-2">
      <Trans>审计</Trans>
      <Badge variant="info" className="rounded-full px-1.5 py-0 text-[10px]">{count}</Badge>
    </span>
  );
}

function useActiveTab(items: ManageTab[]) {
  const matchRoute = useMatchRoute();
  return items.find((item) => Boolean(matchRoute({ to: item.matchTo, fuzzy: true })))?.value ?? items[0]?.value;
}

function ManageTabs({ items }: { items: ManageTab[] }) {
  const router = useRouter();
  const active = useActiveTab(items);

  return (
    <Tabs
      variant="underline"
      value={active}
      onValueChange={(next) => { void router.navigate({ href: next }); }}
      tabs={items}
      listClassName="flex-wrap justify-start gap-2"
    />
  );
}

function AdminManageTabs() {
  const { data: auditWindow } = useAdminAudit({ window: "24h" });
  const todaysAuditCount = auditWindow?.events.filter((event) => {
    if (!event.createdAt) return false;
    const timestamp = Date.parse(event.createdAt);
    return Number.isFinite(timestamp) && Date.now() - timestamp <= 24 * 60 * 60 * 1000;
  }).length ?? 0;

  const items: ManageTab[] = [
    ...personalTabs,
    { value: "/manage/users", to: "/manage/users", matchTo: "/manage/users", label: <Trans>用户</Trans> },
    { value: "/manage/teams", to: "/manage/teams", matchTo: "/manage/teams", label: <Trans>团队</Trans> },
    { value: "/manage/audit", to: "/manage/audit", matchTo: "/manage/audit", label: auditBadge(todaysAuditCount) },
    { value: "/manage/settings", to: "/manage/settings", matchTo: "/manage/settings", label: <Trans>设置</Trans> },
  ];

  return <ManageTabs items={items} />;
}

export function ManageLayout() {
  const { data: me } = useMe();
  const isAdmin = me?.role === "admin";

  return (
    <section className="space-y-8" aria-label="管理与配置">
      <div className="space-y-2">
        <Text variant="heading2" as="h2"><Trans>管理与配置</Trans></Text>
        <Text variant="secondary" as="p"><Trans>API Key、偏好与管理员配置集中在这里，仪表盘保持只读。</Trans></Text>
      </div>
      {isAdmin ? <AdminManageTabs /> : <ManageTabs items={personalTabs} />}
      <Outlet />
    </section>
  );
}
