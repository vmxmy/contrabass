import { firstString, litellmFetch } from "./litellm";
import type { IdentityResult, LiteLLMPortalEnv, PortalIdentity, PortalPrincipal, PortalRole } from "./types";
import { isRecord, readJson } from "./utils";

function extractUsers(body: unknown): Record<string, unknown>[] {
  if (!isRecord(body)) return [];
  const users = body.users;
  if (!Array.isArray(users)) return [];
  return users.filter(isRecord);
}

// ROLE_CACHE_MS 是 per-isolate 内存缓存的 TTL。
// 这意味着:
// 1) 同一 Worker isolate 内,同一用户 5 分钟内只会被解析一次。
// 2) 多个 Worker isolate 之间不共享缓存,role 变更生效时间最长滞后 ROLE_CACHE_MS。
// 3) 当用户被从 admin 降级时,已缓存该身份的 isolate 在 ROLE_CACHE_MS 内仍会放行 /api/admin/*。
//    紧急吊销时应旋转 LITELLM_MASTER_KEY 或强制重启 Worker。
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
      `/user/list?user_email=${encodeURIComponent(principal.email)}`,
    );
    const body = await readJson(response);
    const match = extractUsers(body).find((record) => {
      const userEmail = firstString(record, ["user_email", "userEmail", "email"]);
      return userEmail?.trim().toLowerCase() === principal.email;
    });
    const record = match ?? {};
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
