import React from "react";
import { Banner } from "@cloudflare/kumo/components/banner";
import { Button } from "@cloudflare/kumo/components/button";
import { Meter } from "@cloudflare/kumo/components/meter";
import { Text } from "@cloudflare/kumo/components/text";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useRouterState } from "@tanstack/react-router";
import { useStopImpersonation } from "../ops-console/hooks";
import type { PortalIdentity } from "../types";
import { DensityProvider, resolveDensity } from "../components/density";
import { SideNav, type SideNavGroup, type SideNavItem } from "../components/side-nav";
import { useDashboard } from "../hooks/use-dashboard";
import { usePreferences } from "../hooks/use-preferences";
import { useTenantWebhook } from "./hooks";
import { applyBrandVars } from "./branding";
import { fmt } from "../lib/format";
import { useHasHydrated } from "../a11y/use-has-hydrated";

export type ImpersonationView = { realActor: string; effectiveTeamId: string };

export type TenantBrand = {
  name: string;
  logoUrl: string | null;
  primaryColor: string | null;
};

export type TenantPortalShellProps = {
  identity: PortalIdentity;
  brand: TenantBrand;
  impersonation?: ImpersonationView | null;
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

const SIDE_NAV_ICONS: Record<string, SideNavItem["icon"]> = {
  "/": "overview",
  "/usage": "usage",
  "/keys": "keys",
  "/members": "members",
  "/alerts": "budget",
  "/billing": "billing",
};

const PERSONAL_HREFS = new Set(["/", "/usage", "/keys"]);
const TEAM_HREFS = new Set(["/members", "/alerts", "/billing"]);

/**
 * Split the resolved nav into the "我的" (personal) and "团队管理" (team) groups.
 * The team group is omitted entirely when the identity resolves to no
 * team-scoped items (member / least-privilege default).
 */
function resolveNavGroups(identity: PortalIdentity): SideNavGroup[] {
  const nav = resolveNav(identity);
  const toItem = (item: NavItem): SideNavItem => ({
    href: item.href,
    label: item.label,
    icon: SIDE_NAV_ICONS[item.href] ?? "overview",
  });
  const personal = nav.filter((i) => PERSONAL_HREFS.has(i.href)).map(toItem);
  const team = nav.filter((i) => TEAM_HREFS.has(i.href)).map(toItem);
  const groups: SideNavGroup[] = [{ heading: "我的", items: personal }];
  if (team.length > 0) groups.push({ heading: "团队管理", items: team });
  return groups;
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

/**
 * The budget Meter + alert dot derive from client-only queries
 * (useDashboard / useTenantWebhook). Initiating those queries during the
 * shell's SSR render destabilizes the route Suspense boundary that wraps the
 * tenant Outlet (React #418 — proven by the hydration guard). This child is
 * therefore mounted ONLY post-hydration (useHasHydrated), so the shell's SSR
 * + first-hydrate render is deterministic and query-free — the same #418
 * discipline the old BrandBar had implicitly by holding no hooks, and the
 * Task-0B SsrSafeSkeleton pattern. §B.0-safe: no token/shadow change; the
 * design is fully delivered on the client.
 */
function SummaryBarMetrics() {
  const { data: dashboard } = useDashboard();
  const webhook = useTenantWebhook();

  const firstTeam = dashboard?.teams?.[0];
  const teamSpend = firstTeam?.spend ?? 0;
  const teamBudget = firstTeam?.maxBudget ?? null;

  const webhookConfigured =
    webhook.data?.url != null && webhook.data.url.length > 0;
  const alertOk = webhookConfigured && !webhook.isError;

  return (
    <div className="ml-auto flex items-center gap-3">
      {teamBudget != null ? (
        <Meter
          className="w-40"
          value={Number(teamSpend)}
          max={teamBudget}
          customValue={t`${fmt(teamSpend)} / ${fmt(teamBudget)}`}
        />
      ) : null}
      <span
        data-brand-alert-dot
        aria-hidden="true"
        className={`inline-block h-2 w-2 rounded-full ${alertOk ? "bg-kumo-success" : "bg-kumo-warning"}`}
      />
    </div>
  );
}

function BrandSummaryBar({ brand }: { brand: TenantBrand }) {
  const name = brand.name.trim() === "" ? "Portal" : brand.name;
  const logoUrl = isSafeLogoUrl(brand.logoUrl) ? brand.logoUrl : null;
  const hydrated = useHasHydrated();

  return (
    <div
      data-brand-summary-bar
      className="flex items-center gap-3 border-b border-kumo-line bg-kumo-elevated px-6 py-4"
      aria-label={t`租户品牌`}
    >
      {logoUrl !== null ? (
        <img src={logoUrl} alt="" className="h-8 w-8 rounded object-contain" />
      ) : null}
      <Text variant="heading3" as="span" className="truncate text-kumo-strong">
        {name}
      </Text>
      {hydrated ? <SummaryBarMetrics /> : null}
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

function ImpersonationBanner({ imp }: { imp: ImpersonationView }) {
  const stop = useStopImpersonation();
  return (
    <div role="alert" aria-live="assertive" id="impersonation-banner-root">
      <Banner
        variant="warning"
        title={t`正在以租户身份操作`}
        description={
          <Trans>
            {imp.realActor} 正在代表团队 {imp.effectiveTeamId} 操作。所有操作均被审计。
          </Trans>
        }
        action={
          <Button
            variant="secondary"
            size="sm"
            loading={stop.isPending}
            onClick={() =>
              stop.mutate(undefined, {
                onSettled: () => {
                  if (typeof window !== "undefined") window.location.assign("/ops");
                },
              })
            }
          >
            <Trans>退出代操作</Trans>
          </Button>
        }
      />
    </div>
  );
}

/**
 * SSR/first-hydrate-render placeholder for the SideNav.
 *
 * The full SideNav's per-item decoration (icon SVG + accent bar + Kumo Text
 * group headings + long utility class strings) inflates the SSR byte stream
 * enough to push `react-dom/server`'s progressive render past its first flush
 * yield. During that yield the tenant route's unseeded async queries settle,
 * which streams (defers) the route Suspense boundary — the happy-dom #418
 * guard at `/` (Task-0 regression oracle) cannot replay a streamed boundary
 * and flags a false mismatch. Rendering a byte-light, deterministic nav with
 * the SAME links on SSR + first-hydrate render (gated by useHasHydrated, the
 * Task-0B discipline) keeps the route boundary inline, preserves real SSR nav
 * links (no flash / Task-0 guarantee / SEO), and is #418-safe by construction;
 * the full SideNav design mounts post-hydration. §B.0-safe: no token/shadow/
 * typography/radius override — same Kumo tokens, lighter structure.
 */
function SideNavSsrFallback({
  groups,
  currentPath,
  ariaLabel,
}: {
  groups: SideNavGroup[];
  currentPath: string;
  ariaLabel: string;
}) {
  return (
    <nav
      aria-label={ariaLabel}
      className="w-56 shrink-0 border-r border-kumo-line bg-kumo-elevated px-3 py-6"
    >
      <ul className="space-y-1">
        {groups.flatMap((g) => g.items).map((item) => (
          <li key={item.href}>
            <a
              href={item.href}
              aria-current={currentPath === item.href ? "page" : undefined}
              className="block rounded-md px-3 py-2 text-sm font-medium text-kumo-default"
            >
              {item.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function TenantPortalShell({ identity, brand, impersonation, children }: TenantPortalShellProps) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const owner = isPureOwner(identity);
  const navGroups = resolveNavGroups(identity);
  const densityPref = usePreferences().data?.density;
  const hydrated = useHasHydrated();

  return (
    <div
      id="tenant-portal-shell-root"
      className="flex min-h-screen flex-col bg-kumo-canvas text-kumo-default"
      style={applyBrandVars(brand)}
    >
      <DensityProvider density={resolveDensity(densityPref, "comfortable")}>
        {impersonation ? <ImpersonationBanner imp={impersonation} /> : null}
        <BrandSummaryBar brand={brand} />
        {owner ? (
          <main className="mx-auto w-full max-w-5xl px-6 py-10">
            <OwnerPhase2Notice />
            {children}
          </main>
        ) : (
          <div className="flex flex-1">
            {hydrated ? (
              <SideNav
                groups={navGroups}
                currentPath={pathname}
                accent="brand"
                ariaLabel={t`租户导航`}
              />
            ) : (
              <SideNavSsrFallback
                groups={navGroups}
                currentPath={pathname}
                ariaLabel={t`租户导航`}
              />
            )}
            <main className="min-w-0 flex-1 px-6 py-8">{children}</main>
          </div>
        )}
      </DensityProvider>
    </div>
  );
}
