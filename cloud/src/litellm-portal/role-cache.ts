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
 *  IndexDO.getUserByEmail returns the full UserRecord; we read `role`, `userId`
 *  (the stored LiteLLM user_id), and `teamId` (the portal-authoritative tenant
 *  team — same tuple the invite auto-join seeds the tenantRole under). */
type IndexDOStub = {
  getUserByEmail(
    email: string,
  ): Promise<{ role: "admin" | "user"; userId: string; teamId: string | null } | null>;
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
 * Resolve the authoritative LiteLLM user_id for an email (self-scope spend).
 *
 * This portal authenticates via Cloudflare Access (no magic-link), so the
 * IndexDO row that `getRole` reads is never reconciled and its `userId` is the
 * stale email. Spend/usage events are keyed by the real LiteLLM user_id (e.g.
 * `laoxu`), so self-scope queries must use `resolveLiteLLMUser`'s value.
 *
 * Falls back to the email when LiteLLM is unreachable or has no match — never
 * locks the user out (the caller's catch path still applies).
 *
 * NOTE: the tenant facet (tenantRole/tenantTeamId) does NOT use this. Tenant
 * keys are derived from the portal-authoritative IndexDO user record so the
 * read tuple matches the write tuple seeded at invite-consume time (the
 * LiteLLM team list is eventually-consistent and multi-team-ambiguous).
 */
async function resolveLitellmUserId(env: LiteLLMPortalEnv, email: string): Promise<string> {
  try {
    const user = await resolveLiteLLMUser(env, email);
    return user.found && user.userId.trim().length > 0 ? user.userId : email;
  } catch {
    return email;
  }
}

/**
 * Resolve the tenant role using the SAME (userId, teamId) tuple the invite
 * auto-join seeds (login-routes.ts: `putTenantRole({ userId, teamId:
 * invite.teamId })`). Both facets come from the portal-authoritative IndexDO
 * user record, so the read key is consistent with the write key. Fail-open:
 * any error → null; the platform role path is unaffected.
 */
async function resolveTenantRole(
  env: LiteLLMPortalEnv,
  tenantUserId: string | null,
  tenantTeamId: string | null,
): Promise<TenantRole> {
  try {
    if (env.INDEX_DO && tenantUserId && tenantTeamId) {
      const idxStub = env.INDEX_DO.get(
        env.INDEX_DO.idFromName("index"),
      ) as unknown as IndexDOStub;
      const rec = await idxStub.getTenantRole(tenantUserId, tenantTeamId);
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
  // The tenant facet keys (tenantUserId, tenantTeamId) come from the SAME
  // IndexDO user record — the portal-authoritative tuple the invite auto-join
  // seeds the tenantRole under — so the read key matches the write key.
  let role: PortalRole = "none";
  let tenantUserId: string | null = null;
  let tenantTeamId: string | null = null;
  if (env.INDEX_DO) {
    const idxStub = env.INDEX_DO.get(env.INDEX_DO.idFromName("index")) as unknown as IndexDOStub;
    const user = await idxStub.getUserByEmail(key);
    role = user == null ? "none" : (user.role as PortalRole);
    if (user != null) {
      tenantUserId = user.userId;
      tenantTeamId = user.teamId;
    }
  }
  const litellmUserId = await resolveLitellmUserId(env, key);
  const tenantRole = await resolveTenantRole(env, tenantUserId, tenantTeamId);
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
