import React from "react";
import { createRoute } from "@tanstack/react-router";
import { Text } from "@cloudflare/kumo/components/text";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { rootRoute } from "./__root";
import { useMe } from "../hooks/use-me";
import { TenantPortalShell } from "../tenant-portal/shell";
import { TenantOverviewScreen } from "../tenant-portal/screens/overview";
import { FOCUS_RING } from "../a11y/focus";
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
 * Driven solely by the hydrated `useMe()` query. When authenticated,
 * `renderPortalSSR` seeds `ME_QUERY_KEY` into the server QueryClient and
 * dehydrates it; the client rehydrates the same data via `HydrationBoundary`,
 * so the authenticated server first render and client hydration render resolve
 * identical `me` and pick the SAME tree (#418-safe). When UNAUTHENTICATED,
 * `server-impl.tsx` does NOT seed `ME_QUERY_KEY` (no identity) → `useMe()` is
 * `undefined` on BOTH server and client first render → `<UserView />` (the
 * §D restyled public welcome) renders deterministically on both sides
 * (#418-safe by construction; `UserView` is fully static — no
 * Math.random/Date/window). No `window`/`document`/effect controls the first
 * render in either branch.
 *
 * Authenticated identity → `TenantPortalShell` (renders the
 * tenant_admin/member nav variants and the pure-Owner Phase-2 notice).
 * `me === undefined` (logged-out OR the brief auth-resolving window — `useMe`
 * exposes no signal to tell them apart, Phase-3 §D) → the restyled
 * `UserView` branded welcome (NOT the legacy fake-$0.00 dashboard).
 */
function PortalIndex() {
  const { data: me } = useMe();

  if (me === undefined) {
    return <UserView />;
  }

  return (
    <TenantPortalShell
      identity={toPortalIdentity(me)}
      brand={toTenantBrand(me)}
      impersonation={me.impersonation ?? null}
    >
      {/* Phase 1 Task 8: Overview screen wired as the `/` home body. */}
      <TenantOverviewScreen />
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

/**
 * Public welcome — the SSR-emitted `/` state when `me === undefined`
 * (logged-out visitor OR the brief auth-resolving window; useMe() exposes no
 * signal to tell them apart — Phase-3 §D, locked). Fully STATIC and
 * deterministic: NO Math.random / Date / window / effect controlling the first
 * render, so SSR === client first render (#418-safe by construction — the
 * same OQ-(b) discipline; this view has zero dynamic content so it needs no
 * useHasHydrated/SsrSafeSkeleton gate). Never shows data/PII/$-amounts to a
 * logged-out visitor — it is a branded welcome + a clear sign-in CTA, NOT a
 * dashboard. Once `me` resolves, PortalIndex swaps to the §B TenantPortalShell
 * (unchanged); the brief pre-resolve flash is now this branded welcome instead
 * of the legacy fake-$0.00 dashboard.
 */
export function UserView() {
  return (
    <main
      id="portal-welcome-root"
      className="mx-auto flex min-h-[60vh] max-w-2xl flex-col items-center justify-center gap-6 px-6 py-16 text-center motion-safe:transition-opacity motion-safe:duration-150"
    >
      <div className="flex flex-col items-center gap-3">
        <Text as="h1" variant="heading1" className="text-kumo-strong">
          <Trans>智云 AI 管理平台</Trans>
        </Text>
        <Text as="p" variant="secondary" className="max-w-prose text-kumo-subtle">
          <Trans>面向团队的 AI 能力自助台。请登录以查看你的用量、密钥与团队管理。</Trans>
        </Text>
      </div>
      {/*
        PLAIN native <a> (FIX 1) — NOT Kumo LinkButton/Button. Escapes the
        LinkProvider/TanStack interception so the browser performs a native
        GET to the server-only /login handler. Styled with the sanctioned
        Kumo-primary utility class string (brand bg + inverse text + pill +
        FOCUS_RING; §B.0-safe: Kumo tokens only, NO shadow-*). This class
        string mirrors DESIGN.md's button-primary contract; keep it as the
        single inline constant below so the visual matches the §B primary CTA.
      */}
      <a
        href="/login"
        aria-label={t`登录`}
        className={`inline-flex items-center justify-center rounded-full bg-kumo-brand px-5 py-2.5 text-sm font-semibold text-kumo-inverse no-underline hover:bg-kumo-brand-hover ${FOCUS_RING}`}
      >
        <Trans>登录</Trans>
      </a>
    </main>
  );
}
