import { firstString, litellmFetch } from "./litellm";
import type { LiteLLMPortalEnv, PortalRole } from "./types";
import { isRecord, readJson } from "./utils";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MEM_TTL_MS = 30 * 1000; // 30 seconds
const KV_TTL_S = 5 * 60; // 5 minutes
const KV_ERROR_COOLDOWN_MS = 60 * 1000; // log KV errors at most once per minute

// ---------------------------------------------------------------------------
// LiteLLM path — in-memory + KV + singleflight
// ---------------------------------------------------------------------------

type MemEntry = {
  role: PortalRole;
  litellmUserId: string;
  expiresAt: number;
};

let memCache = new Map<string, MemEntry>();

type KVValue = {
  role: PortalRole;
  litellmUserId: string;
  savedAt: number;
};

let kvErrorLoggedAt = 0;

function logKvErrorOnce(err: unknown): void {
  const now = Date.now();
  if (now - kvErrorLoggedAt >= KV_ERROR_COOLDOWN_MS) {
    kvErrorLoggedAt = now;
    console.error("[role-cache] KV error (will suppress for 60s):", err);
  }
}

const inFlight = new Map<string, Promise<{ role: PortalRole; litellmUserId: string }>>();

function extractUsers(body: unknown): Record<string, unknown>[] {
  if (!isRecord(body)) return [];
  const users = body.users;
  if (!Array.isArray(users)) return [];
  return users.filter(isRecord);
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

async function fetchFromOrigin(
  env: LiteLLMPortalEnv,
  email: string,
): Promise<{ role: PortalRole; litellmUserId: string }> {
  const response = await litellmFetch(
    env,
    `/user/list?user_email=${encodeURIComponent(email)}`,
  );
  const body = await readJson(response);
  const match = extractUsers(body).find((record) => {
    const userEmail = firstString(record, ["user_email", "userEmail", "email"]);
    return userEmail?.trim().toLowerCase() === email;
  });
  const record = match ?? {};
  const rawRole = firstString(record, ["user_role", "userRole", "role"]);
  const role = projectRole(rawRole);
  const litellmUserId = firstString(record, ["user_id", "userId", "id"]) ?? email;
  return { role, litellmUserId };
}

async function getRoleViaLiteLLM(
  env: LiteLLMPortalEnv,
  email: string,
): Promise<{ role: PortalRole; litellmUserId: string }> {
  // Tier 1: memory
  const memEntry = memCache.get(email);
  if (memEntry !== undefined && memEntry.expiresAt > Date.now()) {
    return { role: memEntry.role, litellmUserId: memEntry.litellmUserId };
  }

  // Tier 2: KV
  if (env.ROLE_CACHE_KV !== undefined) {
    try {
      const raw = await env.ROLE_CACHE_KV.get(`role:${email}`);
      if (raw !== null) {
        const parsed = JSON.parse(raw) as KVValue;
        const result = { role: parsed.role, litellmUserId: parsed.litellmUserId };
        memCache.set(email, { ...result, expiresAt: Date.now() + MEM_TTL_MS });
        return result;
      }
    } catch (err) {
      logKvErrorOnce(err);
    }
  }

  // Tier 3: origin (singleflight)
  const existing = inFlight.get(email);
  if (existing !== undefined) {
    return existing;
  }

  const promise = fetchFromOrigin(env, email).then(
    async (result) => {
      inFlight.delete(email);
      memCache.set(email, { ...result, expiresAt: Date.now() + MEM_TTL_MS });
      if (env.ROLE_CACHE_KV !== undefined) {
        const kvValue: KVValue = { ...result, savedAt: Date.now() };
        try {
          await env.ROLE_CACHE_KV.put(`role:${email}`, JSON.stringify(kvValue), {
            expirationTtl: KV_TTL_S,
          });
        } catch (err) {
          logKvErrorOnce(err);
        }
      }
      return result;
    },
    (err: unknown) => {
      inFlight.delete(email);
      throw err;
    },
  );

  inFlight.set(email, promise);
  return promise;
}

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
 *  When PORTAL_DO_SOT_ENABLED="true": sources from IndexDO with a 30s in-process cache.
 *  Otherwise: sources from LiteLLM /user/list with in-process + KV + singleflight caching. */
export async function getRoleForEmail(env: LiteLLMPortalEnv, email: string): Promise<PortalRole> {
  if (env.PORTAL_DO_SOT_ENABLED === "true") {
    return getRoleViaIndexDO(env, email);
  }
  const { role } = await getRoleViaLiteLLM(env, email);
  return role;
}

export async function getRole(
  env: LiteLLMPortalEnv,
  email: string,
): Promise<{ role: PortalRole; litellmUserId: string }> {
  if (env.PORTAL_DO_SOT_ENABLED === "true") {
    const role = await getRoleViaIndexDO(env, email);
    return { role, litellmUserId: email };
  }
  return getRoleViaLiteLLM(env, email);
}

export async function invalidateRole(env: LiteLLMPortalEnv, email: string): Promise<void> {
  // Clear both caches regardless of flag so a flag flip during a session stays consistent.
  memCache.delete(email);
  doCache.delete(email.toLowerCase());
  if (env.ROLE_CACHE_KV !== undefined) {
    try {
      await env.ROLE_CACHE_KV.delete(`role:${email}`);
    } catch (err) {
      logKvErrorOnce(err);
    }
  }
}

/** Test helper: clear the in-process cache. Used by unit tests / hot reload. */
export function clearRoleCache(): void {
  memCache = new Map();
  kvErrorLoggedAt = 0;
  inFlight.clear();
  doCache.clear();
}

export function _resetMemoryRoleCacheForTests(): void {
  memCache = new Map();
  kvErrorLoggedAt = 0;
  inFlight.clear();
  doCache.clear();
}
