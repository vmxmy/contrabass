import React from "react";
import { Text } from "@cloudflare/kumo/components/text";
import { Empty } from "@cloudflare/kumo/components/empty";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { PortalIdentity } from "../types";
import { OPS_STEEL_ACCENT } from "./ops-theme";

export type OpsConsoleShellProps = {
  identity: PortalIdentity;
  children: React.ReactNode;
};

type OpsNavItem = { href: string; label: React.ReactNode };

const OPS_NAV: OpsNavItem[] = [
  { href: "/ops", label: <Trans>租户总览</Trans> },
  { href: "/ops/provisioning", label: <Trans>发放与邀请</Trans> },
  { href: "/ops/usage", label: <Trans>全局用量</Trans> },
  { href: "/ops/audit", label: <Trans>审计</Trans> },
  { href: "/ops/settings", label: <Trans>平台设置</Trans> },
];

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

export function OpsConsoleShell({ identity, children }: OpsConsoleShellProps) {
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
      <div
        className="flex items-center gap-3 border-b border-kumo-default bg-kumo-elevated px-6 py-4"
        aria-label={t`运营控制台`}
      >
        <Text variant="heading3" as="span" className="truncate text-kumo-strong">
          <Trans>运营控制台</Trans>
        </Text>
        <span className="rounded-full bg-kumo-canvas px-2 py-0.5 text-xs font-medium text-kumo-subtle">
          <Trans>内部·特权</Trans>
        </span>
      </div>
      <div className="flex flex-1">
        <nav
          aria-label={t`运营导航`}
          className="w-56 shrink-0 border-r border-kumo-default bg-kumo-elevated px-3 py-6"
        >
          <ul className="space-y-1">
            {OPS_NAV.map((item) => (
              <li key={item.href}>
                <a
                  href={item.href}
                  className="block rounded-md px-3 py-2 text-sm font-medium text-kumo-default hover:bg-kumo-canvas hover:text-kumo-strong"
                >
                  {item.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <main className="min-w-0 flex-1 px-6 py-8">{children}</main>
      </div>
    </div>
  );
}
