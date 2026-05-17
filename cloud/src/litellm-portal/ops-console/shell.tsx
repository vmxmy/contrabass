import React from "react";
import { Text } from "@cloudflare/kumo/components/text";
import { Empty } from "@cloudflare/kumo/components/empty";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useRouterState } from "@tanstack/react-router";
import type { PortalIdentity } from "../types";
import { DensityProvider, resolveDensity } from "../components/density";
import { DensityToggle } from "../components/density-toggle";
import { SideNav, type SideNavGroup } from "../components/side-nav";
import type { NavIconName } from "../components/nav-icons";
import { usePreferences, useUpdatePreferences } from "../hooks/use-preferences";
import { useOpsTenants } from "./hooks";
import { OPS_STEEL_ACCENT } from "./ops-theme";

export type OpsConsoleShellProps = {
  identity: PortalIdentity;
  children: React.ReactNode;
};

type OpsNavItem = { href: string; label: React.ReactNode; icon: NavIconName };

const OPS_NAV: OpsNavItem[] = [
  { href: "/ops", label: <Trans>租户总览</Trans>, icon: "tenant-overview" },
  { href: "/ops/provisioning", label: <Trans>发放与邀请</Trans>, icon: "provisioning" },
  { href: "/ops/usage", label: <Trans>全局用量</Trans>, icon: "usage" },
  { href: "/ops/audit", label: <Trans>审计</Trans>, icon: "audit" },
  { href: "/ops/settings", label: <Trans>平台设置</Trans>, icon: "settings" },
];

function byHref(href: string): OpsNavItem {
  const item = OPS_NAV.find((n) => n.href === href);
  if (!item) throw new Error(`unknown ops nav href: ${href}`);
  return item;
}

/**
 * Owner gate. The Operations Console is platform-internal and only visible to
 * a platform Owner (`role === "admin"`). Tenant-scoped roles never see the
 * nav — they get the forbidden card with a link back to `/`. The real
 * enforcement is the server-side Owner guard; this is the client-side surface.
 */
function isOwner(identity: PortalIdentity): boolean {
  return identity.role === "admin";
}

function OpsForbiddenCard() {
  return (
    <div id="ops-forbidden-root" className="py-12">
      <Empty
        title={t`仅平台 Owner 可访问`}
        description={t`运营控制台仅对平台 Owner 开放。`}
        action={
          <a
            href="/"
            className="font-semibold text-kumo-link underline underline-offset-2"
          >
            <Trans>返回首页</Trans>
          </a>
        }
      />
    </div>
  );
}

function OpsSummaryChips() {
  const { data } = useOpsTenants();
  const tenants = data?.tenants;
  const tenantCount = tenants === undefined ? "—" : String(tenants.length);
  const alertingCount =
    tenants === undefined
      ? "—"
      : String(
          tenants.filter(
            (tn) =>
              tn.cycleSpend != null &&
              tn.maxBudget != null &&
              tn.cycleSpend >= tn.maxBudget,
          ).length,
        );
  return (
    <div
      data-testid="ops-summary-chips"
      className="ml-auto flex items-center gap-2"
    >
      <span className="rounded-full bg-kumo-canvas px-2 py-0.5 text-xs text-kumo-subtle">
        <Trans>租户</Trans>{" "}
        <span className="font-mono font-semibold tabular-nums text-kumo-strong">
          {tenantCount}
        </span>
      </span>
      <span className="rounded-full bg-kumo-canvas px-2 py-0.5 text-xs text-kumo-subtle">
        <Trans>告警租户</Trans>{" "}
        <span className="font-mono font-semibold tabular-nums text-kumo-strong">
          {alertingCount}
        </span>
      </span>
    </div>
  );
}

export function OpsConsoleShell({ identity, children }: OpsConsoleShellProps) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const densityPref = usePreferences().data?.density;
  const updatePrefs = useUpdatePreferences();
  if (!isOwner(identity)) {
    return (
      <div
        id="ops-console-shell-root"
        className="flex min-h-screen flex-col bg-kumo-canvas text-kumo-default"
        style={OPS_STEEL_ACCENT}
      >
        <OpsForbiddenCard />
      </div>
    );
  }

  return (
    <div
      id="ops-console-shell-root"
      className="flex min-h-screen flex-col bg-kumo-canvas text-kumo-default"
      style={OPS_STEEL_ACCENT}
    >
      <DensityProvider density={resolveDensity(densityPref, "compact")}>
        <div
          className="flex items-center gap-3 border-b border-kumo-line bg-kumo-elevated px-6 py-4"
          aria-label={t`运营控制台`}
        >
          <Text variant="heading3" as="span" className="truncate text-kumo-strong">
            <Trans>运营控制台</Trans>
          </Text>
          <span
            data-ops-privileged-pill
            className="rounded-full ring-1 ring-kumo-brand px-2 py-0.5 text-xs font-medium text-kumo-subtle"
          >
            <Trans>内部·特权</Trans>
          </span>
          <OpsSummaryChips />
          <DensityToggle
            current={resolveDensity(densityPref, "compact")}
            onChange={(d) => updatePrefs.mutate({ density: d })}
          />
        </div>
        <div className="flex flex-1">
          <SideNav
            groups={[
              {
                heading: t`租户`,
                items: ["/ops", "/ops/provisioning"].map((href) => {
                  const n = byHref(href);
                  return { href: n.href, label: n.label, icon: n.icon };
                }),
              },
              {
                heading: t`平台`,
                items: ["/ops/usage", "/ops/audit", "/ops/settings"].map(
                  (href) => {
                    const n = byHref(href);
                    return { href: n.href, label: n.label, icon: n.icon };
                  },
                ),
              },
            ]}
            currentPath={pathname}
            accent="steel"
            ariaLabel={t`运营导航`}
          />
          <main className="min-w-0 flex-1 px-6 py-8">{children}</main>
        </div>
      </DensityProvider>
    </div>
  );
}
