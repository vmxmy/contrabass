import React from "react";
import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "./__root";
import { IdentityBar } from "../identity-bar";
import { UsageDashboard } from "../dashboard/views/usage-dashboard";
import { useMe } from "../hooks/use-me";
import { TenantPortalShell } from "../tenant-portal/shell";
import type { PortalIdentity } from "../types";
import type { Me } from "../schemas";

export const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: PortalIndex,
});

/**
 * `/` shell selection.
 *
 * Driven solely by the hydrated `useMe()` query. `renderPortalSSR` seeds
 * `ME_QUERY_KEY` into the server QueryClient and dehydrates it; the client
 * rehydrates the same data via `HydrationBoundary`. So the server's first
 * render and the client's hydration render resolve identical `me` data and the
 * branch below picks the SAME tree on both sides (#418-safe). No
 * `window`/`document`/effect state controls the first render.
 *
 * Authenticated identity → `TenantPortalShell` (the shell itself renders the
 * tenant_admin/member nav variants and the pure-Owner Phase-2 notice).
 * `me` not yet resolved → the legacy `UserView` body (unchanged prior
 * behavior); since SSR always seeds `me`, this is only the pre-data state and
 * is identical on server and client.
 */
function PortalIndex() {
  const { data: me } = useMe();

  if (me === undefined) {
    return <UserView />;
  }

  return (
    <TenantPortalShell identity={toPortalIdentity(me)} brand={toTenantBrand(me)}>
      {null}
    </TenantPortalShell>
  );
}

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

function toTenantBrand(me: Me) {
  return { name: me.company, logoUrl: null, primaryColor: null };
}

function UserView() {
  return (
    <>
      <IdentityBar />

      <section id="usage-panel-root" className="mb-14">
        <UsageDashboard />
      </section>
    </>
  );
}
