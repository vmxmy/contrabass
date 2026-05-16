import type { LiteLLMPortalEnv, PortalRole } from "./types";

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
};

type DOCacheEntry = { role: PortalRole; litellmUserId: string | null; expiresAt: number };
const doCache = new Map<string, DOCacheEntry>();

async function resolveRoleAndUserId(
  env: LiteLLMPortalEnv,
  email: string,
): Promise<{ role: PortalRole; litellmUserId: string | null }> {
  const key = email.toLowerCase();
  const now = Date.now();
  const cached = doCache.get(key);
  if (cached && cached.expiresAt > now) {
    return { role: cached.role, litellmUserId: cached.litellmUserId };
  }

  if (!env.INDEX_DO) return { role: "none", litellmUserId: null };
  const idxStub = env.INDEX_DO.get(env.INDEX_DO.idFromName("index")) as unknown as IndexDOStub;
  const user = await idxStub.getUserByEmail(key);
  const role: PortalRole = user == null ? "none" : (user.role as PortalRole);
  const litellmUserId: string | null =
    user != null && typeof user.userId === "string" && user.userId.length > 0
      ? user.userId
      : null;
  doCache.set(key, { role, litellmUserId, expiresAt: now + MEM_TTL_MS });
  return { role, litellmUserId };
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
): Promise<{ role: PortalRole; litellmUserId: string }> {
  const { role, litellmUserId } = await resolveRoleAndUserId(env, email);
  return { role, litellmUserId: litellmUserId ?? email };
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
