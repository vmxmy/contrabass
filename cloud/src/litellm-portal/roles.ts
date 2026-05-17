import { getRole, _resetMemoryRoleCacheForTests } from "./role-cache";
import type { IdentityResult, LiteLLMPortalEnv, PortalPrincipal } from "./types";

export async function resolveIdentity(
  env: LiteLLMPortalEnv,
  principal: PortalPrincipal,
): Promise<IdentityResult> {
  try {
    const { role, litellmUserId, tenantRole, tenantTeamId } = await getRole(
      env,
      principal.email,
    );
    return {
      ok: true,
      identity: { ...principal, litellmUserId, role, tenantRole, tenantTeamId },
    };
  } catch (error) {
    if (error instanceof Error && error.message === "litellm_config_missing") {
      throw error;
    }
    return {
      ok: true,
      identity: {
        ...principal,
        litellmUserId: principal.email,
        role: "none",
        tenantRole: null,
        tenantTeamId: null,
      },
    };
  }
}

export function _clearRoleCacheForTests(): void {
  _resetMemoryRoleCacheForTests();
}
