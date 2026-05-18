import type { PortalRole } from "./types";

const LITELLM_OWNER_ROLES = new Set(["proxy_admin"]);

export type MapLiteLLMRoleInput = {
  /** Role resolved from IndexDO (portal-authoritative for non-admin). */
  indexRole: PortalRole;
  /** LiteLLM `user_role` (resolveLiteLLMUser .role); null when absent. */
  litellmRole: string | null;
  /** LiteLLM team ids (resolveLiteLLMUser .teamIds). */
  litellmTeamIds: string[];
  /** Portal-authoritative invite-seeded team id from IndexDO; null when none. */
  indexTeamId?: string | null;
};

export type MapLiteLLMRoleResult = {
  role: PortalRole;
  /** IndexDO teamId wins; else first LiteLLM team; else null. */
  tenantTeamId: string | null;
};

export function mapLiteLLMRole(input: MapLiteLLMRoleInput): MapLiteLLMRoleResult {
  const role: PortalRole =
    input.litellmRole !== null && LITELLM_OWNER_ROLES.has(input.litellmRole)
      ? "admin"
      : input.indexRole;

  const tenantTeamId =
    input.indexTeamId != null && input.indexTeamId.length > 0
      ? input.indexTeamId
      : input.litellmTeamIds.length > 0
        ? input.litellmTeamIds[0]
        : null;

  return { role, tenantTeamId };
}
