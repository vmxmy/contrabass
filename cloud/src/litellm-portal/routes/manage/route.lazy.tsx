import React from "react";
import { Outlet, useRouterState } from "@tanstack/react-router";
import { Trans } from "@lingui/react/macro";
import { t } from "@lingui/core/macro";
import { useMe } from "../../hooks/use-me";
import { SideNav } from "../../components/side-nav";

const manageNavItems = [
  { href: "/manage/keys", label: <Trans>API Key</Trans>, icon: "keys" as const },
  { href: "/manage/preferences", label: <Trans>偏好</Trans>, icon: "settings" as const },
];

const adminNavItems = [
  ...manageNavItems,
  { href: "/manage/users", label: <Trans>用户</Trans>, icon: "members" as const },
  { href: "/manage/teams", label: <Trans>团队</Trans>, icon: "members" as const },
  { href: "/manage/audit", label: <Trans>审计</Trans>, icon: "audit" as const },
  { href: "/manage/settings", label: <Trans>设置</Trans>, icon: "settings" as const },
];

export function ManageLayout() {
  const { data: me } = useMe();
  // admin_viewer navigates the same admin pages read-only (server denies writes).
  const isAdmin = me?.role === "admin" || me?.role === "admin_viewer";
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  const navItems = isAdmin ? adminNavItems : manageNavItems;

  return (
    <div className="flex flex-1 gap-0">
      <SideNav
        groups={[{ heading: t`管理与配置`, items: navItems }]}
        currentPath={pathname}
        accent="brand"
        ariaLabel={t`管理导航`}
      />
      <section className="min-w-0 flex-1 space-y-8 px-6 py-8">
        <Outlet />
      </section>
    </div>
  );
}
