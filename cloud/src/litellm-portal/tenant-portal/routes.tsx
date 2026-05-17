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
import { createRoute, type AnyRoute } from "@tanstack/react-router";
import { Empty } from "@cloudflare/kumo/components/empty";
import { Text } from "@cloudflare/kumo/components/text";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { TenantUsageScreen } from "./screens/usage";

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
};

const TENANT_ROUTE_SPECS: TenantRouteSpec[] = [
  { path: "/", id: "tenant-overview-root", label: <Trans>概览</Trans>, adminOnly: false },
  { path: "/usage", id: "tenant-usage-root", label: <Trans>用量</Trans>, adminOnly: false },
  { path: "/keys", id: "tenant-keys-root", label: <Trans>API Key</Trans>, adminOnly: false },
  { path: "/members", id: "tenant-members-root", label: <Trans>成员</Trans>, adminOnly: true },
  { path: "/alerts", id: "tenant-alerts-root", label: <Trans>预算</Trans>, adminOnly: true },
  { path: "/billing", id: "tenant-billing-root", label: <Trans>账单</Trans>, adminOnly: true },
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
        ? MemberForbidden
        : spec.path === "/usage"
          ? TenantUsageScreen
          : () => <Placeholder id={spec.id} label={spec.label} />,
    }),
  );
}

export { TENANT_ROUTE_SPECS };
