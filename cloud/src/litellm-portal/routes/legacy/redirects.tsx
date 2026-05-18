/**
 * F5/D5 — legacy-redirect SPA-side fallback (NOT the authority).
 *
 * The single source of truth for legacy `/admin/*` and `/preferences`
 * redirects is the worker-layer `legacyPortalRedirectTarget` in
 * `litellm-portal/index.ts`, which 302s on full-page navigation before the
 * SPA loads. This TanStack route table is the intentionally-layered fallback
 * for client-side (SPA) navigations that never reach the worker. Its targets
 * MUST stay consistent with the worker mappings — any change to the worker
 * authority MUST be mirrored here (enforced by
 * `redirects-single-source.test.ts`).
 */
import { createRoute, redirect } from "@tanstack/react-router";
import { rootRoute } from "../__root";

function RedirectPlaceholder() {
  return null;
}

function redirectRoute(path: string, href: string) {
  return createRoute({
    getParentRoute: () => rootRoute,
    path,
    beforeLoad: () => {
      throw redirect({ href, replace: true });
    },
    component: RedirectPlaceholder,
  });
}

export const legacyAdminRoute = redirectRoute("/admin", "/");
export const legacyAdminUsageRoute = redirectRoute("/admin/usage", "/");
export const legacyAdminUsersRoute = redirectRoute("/admin/users", "/manage/users");
export const legacyAdminTeamsRoute = redirectRoute("/admin/teams", "/manage/teams");
export const legacyAdminAuditRoute = redirectRoute("/admin/audit", "/manage/audit");
export const legacyAdminSettingsRoute = redirectRoute("/admin/settings", "/manage/settings");
export const legacyPreferencesRoute = redirectRoute("/preferences", "/manage/preferences");

export const legacyAdminUserDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/users/$userId",
  beforeLoad: ({ params }) => {
    throw redirect({ href: `/manage/users/${encodeURIComponent(params.userId)}`, replace: true });
  },
  component: RedirectPlaceholder,
});

export const legacyAdminTeamDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/teams/$teamId",
  beforeLoad: ({ params }) => {
    throw redirect({ href: `/manage/teams/${encodeURIComponent(params.teamId)}`, replace: true });
  },
  component: RedirectPlaceholder,
});

export const legacyAdminAuditEventRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/audit/$eventId",
  beforeLoad: ({ params }) => {
    throw redirect({ href: `/manage/audit/${encodeURIComponent(params.eventId)}`, replace: true });
  },
  component: RedirectPlaceholder,
});
