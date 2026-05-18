import type { PortalRole } from "./types";

const LITELLM_OWNER_ROLE = "proxy_admin";
const LITELLM_VIEWER_ROLE = "proxy_admin_viewer";

/**
 * THE single LiteLLM `user_role` → portal tier chokepoint. LiteLLM is the sole
 * source of truth for the platform role; there is no IndexDO / bootstrap-env /
 * cache fallback.
 *
 *   proxy_admin         → "admin"        (full owner: read + write + impersonate)
 *   proxy_admin_viewer  → "admin_viewer" (read-only owner: no write, no impersonate)
 *   any other non-empty → "user"
 *   null / empty        → "none"
 *
 * PURE FAIL-CLOSED: when LiteLLM cannot tell us the role (unreachable AND the
 * identity map missed), `litellmRole` is null and this returns "none" — no
 * access. Accepted operational consequence (explicit decision): a LiteLLM
 * outage demotes every admin, and a fresh deployment with no `proxy_admin` in
 * LiteLLM has nobody who can administer the portal until one exists.
 * `BOOTSTRAP_ADMIN_EMAILS` no longer grants authority.
 */
export function litellmRoleToTier(litellmRole: string | null): PortalRole {
  if (litellmRole === LITELLM_OWNER_ROLE) return "admin";
  if (litellmRole === LITELLM_VIEWER_ROLE) return "admin_viewer";
  if (litellmRole !== null && litellmRole.trim().length > 0) return "user";
  return "none";
}

export type MapLiteLLMRoleInput = {
  /** LiteLLM `user_role` (resolveLiteLLMUser .role / identity map .userRole);
   *  null when absent/unreachable. */
  litellmRole: string | null;
  /** LiteLLM team ids (resolveLiteLLMUser .teamIds). */
  litellmTeamIds: string[];
  /** Portal-authoritative invite-seeded team id from IndexDO; null when none.
   *  The tenant facet is NOT LiteLLM-sourced (LiteLLM has no tenant concept). */
  indexTeamId?: string | null;
};

export type MapLiteLLMRoleResult = {
  role: PortalRole;
  /** IndexDO invite team wins; else first LiteLLM team; else null. */
  tenantTeamId: string | null;
};

export function mapLiteLLMRole(input: MapLiteLLMRoleInput): MapLiteLLMRoleResult {
  const role = litellmRoleToTier(input.litellmRole);
  const tenantTeamId =
    input.indexTeamId != null && input.indexTeamId.length > 0
      ? input.indexTeamId
      : input.litellmTeamIds.length > 0
        ? input.litellmTeamIds[0]
        : null;
  return { role, tenantTeamId };
}
