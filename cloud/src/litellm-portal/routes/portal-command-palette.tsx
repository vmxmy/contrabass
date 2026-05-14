import React from "react";
import { useRouter } from "@tanstack/react-router";
import { CommandPalette, type HighlightRange } from "@cloudflare/kumo/components/command-palette";
import { t } from "@lingui/core/macro";
import {
  KeyIcon,
  MoonStarsIcon,
  SignOutIcon,
  UserIcon,
  UsersThreeIcon,
  ActivityIcon,
} from "@phosphor-icons/react";
import { useAdminAudit } from "../hooks/use-admin-audit";
import { useAdminTeams } from "../hooks/use-admin-teams";
import { useAdminUsers } from "../hooks/use-admin-users";
import { useUpdatePreferences } from "../hooks/use-preferences";

export type PortalCommandPaletteEntry = {
  id: string;
  group: "jump" | "action";
  title: string;
  description?: string;
  breadcrumbs: string[];
  icon: React.ReactNode;
  href?: string;
  action?: () => void;
};

type PortalCommandPaletteGroup = {
  id: string;
  label: string;
  items: PortalCommandPaletteEntry[];
};

function highlightRange(value: string, query: string): HighlightRange[] | undefined {
  const trimmed = query.trim().toLocaleLowerCase();
  if (!trimmed) return undefined;
  const index = value.toLocaleLowerCase().indexOf(trimmed);
  return index >= 0 ? [[index, index + trimmed.length - 1]] : undefined;
}

function entryMatches(entry: PortalCommandPaletteEntry, query: string): boolean {
  const trimmed = query.trim().toLocaleLowerCase();
  if (!trimmed) return true;
  return [entry.title, entry.description, ...entry.breadcrumbs]
    .filter((value): value is string => typeof value === "string")
    .some((value) => value.toLocaleLowerCase().includes(trimmed));
}

function logout() {
  const form = document.createElement("form");
  form.method = "POST";
  form.action = "/logout";
  document.body.appendChild(form);
  form.submit();
}

function openCreateKey() {
  window.location.href = "/#create-key";
}

export function PortalCommandPalette() {
  const router = useRouter();
  const updatePreferences = useUpdatePreferences();
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const usersQuery = useAdminUsers(1, 50);
  const teamsQuery = useAdminTeams();
  const auditQuery = useAdminAudit({ page: 1, size: 50 });

  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "k") {
        event.preventDefault();
        setOpen((current) => !current);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const toggleTheme = React.useCallback(() => {
    const current = document.documentElement.dataset.mode === "dark" ? "dark" : "light";
    updatePreferences.mutate({ theme: current === "dark" ? "light" : "dark" });
  }, [updatePreferences]);

  const groups = React.useMemo<PortalCommandPaletteGroup[]>(() => {
    const jumpItems: PortalCommandPaletteEntry[] = [
      ...(usersQuery.data?.users ?? []).map((user) => ({
        id: `user:${user.userId}`,
        group: "jump" as const,
        title: user.email,
        description: user.userId,
        breadcrumbs: [t`跳转`, t`用户`],
        icon: <UserIcon className="size-4" />,
        href: `/admin/users/${encodeURIComponent(user.userId)}`,
      })),
      ...(teamsQuery.data?.teams ?? []).map((team) => ({
        id: `team:${team.id}`,
        group: "jump" as const,
        title: team.alias ?? team.id,
        description: team.id,
        breadcrumbs: [t`跳转`, t`团队`],
        icon: <UsersThreeIcon className="size-4" />,
        href: `/admin/teams/${encodeURIComponent(team.id)}`,
      })),
      ...(auditQuery.data?.events ?? []).map((event) => ({
        id: `audit:${event.id}`,
        group: "jump" as const,
        title: `${event.action} · ${event.objectId ?? event.objectType ?? event.id}`,
        description: event.actorUserEmail ?? event.actorUserId ?? event.id,
        breadcrumbs: [t`跳转`, t`审计`],
        icon: <ActivityIcon className="size-4" />,
        href: `/admin/audit/${encodeURIComponent(event.id)}`,
      })),
    ];

    const actionItems: PortalCommandPaletteEntry[] = [
      {
        id: "action:create-key",
        group: "action",
        title: t`新建 Key`,
        description: t`打开个人视图的 Key 创建入口`,
        breadcrumbs: [t`操作`],
        icon: <KeyIcon className="size-4" />,
        action: openCreateKey,
      },
      {
        id: "action:toggle-theme",
        group: "action",
        title: t`切换深色`,
        description: t`在深色和浅色主题之间切换`,
        breadcrumbs: [t`操作`],
        icon: <MoonStarsIcon className="size-4" />,
        action: toggleTheme,
      },
      {
        id: "action:logout",
        group: "action",
        title: t`退出登录`,
        description: t`跳转到 Cloudflare Access 退出登录`,
        breadcrumbs: [t`操作`],
        icon: <SignOutIcon className="size-4" />,
        action: logout,
      },
    ];

    return [
      { id: "jump", label: t`跳转`, items: jumpItems },
      { id: "action", label: t`操作`, items: actionItems },
    ];
  }, [auditQuery.data?.events, teamsQuery.data?.teams, toggleTheme, usersQuery.data?.users]);

  const filteredGroups = React.useMemo(
    () => groups
      .map((group) => ({ ...group, items: group.items.filter((item) => entryMatches(item, query)) }))
      .filter((group) => group.items.length > 0),
    [groups, query],
  );

  const selectEntry = React.useCallback((entry: PortalCommandPaletteEntry, newTab = false) => {
    if (entry.href) {
      if (newTab) {
        window.open(entry.href, "_blank", "noopener,noreferrer");
      } else {
        void router.navigate({ to: entry.href });
      }
    } else {
      entry.action?.();
    }
    setOpen(false);
    setQuery("");
  }, [router]);

  return (
    <CommandPalette.Root<PortalCommandPaletteGroup, PortalCommandPaletteEntry>
      open={open}
      onOpenChange={setOpen}
      items={filteredGroups}
      value={query}
      onValueChange={setQuery}
      itemToStringValue={(group) => group.label}
      getSelectableItems={(items) => items.flatMap((group) => group.items)}
      onSelect={(item, options) => selectEntry(item, options.newTab)}
    >
      <CommandPalette.Input autoFocus placeholder={t`搜索用户、团队、审计事件或操作…`} />
      <CommandPalette.List>
        <CommandPalette.Results>
          {(group) => (
            <CommandPalette.Group key={group.id} items={group.items}>
              <CommandPalette.GroupLabel>{group.label}</CommandPalette.GroupLabel>
              <CommandPalette.Items>
                {(item) => (
                  <CommandPalette.ResultItem
                    key={item.id}
                    title={item.title}
                    breadcrumbs={item.breadcrumbs}
                    titleHighlights={highlightRange(item.title, query)}
                    breadcrumbHighlights={item.breadcrumbs.map((part) => highlightRange(part, query) ?? [])}
                    description={item.description}
                    icon={item.icon}
                    value={item}
                    onClick={(event) => selectEntry(item, event.metaKey || event.ctrlKey)}
                  />
                )}
              </CommandPalette.Items>
            </CommandPalette.Group>
          )}
        </CommandPalette.Results>
        <CommandPalette.Empty>{t`没有匹配的命令`}</CommandPalette.Empty>
      </CommandPalette.List>
      <CommandPalette.Footer>{t`Enter 打开 · Esc 关闭 · ⌘K / Ctrl+K 切换`}</CommandPalette.Footer>
    </CommandPalette.Root>
  );
}
