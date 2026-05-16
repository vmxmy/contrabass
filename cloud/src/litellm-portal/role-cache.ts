import type { LiteLLMPortalEnv, PortalRole } from "./types";
import { resolveLiteLLMUser } from "./litellm";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MEM_TTL_MS = 30 * 1000; // 30 seconds

// ---------------------------------------------------------------------------
// IndexDO path — 30-second in-process memory cache
// ---------------------------------------------------------------------------

/** Minimal RPC surface we need from IndexDO without dragging in the DO module.
 *  IndexDO.getUserByEmail returns the full UserRecord; we only read `role` and
 *  `userId` here (the stored LiteLLM user_id). */
type IndexDOStub = {
  getUserByEmail(email: string): Promise<{ role: "admin" | "user"; userId: string } | null>;
  getTenantRole(
    userId: string,
    teamId: string,
  ): Promise<{ tenantRole: "tenant_admin" | "member" } | null>;
};

type TenantRole = "tenant_admin" | "member" | null;

type DOCacheEntry = {
  role: PortalRole;
  litellmUserId: string | null;
  tenantRole: TenantRole;
  tenantTeamId: string | null;
  expiresAt: number;
};
const doCache = new Map<string, DOCacheEntry>();

/**
 * Resolve the authoritative LiteLLM user_id for an email.
 *
 * This portal authenticates via Cloudflare Access (no magic-link), so the
 * IndexDO row that `getRole` reads is never reconciled and its `userId` is the
 * stale email. Spend/usage events are keyed by the real LiteLLM user_id (e.g.
 * `laoxu`), so self-scope queries must use `resolveLiteLLMUser`'s value.
 *
 * Falls back to the email when LiteLLM is unreachable or has no match — never
 * locks the user out (the caller's catch path still applies).
 */
async function resolveLitellmUserAndTeam(
  env: LiteLLMPortalEnv,
  email: string,
): Promise<{ litellmUserId: string; tenantTeamId: string | null }> {
  try {
    const user = await resolveLiteLLMUser(env, email);
    const litellmUserId =
      user.found && user.userId.trim().length > 0 ? user.userId : email;
    const tenantTeamId = user.teamIds.find((id) => id.trim().length > 0)?.trim() ?? null;
    return { litellmUserId, tenantTeamId };
  } catch {
    return { litellmUserId: email, tenantTeamId: null };
  }
}

async function resolveTenantRole(
  env: LiteLLMPortalEnv,
  litellmUserId: string | null,
  tenantTeamId: string | null,
): Promise<TenantRole> {
  try {
    if (env.INDEX_DO && litellmUserId && tenantTeamId) {
      const idxStub = env.INDEX_DO.get(
        env.INDEX_DO.idFromName("index"),
      ) as unknown as IndexDOStub;
      const rec = await idxStub.getTenantRole(litellmUserId, tenantTeamId);
      return rec?.tenantRole ?? null;
    }
  } catch (err) {
    // fail-open for the tenant facet; platform role unaffected
    console.warn("[role-cache] getTenantRole failed (non-fatal):", String(err).slice(0, 120));
  }
  return null;
}

async function resolveRoleAndUserId(
  env: LiteLLMPortalEnv,
  email: string,
): Promise<{
  role: PortalRole;
  litellmUserId: string | null;
  tenantRole: TenantRole;
  tenantTeamId: string | null;
}> {
  const key = email.toLowerCase();
  const now = Date.now();
  const cached = doCache.get(key);
  if (cached && cached.expiresAt > now) {
    return {
      role: cached.role,
      litellmUserId: cached.litellmUserId,
      tenantRole: cached.tenantRole,
      tenantTeamId: cached.tenantTeamId,
    };
  }

  // Role comes from IndexDO/role-cache (fast). litellmUserId is resolved
  // authoritatively via LiteLLM /user/list so it is auth-path-independent.
  let role: PortalRole = "none";
  if (env.INDEX_DO) {
    const idxStub = env.INDEX_DO.get(env.INDEX_DO.idFromName("index")) as unknown as IndexDOStub;
    const user = await idxStub.getUserByEmail(key);
    role = user == null ? "none" : (user.role as PortalRole);
  }
  const { litellmUserId, tenantTeamId } = await resolveLitellmUserAndTeam(env, key);
  const tenantRole = await resolveTenantRole(env, litellmUserId, tenantTeamId);
  doCache.set(key, {
    role,
    litellmUserId,
    tenantRole,
    tenantTeamId,
    expiresAt: now + MEM_TTL_MS,
  });
  return { role, litellmUserId, tenantRole, tenantTeamId };
}

async function getRoleViaIndexDO(env: LiteLLMPortalEnv, email: string): Promise<PortalRole> {
  return (await resolveRoleAndUserId(env, email)).role;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Resolve the portal role for an email.
 *  Sources from IndexDO with a 30s in-process cache. */
export async function getRoleForEmail(env: LiteLLMPortalEnv, email: string): Promise<PortalRole> {
  return getRoleViaIndexDO(env, email);
}

export async function getRole(
  env: LiteLLMPortalEnv,
  email: string,
): Promise<{
  role: PortalRole;
  litellmUserId: string;
  tenantRole: TenantRole;
  tenantTeamId: string | null;
}> {
  const { role, litellmUserId, tenantRole, tenantTeamId } = await resolveRoleAndUserId(
    env,
    email,
  );
  return { role, litellmUserId: litellmUserId ?? email, tenantRole, tenantTeamId };
}

export async function invalidateRole(env: LiteLLMPortalEnv, email: string): Promise<void> {
  doCache.delete(email.toLowerCase());
}

/** Test helper: clear the in-process cache. Used by unit tests / hot reload. */
export function clearRoleCache(): void {
  doCache.clear();
}

export function _resetMemoryRoleCacheForTests(): void {
  doCache.clear();
}
