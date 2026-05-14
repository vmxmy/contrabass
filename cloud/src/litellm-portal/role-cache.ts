import type { LiteLLMPortalEnv, PortalRole } from "./types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MEM_TTL_MS = 30 * 1000; // 30 seconds

// ---------------------------------------------------------------------------
// IndexDO path — 30-second in-process memory cache
// ---------------------------------------------------------------------------

/** Minimal RPC surface we need from IndexDO without dragging in the DO module. */
type IndexDOStub = {
  getUserByEmail(email: string): Promise<{ role: "admin" | "user" } | null>;
};

type DOCacheEntry = { role: PortalRole; expiresAt: number };
const doCache = new Map<string, DOCacheEntry>();

async function getRoleViaIndexDO(env: LiteLLMPortalEnv, email: string): Promise<PortalRole> {
  const key = email.toLowerCase();
  const now = Date.now();
  const cached = doCache.get(key);
  if (cached && cached.expiresAt > now) return cached.role;

  if (!env.INDEX_DO) return "none";
  const idxStub = env.INDEX_DO.get(env.INDEX_DO.idFromName("index")) as unknown as IndexDOStub;
  const user = await idxStub.getUserByEmail(key);
  const role: PortalRole = user == null ? "none" : (user.role as PortalRole);
  doCache.set(key, { role, expiresAt: now + MEM_TTL_MS });
  return role;
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
  const role = await getRoleViaIndexDO(env, email);
  return { role, litellmUserId: email };
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
