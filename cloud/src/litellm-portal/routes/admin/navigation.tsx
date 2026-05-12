import React from "react";
import { Outlet, useMatchRoute } from "@tanstack/react-router";
import { Sidebar } from "@cloudflare/kumo/components/sidebar";
import { Breadcrumbs } from "@cloudflare/kumo/components/breadcrumbs";
import { Text } from "@cloudflare/kumo/components/text";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
  ActivityIcon,
  ChartLineIcon,
  GearSixIcon,
  ListIcon,
  ShieldCheckIcon,
  UsersIcon,
} from "@phosphor-icons/react";
import { useAdminAudit } from "../../hooks/use-admin-audit";

const SIDEBAR_OPEN_KEY = "litellm-portal-admin-sidebar-open";

type AdminNavItem = {
  to: string;
  label: React.ReactNode;
  matchTo: string;
  icon: React.ComponentType<{ className?: string }>;
  badge?: React.ReactNode;
  tooltip: string;
};

function readSidebarOpen(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(SIDEBAR_OPEN_KEY) !== "false";
  } catch {
    return true;
  }
}

function writeSidebarOpen(open: boolean) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SIDEBAR_OPEN_KEY, String(open));
  } catch {
    // Ignore private browsing / denied storage.
  }
}

export function AdminSidebar() {
  const matchRoute = useMatchRoute();
  const [open, setOpen] = React.useState(readSidebarOpen);
  const { data: auditWindow } = useAdminAudit({ window: "24h" });
  const todaysAuditCount = auditWindow?.events.filter((event) => {
    if (!event.createdAt) return false;
    const timestamp = Date.parse(event.createdAt);
    return Number.isFinite(timestamp) && Date.now() - timestamp <= 24 * 60 * 60 * 1000;
  }).length ?? 0;

  const handleOpenChange = React.useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    writeSidebarOpen(nextOpen);
  }, []);

  const items: AdminNavItem[] = [
    { to: "/admin/users", matchTo: "/admin/users", label: <Trans>用户</Trans>, icon: UsersIcon, tooltip: t`用户` },
    { to: "/admin/teams", matchTo: "/admin/teams", label: <Trans>团队</Trans>, icon: ShieldCheckIcon, tooltip: t`团队` },
    {
      to: "/admin/audit",
      matchTo: "/admin/audit",
      label: <Trans>审计</Trans>,
      icon: ActivityIcon,
      badge: todaysAuditCount > 0 ? todaysAuditCount : null,
      tooltip: t`审计`,
    },
    { to: "/admin/usage", matchTo: "/admin/usage", label: <Trans>用量</Trans>, icon: ChartLineIcon, tooltip: t`用量` },
    { to: "/admin/settings", matchTo: "/admin/settings", label: <Trans>设置</Trans>, icon: GearSixIcon, tooltip: t`设置` },
  ];

  return (
    <Sidebar.Provider open={open} onOpenChange={handleOpenChange} collapsible="icon">
      <Sidebar aria-label={t`管理员导航`}>
        <Sidebar.Header>
          <div className="flex min-h-10 items-center gap-2 px-2">
            <ListIcon className="size-4 text-kumo-subtle" />
            <Text variant="secondary" size="xs" className="font-semibold uppercase tracking-wider">
              <Trans>管理员</Trans>
            </Text>
          </div>
        </Sidebar.Header>
        <Sidebar.Content>
          <Sidebar.Group>
            <Sidebar.GroupLabel><Trans>管理菜单</Trans></Sidebar.GroupLabel>
            <Sidebar.Menu>
              {items.map((item) => {
                const active = Boolean(matchRoute({ to: item.matchTo, fuzzy: true }));
                return (
                  <Sidebar.MenuItem key={item.to}>
                    <Sidebar.MenuButton icon={item.icon} active={active} href={item.to} tooltip={item.tooltip}>
                      {item.label}
                      {item.badge ? <Sidebar.MenuBadge aria-label={t`今日新增 ${String(item.badge)} 条`}>{item.badge}</Sidebar.MenuBadge> : null}
                    </Sidebar.MenuButton>
                  </Sidebar.MenuItem>
                );
              })}
            </Sidebar.Menu>
          </Sidebar.Group>
        </Sidebar.Content>
        <Sidebar.Footer>
          <Sidebar.Trigger aria-label={open ? t`折叠管理员导航` : t`展开管理员导航`} />
        </Sidebar.Footer>
        <Sidebar.Rail aria-label={t`切换管理员导航`} />
      </Sidebar>
      <div className="min-w-0 flex-1 p-4 lg:p-6" data-testid="admin-sidebar-inset">
        <Outlet />
      </div>
    </Sidebar.Provider>
  );
}


export type AdminBreadcrumbSegment = {
  label: React.ReactNode;
  href?: string;
};

export function AdminBreadcrumbs({ segments }: { segments: AdminBreadcrumbSegment[] }) {
  const allSegments: AdminBreadcrumbSegment[] = [
    { label: <Trans>管理员</Trans>, href: "/admin" },
    ...segments,
  ];

  return (
    <Breadcrumbs size="sm" className="mb-6" aria-label={t`管理员路径`}>
      {allSegments.map((segment, index) => {
        const isLast = index === allSegments.length - 1;
        return (
          <React.Fragment key={`${index}-${segment.href ?? "current"}`}>
            {isLast || !segment.href ? (
              <Breadcrumbs.Current>{segment.label}</Breadcrumbs.Current>
            ) : (
              <Breadcrumbs.Link href={segment.href}>{segment.label}</Breadcrumbs.Link>
            )}
            {!isLast ? <Breadcrumbs.Separator /> : null}
          </React.Fragment>
        );
      })}
    </Breadcrumbs>
  );
}

export const adminSidebarStorageKey = SIDEBAR_OPEN_KEY;
