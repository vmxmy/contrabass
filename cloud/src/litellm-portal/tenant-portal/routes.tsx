/**
 * Tenant Portal route subtree.
 *
 * Mirrors the #135 `createRoute` + `*.lazy.tsx` idiom. Task 1 ships the route
 * skeleton (one placeholder element per screen); Tasks 3-8 replace each
 * placeholder with the real screen. The factory takes the parent route so the
 * subtree can be mounted without hardcoding a collision with the existing
 * `indexRoute` / `manage*` tree in `router.tsx`.
 *
 * Member-hidden routes (`/members`, `/alerts`, `/billing`) still register so
 * deep links resolve, but default to a Kumo `Empty` forbidden state
 * (`MemberForbidden`) rather than leaking a Placeholder. The real gate is the
 * server-side `requireTenantAdmin`; this is only the client-side deep-link
 * default. Tasks 3-8 replace the Placeholders with real screens and may add
 * identity-aware rendering (real-screen-or-MemberForbidden) at that point.
 */
import React from "react";
import { createRoute, Outlet, type AnyRoute } from "@tanstack/react-router";
import { Empty } from "@cloudflare/kumo/components/empty";
import { Text } from "@cloudflare/kumo/components/text";
import { Loader } from "@cloudflare/kumo/components/loader";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useMe } from "../hooks/use-me";
import { TenantPortalShell } from "./shell";
import type { PortalIdentity } from "../types";
import type { Me } from "../schemas";
import { TenantUsageScreen } from "./screens/usage";
import { TenantKeysScreen } from "./screens/keys";
import { TenantMembersScreen } from "./screens/members";
import { TenantAlertsScreen } from "./screens/alerts";
import { TenantBillingScreen } from "./screens/billing";

function Placeholder({ id, label }: { id: string; label: React.ReactNode }) {
  return (
    <div id={id} className="space-y-2">
      <Text variant="heading2" as="h2">{label}</Text>
      <Text variant="secondary" as="p"><Trans>待实现</Trans></Text>
    </div>
  );
}

export function MemberForbidden() {
  return (
    <div id="tenant-forbidden-root" className="py-12">
      <Empty title={t`无权访问`} description={t`该页面仅对团队管理员开放。`} />
    </div>
  );
}

type TenantRouteSpec = {
  path: string;
  id: string;
  label: React.ReactNode;
  /** Member-hidden screens render MemberForbidden when reached directly. */
  adminOnly: boolean;
  /** Real screen component; falls back to Placeholder when absent. */
  component?: React.ComponentType;
};

const TENANT_ROUTE_SPECS: TenantRouteSpec[] = [
  { path: "/", id: "tenant-overview-root", label: <Trans>概览</Trans>, adminOnly: false },
  { path: "/usage", id: "tenant-usage-root", label: <Trans>用量</Trans>, adminOnly: false, component: TenantUsageScreen },
  { path: "/keys", id: "tenant-keys-root", label: <Trans>API Key</Trans>, adminOnly: false, component: TenantKeysScreen },
  { path: "/members", id: "tenant-members-root", label: <Trans>成员</Trans>, adminOnly: true, component: TenantMembersScreen },
  { path: "/alerts", id: "tenant-alerts-root", label: <Trans>预算</Trans>, adminOnly: true, component: TenantAlertsScreen },
  { path: "/billing", id: "tenant-billing-root", label: <Trans>账单</Trans>, adminOnly: true, component: TenantBillingScreen },
];

/**
 * Build the Tenant Portal route subtree under `parentRoute`. Returns the
 * created child routes so the caller can `parentRoute.addChildren([...])`.
 *
 * `includeIndex` controls whether the `/` overview spec is mapped. The portal
 * router mounts this subtree under `rootRoute`, where `/` is already owned by
 * `indexRoute` (which selects the shell from the hydrated identity), so it
 * passes `includeIndex: false`. The spec→exclusion decision lives here, next to
 * `TENANT_ROUTE_SPECS`, so a reorder/insert can never reintroduce a duplicate
 * `/` route-id collision by drifting a parallel index filter at the call site.
 */
export function createTenantPortalRoutes(
  parentRoute: AnyRoute,
  { includeIndex = true }: { includeIndex?: boolean } = {},
) {
  const specs = includeIndex
    ? TENANT_ROUTE_SPECS
    : TENANT_ROUTE_SPECS.filter((spec) => spec.path !== "/");
  return specs.map((spec) =>
    createRoute({
      getParentRoute: () => parentRoute,
      path: spec.path,
      component: spec.adminOnly
        ? (spec.component ?? MemberForbidden)
        : (spec.component ?? (() => <Placeholder id={spec.id} label={spec.label} />)),
    }),
  );
}

export { TENANT_ROUTE_SPECS };

/**
 * Mirrors `routes/index.tsx` `PortalIndex`'s identity→props mapping (read it;
 * do NOT invent — `TenantPortalShell`'s prop shape is whatever `PortalIndex`
 * passes).
 */
function toTenantIdentity(me: Me): PortalIdentity {
  return {
    email: me.email,
    userId: me.userId,
    domain: me.domain,
    litellmUserId: me.userId,
    role: me.role,
    tenantRole: me.tenantRole,
    tenantTeamId: me.tenantTeamId,
  };
}

/**
 * `TenantPortalShellProps.brand` is NON-OPTIONAL — copy the EXACT shape from
 * `routes/index.tsx` `toTenantBrand` (verified live).
 */
function toTenantBrand(me: Me) {
  return { name: me.company, logoUrl: null, primaryColor: null };
}

/**
 * Pathless layout for the Tenant Portal subroutes (mirror of OpsLayout).
 * Identity is derived purely from the hydrated `useMe()` — #418-safe (same
 * discipline as OpsLayout). While `me` is undefined render a loading root
 * (NOT a redirect/forbidden) — the M-NEW-1 cold-load rule, identical to
 * OpsLayout. `/` is NOT a child here (it stays owned by `indexRoute` →
 * `PortalIndex`, which selects the shell from identity); this layout owns
 * ONLY the non-`/` tenant subroutes so there is NO route-id collision
 * (mirrors how `opsLayoutRoute` keeps `/ops` as a CHILD without colliding).
 */
function TenantLayout() {
  const { data: me } = useMe();
  if (me === undefined) {
    return (
      <div id="tenant-portal-loading-root" className="py-12">
        <Loader aria-label="正在加载" />
      </div>
    );
  }
  return (
    <TenantPortalShell
      identity={toTenantIdentity(me)}
      brand={toTenantBrand(me)}
      impersonation={me.impersonation ?? null}
    >
      <Outlet />
    </TenantPortalShell>
  );
}

/**
 * Build the Tenant Portal subtree as a single pathless layout route (mirror
 * of `createOpsConsoleRoutes`). Returns the pathless layout route (with its
 * non-`/` screen children attached). Caller does
 * `parentRoute.addChildren([tenantLayoutRoute])`. `id`-only (no `path`) so it
 * never matches a URL on its own — only its children's paths do. The `/`
 * spec is EXCLUDED here (owned by `indexRoute`) — same `includeIndex:false`
 * intent, now structural via this factory.
 */
export function createTenantPortalLayoutRoute(parentRoute: AnyRoute) {
  const tenantLayoutRoute = createRoute({
    getParentRoute: () => parentRoute,
    id: "tenant-layout",
    component: TenantLayout,
  });
  const children = TENANT_ROUTE_SPECS.filter((spec) => spec.path !== "/").map((spec) =>
    createRoute({
      getParentRoute: () => tenantLayoutRoute,
      path: spec.path,
      component: spec.adminOnly
        ? (spec.component ?? MemberForbidden)
        : (spec.component ?? (() => <Placeholder id={spec.id} label={spec.label} />)),
    }),
  );
  return tenantLayoutRoute.addChildren(children);
}
