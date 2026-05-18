import type { LiteLLMPortalEnv, PortalRole } from "./types";
import type { IdentityMapRecord } from "./durable/schemas";
import { resolveLiteLLMUser } from "./litellm";
import { mapLiteLLMRole } from "./role-mapping";

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
  getIdentityByEmail(email: string): Promise<IdentityMapRecord | null>;
  putIdentity(record: IdentityMapRecord): Promise<void>;
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
 * Spend/usage events are keyed by the real LiteLLM user_id (e.g. `laoxu`),
 * which is arbitrary and not derivable from the email. The durable identity
 * map is the source of truth: read it first (no LiteLLM round-trip, and it
 * survives the Cloudflare-Access path that never ran the magic-link
 * reconcile). On a miss, resolve live via /user/list and persist the result
 * (origin "recorded") so the next request — and the reconcile cron — build on
 * it instead of repeating the fragile lookup.
 *
 * Falls back to the email only when both the map misses AND LiteLLM is
 * unreachable/empty — never locks the user out (caller's catch still applies).
 *
 * NOTE: the tenant facet (tenantRole/tenantTeamId) does NOT use this. Tenant
 * keys are derived from the portal-authoritative IndexDO user record so the
 * read tuple matches the write tuple seeded at invite-consume time (the
 * LiteLLM team list is eventually-consistent and multi-team-ambiguous).
 */
async function resolveLitellmFacts(
  env: LiteLLMPortalEnv,
  email: string,
  idxStub: IndexDOStub | null,
): Promise<{ userId: string; role: string | null; teamIds: string[] }> {
  const emailLc = email.trim().toLowerCase();
  if (idxStub) {
    try {
      const identity = await idxStub.getIdentityByEmail(emailLc);
      if (identity && identity.litellmUserId.trim().length > 0) {
        return {
          userId: identity.litellmUserId,
          role: identity.userRole,
          teamIds: identity.teams,
        };
      }
    } catch (err) {
      console.warn("[role-cache] getIdentityByEmail failed (non-fatal):", String(err).slice(0, 120));
    }
  }

  try {
    const user = await resolveLiteLLMUser(env, email);
    if (user.found && user.userId.trim().length > 0) {
      if (idxStub) {
        try {
          await idxStub.putIdentity({
            emailLc,
            litellmUserId: user.userId,
            teams: user.teamIds,
            userRole: user.role,
            origin: "recorded",
            lastReconciledAt: new Date().toISOString(),
          });
        } catch (err) {
          console.warn("[role-cache] putIdentity failed (non-fatal):", String(err).slice(0, 120));
        }
      }
      return { userId: user.userId, role: user.role, teamIds: user.teamIds };
    }
    return { userId: email, role: user.role, teamIds: user.teamIds };
  } catch {
    return { userId: email, role: null, teamIds: [] };
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
  let indexRole: PortalRole = "none";
  let tenantUserId: string | null = null;
  let indexTeamId: string | null = null;
  // One stub per DO per resolution — shared by the role read, the identity-map
  // resolve, and the persist-on-miss write (avoids redundant .get() round-trips).
  const idxStub: IndexDOStub | null = env.INDEX_DO
    ? (env.INDEX_DO.get(env.INDEX_DO.idFromName("index")) as unknown as IndexDOStub)
    : null;
  if (idxStub) {
    const user = await idxStub.getUserByEmail(key);
    indexRole = user == null ? "none" : (user.role as PortalRole);
    if (user != null) {
      tenantUserId = user.userId;
      indexTeamId = user.teamId;
    }
  }
  const facts = await resolveLitellmFacts(env, key, idxStub);
  const mapped = mapLiteLLMRole({
    indexRole,
    litellmRole: facts.role,
    litellmTeamIds: facts.teamIds,
    indexTeamId,
  });
  const role = mapped.role;
  const tenantTeamId = mapped.tenantTeamId;
  const litellmUserId = facts.userId;
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
