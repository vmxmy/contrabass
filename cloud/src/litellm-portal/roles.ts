import { firstString, litellmFetch } from "./litellm";
import type { IdentityResult, LiteLLMPortalEnv, PortalIdentity, PortalPrincipal, PortalRole } from "./types";
import { isRecord, readJson } from "./utils";

const ROLE_CACHE_MS = 5 * 60 * 1000;
const roleCache = new Map<string, { role: PortalRole; litellmUserId: string; expiresAt: number }>();

export async function resolveIdentity(
  env: LiteLLMPortalEnv,
  principal: PortalPrincipal,
): Promise<IdentityResult> {
  const cacheKey = principal.email;
  const cached = roleCache.get(cacheKey);
  if (cached !== undefined && cached.expiresAt > Date.now()) {
    return {
      ok: true,
      identity: {
        ...principal,
        litellmUserId: cached.litellmUserId,
        role: cached.role,
      },
    };
  }

  try {
    const response = await litellmFetch(
      env,
      `/v2/user/info?user_id=${encodeURIComponent(principal.email)}`,
    );
    const body = await readJson(response);
    const record = isRecord(body) ? body : {};
    const rawRole = firstString(record, ["user_role", "userRole", "role"]);
    const role = projectRole(rawRole);
    const litellmUserId = firstString(record, ["user_id", "userId", "id"]) ?? principal.email;
    roleCache.set(cacheKey, { role, litellmUserId, expiresAt: Date.now() + ROLE_CACHE_MS });
    return {
      ok: true,
      identity: { ...principal, litellmUserId, role },
    };
  } catch (error) {
    if (error instanceof Error && error.message === "litellm_config_missing") {
      throw error;
    }
    return {
      ok: true,
      identity: { ...principal, litellmUserId: principal.email, role: "none" },
    };
  }
}

function projectRole(rawRole: string | undefined): PortalRole {
  switch (rawRole) {
    case "proxy_admin":
    case "proxy_admin_viewer":
      return "admin";
    case "internal_user":
    case "internal_user_viewer":
    case "team":
    case "customer":
      return "user";
    default:
      return "none";
  }
}

export function _clearRoleCacheForTests(): void {
  roleCache.clear();
}
