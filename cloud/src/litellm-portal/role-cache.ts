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
// In-memory layer
// ---------------------------------------------------------------------------

type MemEntry = {
  role: PortalRole;
  litellmUserId: string;
  expiresAt: number;
};

let memCache = new Map<string, MemEntry>();

// ---------------------------------------------------------------------------
// KV value shape
// ---------------------------------------------------------------------------

type KVValue = {
  role: PortalRole;
  litellmUserId: string;
  savedAt: number;
};

// ---------------------------------------------------------------------------
// KV error rate-limit: log once per cooldown
// ---------------------------------------------------------------------------

let kvErrorLoggedAt = 0;

function logKvErrorOnce(err: unknown): void {
  const now = Date.now();
  if (now - kvErrorLoggedAt >= KV_ERROR_COOLDOWN_MS) {
    kvErrorLoggedAt = now;
    console.error("[role-cache] KV error (will suppress for 60s):", err);
  }
}

// ---------------------------------------------------------------------------
// Singleflight: deduplicate concurrent origin fetches for same email
// ---------------------------------------------------------------------------

const inFlight = new Map<string, Promise<{ role: PortalRole; litellmUserId: string }>>();

// ---------------------------------------------------------------------------
// LiteLLM origin fetch (extracted so singleflight can wrap it)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function getRole(
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
        // Populate memory from KV hit
        memCache.set(email, { ...result, expiresAt: Date.now() + MEM_TTL_MS });
        return result;
      }
    } catch (err) {
      logKvErrorOnce(err);
      // Fall through to origin
    }
  }

  // Tier 3: origin (singleflight to prevent stampede)
  const existing = inFlight.get(email);
  if (existing !== undefined) {
    return existing;
  }

  const promise = fetchFromOrigin(env, email).then(
    async (result) => {
      inFlight.delete(email);
      // Write through to both layers
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

export async function invalidateRole(env: LiteLLMPortalEnv, email: string): Promise<void> {
  memCache.delete(email);
  if (env.ROLE_CACHE_KV !== undefined) {
    try {
      await env.ROLE_CACHE_KV.delete(`role:${email}`);
    } catch (err) {
      logKvErrorOnce(err);
    }
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

export function _resetMemoryRoleCacheForTests(): void {
  memCache = new Map();
  kvErrorLoggedAt = 0;
  inFlight.clear();
}
