/**
 * Operations Console route subtree.
 *
 * A single pathless layout route (`id: "ops-layout"`) owns `OpsConsoleShell`
 * (steel accent, Owner gate, ops nav) and an `<Outlet />`; the seven `/ops*`
 * screen routes are its children. Mounting a pathless layout — rather than a
 * `/ops`-pathed parent — keeps the `/ops` index path itself a child so the
 * shell never double-wraps, and lets `router.tsx` add the whole subtree under
 * `rootRoute` without colliding with `/`, `/manage/*`, or the Phase-1 tenant
 * subtree.
 *
 * The Owner gate plus the M-NEW-1 undefined-me handling live in `OpsLayout`:
 * before `useMe()` resolves we render a loading root (NOT a 403) so a
 * still-loading identity is never mistaken for an unauthorized one — that
 * would flash a forbidden card for a legitimate Owner on every cold load.
 */
import React from "react";
import { createRoute, Outlet, type AnyRoute } from "@tanstack/react-router";
import { Loader } from "@cloudflare/kumo/components/loader";
import { Trans } from "@lingui/react/macro";
import { useMe } from "../hooks/use-me";
import { OpsConsoleShell } from "./shell";
import type { PortalIdentity } from "../types";
import type { Me } from "../schemas";
import { OpsTenantOverviewScreen } from "./screens/tenant-overview";
import { OpsProvisioningScreen } from "./screens/provisioning";
import { OpsGlobalUsageScreen } from "./screens/global-usage";
import { OpsAuditScreen } from "./screens/audit";
import { OpsPlatformSettingsScreen } from "./screens/platform-settings";
import { OpsTenantDetailScreen } from "./screens/tenant-detail";
import { OpsUserDetailScreen } from "./screens/user-detail";

function toPortalIdentity(me: Me): PortalIdentity {
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
 * Pathless layout for the Operations Console.
 *
 * Identity is derived purely from the hydrated `useMe()` query — no
 * `window`/`document`/effect state controls the first render, so SSR and the
 * client hydration render pick the SAME tree (#418-safe).
 *
 * M-NEW-1: while `me` is undefined we render the loading root, NOT the 403
 * card. The Owner-vs-forbidden decision is delegated to `OpsConsoleShell` once
 * a real identity exists.
 */
function OpsLayout() {
  const { data: me } = useMe();

  if (me === undefined) {
    return (
      <div id="ops-console-loading-root" className="py-12">
        <Loader aria-label="正在加载运营控制台" />
        <span className="sr-only">
          <Trans>正在加载运营控制台</Trans>
        </span>
      </div>
    );
  }

  return (
    <OpsConsoleShell identity={toPortalIdentity(me)}>
      <Outlet />
    </OpsConsoleShell>
  );
}

type OpsRouteSpec = {
  path: string;
  id: string;
  component: React.ComponentType;
};

const OPS_ROUTE_SPECS: OpsRouteSpec[] = [
  { path: "/ops", id: "ops-tenant-overview", component: OpsTenantOverviewScreen },
  { path: "/ops/provisioning", id: "ops-provisioning", component: OpsProvisioningScreen },
  { path: "/ops/usage", id: "ops-global-usage", component: OpsGlobalUsageScreen },
  { path: "/ops/audit", id: "ops-audit", component: OpsAuditScreen },
  { path: "/ops/audit/$eventId", id: "ops-audit-event", component: OpsAuditScreen },
  { path: "/ops/settings", id: "ops-platform-settings", component: OpsPlatformSettingsScreen },
  { path: "/ops/tenants/$teamId", id: "ops-tenant-detail", component: OpsTenantDetailScreen },
  { path: "/ops/users/$userId", id: "ops-user-detail", component: OpsUserDetailScreen },
];

/**
 * Build the Operations Console subtree under `parentRoute`.
 *
 * Returns the single pathless layout route (with its screen children already
 * attached) so the caller does `parentRoute.addChildren([opsLayoutRoute])`.
 * The layout route is `id`-only (no `path`), so it never matches a URL on its
 * own — only its children's `/ops*` paths do.
 */
export function createOpsConsoleRoutes(parentRoute: AnyRoute) {
  const opsLayoutRoute = createRoute({
    getParentRoute: () => parentRoute,
    id: "ops-layout",
    component: OpsLayout,
  });

  const children = OPS_ROUTE_SPECS.map((spec) =>
    createRoute({
      getParentRoute: () => opsLayoutRoute,
      path: spec.path,
      component: spec.component,
    }),
  );

  return opsLayoutRoute.addChildren(children);
}

export { OPS_ROUTE_SPECS, OpsLayout };
