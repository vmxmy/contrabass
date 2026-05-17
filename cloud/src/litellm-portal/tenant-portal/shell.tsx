import React from "react";
import { Banner } from "@cloudflare/kumo/components/banner";
import { Text } from "@cloudflare/kumo/components/text";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { PortalIdentity } from "../types";
import { applyBrandVars } from "./branding";

export type TenantBrand = {
  name: string;
  logoUrl: string | null;
  primaryColor: string | null;
};

export type TenantPortalShellProps = {
  identity: PortalIdentity;
  brand: TenantBrand;
  children: React.ReactNode;
};

type NavItem = { href: string; label: React.ReactNode };

const OVERVIEW: NavItem = { href: "/", label: <Trans>概览</Trans> };
const USAGE: NavItem = { href: "/usage", label: <Trans>用量</Trans> };
const API_KEY: NavItem = { href: "/keys", label: <Trans>API Key</Trans> };
const MEMBERS: NavItem = { href: "/members", label: <Trans>成员</Trans> };
const BUDGET: NavItem = { href: "/alerts", label: <Trans>预算</Trans> };
const BILLING: NavItem = { href: "/billing", label: <Trans>账单</Trans> };

const MEMBER_NAV: NavItem[] = [OVERVIEW, USAGE, API_KEY];
const FULL_NAV: NavItem[] = [OVERVIEW, USAGE, API_KEY, MEMBERS, BUDGET, BILLING];

/**
 * Identity → nav resolution per the Phase 1 Minimal decision.
 *
 * - `tenant_admin` (own team) → full 6-item nav.
 * - platform admin (`role === "admin"`) WITH a `tenantTeamId` → full nav too
 *   (an Owner who also belongs to a team manages that team here).
 * - `member` → Overview / Usage / API Key only.
 * - pure Owner (`role === "admin"` WITHOUT a `tenantTeamId`) → no tenant nav;
 *   a non-blocking Phase-2 notice + a working /manage legacy link instead.
 */
function isPureOwner(identity: PortalIdentity): boolean {
  return identity.role === "admin" && identity.tenantTeamId === null && identity.tenantRole === null;
}

function resolveNav(identity: PortalIdentity): NavItem[] {
  if (identity.tenantRole === "tenant_admin") return FULL_NAV;
  if (identity.role === "admin" && identity.tenantTeamId !== null) return FULL_NAV;
  if (identity.tenantRole === "member") return MEMBER_NAV;
  // Least-privilege default for a null/unrecognised tenantRole (valid case: a
  // user not yet assigned to a team).
  return MEMBER_NAV;
}

/** Only render the logo when the URL is a safe, absolute https:// origin. */
function isSafeLogoUrl(url: string | null): url is string {
  if (url === null) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function BrandBar({ brand }: { brand: TenantBrand }) {
  const name = brand.name.trim() === "" ? "Portal" : brand.name;
  const logoUrl = isSafeLogoUrl(brand.logoUrl) ? brand.logoUrl : null;
  return (
    <div
      className="flex items-center gap-3 border-b border-kumo-default bg-kumo-elevated px-6 py-4"
      aria-label="租户品牌"
    >
      {logoUrl !== null ? (
        <img src={logoUrl} alt="" className="h-8 w-8 rounded object-contain" />
      ) : null}
      <Text variant="heading3" as="span" className="truncate text-kumo-strong">
        {name}
      </Text>
    </div>
  );
}

function OwnerPhase2Notice() {
  return (
    <div className="space-y-6" id="owner-phase2-root">
      <Banner
        variant="default"
        title={t`运营控制台将在 Phase 2 提供`}
        description={<Trans>Operations Console arrives in Phase 2</Trans>}
        action={
          <a
            href="/manage"
            className="font-semibold text-kumo-link underline underline-offset-2"
          >
            <Trans>管理控制台</Trans>
          </a>
        }
      />
    </div>
  );
}

export function TenantPortalShell({ identity, brand, children }: TenantPortalShellProps) {
  const owner = isPureOwner(identity);
  const nav = resolveNav(identity);

  return (
    <div
      id="tenant-portal-shell-root"
      className="flex min-h-screen flex-col bg-kumo-canvas text-kumo-default"
      style={applyBrandVars(brand)}
    >
      <BrandBar brand={brand} />
      {owner ? (
        <main className="mx-auto w-full max-w-5xl px-6 py-10">
          <OwnerPhase2Notice />
          {children}
        </main>
      ) : (
        <div className="flex flex-1">
          <nav
            aria-label="租户导航"
            className="w-56 shrink-0 border-r border-kumo-default bg-kumo-elevated px-3 py-6"
          >
            <ul className="space-y-1">
              {nav.map((item) => (
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
      )}
    </div>
  );
}
