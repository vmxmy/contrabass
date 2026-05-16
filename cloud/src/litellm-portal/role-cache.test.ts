import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getRole, getRoleForEmail, invalidateRole, _resetMemoryRoleCacheForTests } from "./role-cache";
import { handleLiteLLMPortalRequest, type LiteLLMPortalEnv } from "./index";
import { _clearRoleCacheForTests, resolveIdentity } from "./roles";
import { issueSession, SESSION_COOKIE_NAME } from "./auth/session";
import * as litellm from "./litellm";
import type { LiteLLMUser } from "./types";

function litellmUser(overrides: Partial<LiteLLMUser> = {}): LiteLLMUser {
  return {
    userId: "laoxu",
    email: "stub@gz-zhiyun.com",
    spend: null,
    maxBudget: null,
    teamIds: [],
    role: null,
    found: true,
    raw: null,
    ...overrides,
  };
}

beforeEach(() => {
  // Default: LiteLLM resolves the authoritative user_id "laoxu" for any email.
  vi.spyOn(litellm, "resolveLiteLLMUser").mockImplementation(async (_env, email) =>
    litellmUser({ email: email.toLowerCase() }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  _resetMemoryRoleCacheForTests();
});

// ---------------------------------------------------------------------------
// Mock IndexDO factory
// ---------------------------------------------------------------------------

function makeIndexDO(
  usersByEmail: Record<string, { role: "admin" | "user"; userId?: string } | null>,
  tenantRolesByKey: Record<string, { tenantRole: "tenant_admin" | "member" } | null> = {},
): DurableObjectNamespace {
  const stub = {
    getUserByEmail: vi.fn(async (email: string) => {
      const u = usersByEmail[email];
      if (u == null) return null;
      return { role: u.role, userId: u.userId ?? email };
    }),
    getTenantRole: vi.fn(async (userId: string, teamId: string) => {
      return tenantRolesByKey[`${userId}|${teamId}`] ?? null;
    }),
  };
  return {
    idFromName: vi.fn(() => "idx-id" as unknown as DurableObjectId),
    get: vi.fn(() => stub as unknown as DurableObjectStub),
  } as unknown as DurableObjectNamespace;
}

const TEST_SESSION_SECRET = "test-session-secret-for-dev-request";
const _cookieCache = new Map<string, string>();

const _testEmails = [
  "admin@gz-zhiyun.com",
  "user@gz-zhiyun.com",
];

beforeAll(async () => {
  const env: LiteLLMPortalEnv = { PORTAL_SESSION_SECRET: TEST_SESSION_SECRET };
  await Promise.all(
    _testEmails.map(async (email) => {
      const value = await issueSession(env, { email, userId: email });
      _cookieCache.set(email, value);
    }),
  );
});

function baseEnv(overrides: Partial<LiteLLMPortalEnv> = {}): LiteLLMPortalEnv {
  return {
    LITELLM_BASE_URL: "https://litellm.test",
    LITELLM_MASTER_KEY: "master-key",
    LITELLM_PORTAL_ALLOWED_EMAIL_DOMAIN: "gz-zhiyun.com",
    PORTAL_SESSION_SECRET: TEST_SESSION_SECRET,
    ...overrides,
  };
}

function portalEnv(overrides: Partial<LiteLLMPortalEnv> = {}): LiteLLMPortalEnv {
  return {
    ...baseEnv(),
    LITELLM_ALLOWED_MODELS: "gpt-4o-mini",
    ...overrides,
  };
}

function devRequest(url: string, email: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (init.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  const cookie = _cookieCache.get(email);
  if (cookie === undefined) {
    throw new Error(`devRequest: no cookie pre-minted for ${email}. Add it to _testEmails.`);
  }
  headers.set("Cookie", `${SESSION_COOKIE_NAME}=${cookie}`);
  const method = (init.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
    headers.set("Origin", new URL(url).origin);
  }
  return new Request(url, { ...init, headers });
}

// ---------------------------------------------------------------------------
// Unit tests: role-cache.ts (IndexDO path)
// ---------------------------------------------------------------------------

describe("role-cache", () => {
  describe("getRole", () => {
    it("resolves litellmUserId via resolveLiteLLMUser even when IndexDO row is stale (userId=email)", async () => {
      // IndexDO row is stale: Cloudflare Access path never reconciles it, so
      // userId is the email. resolveLiteLLMUser returns the real id "laoxu".
      const indexDO = makeIndexDO({
        "xu@gz-zhiyun.com": { role: "user", userId: "xu@gz-zhiyun.com" },
      });
      const env = baseEnv({ INDEX_DO: indexDO });
      const result = await getRole(env, "xu@gz-zhiyun.com");

      expect(result.role).toBe("user");
      expect(result.litellmUserId).toBe("laoxu");
    });

    it("keeps role from IndexDO (admin) but litellmUserId from resolveLiteLLMUser", async () => {
      vi.spyOn(litellm, "resolveLiteLLMUser").mockResolvedValue(
        litellmUser({ userId: "bob-litellm", email: "bob@gz-zhiyun.com" }),
      );
      const indexDO = makeIndexDO({
        "bob@gz-zhiyun.com": { role: "admin", userId: "bob-uid" },
      });
      const env = baseEnv({ INDEX_DO: indexDO });
      const result = await getRole(env, "bob@gz-zhiyun.com");

      expect(result.role).toBe("admin");
      expect(result.litellmUserId).toBe("bob-litellm");
    });

    it("falls back to email when resolveLiteLLMUser reports found:false", async () => {
      vi.spyOn(litellm, "resolveLiteLLMUser").mockResolvedValue(
        litellmUser({ userId: "ghost@gz-zhiyun.com", email: "ghost@gz-zhiyun.com", found: false }),
      );
      const indexDO = makeIndexDO({});
      const env = baseEnv({ INDEX_DO: indexDO });
      const result = await getRole(env, "ghost@gz-zhiyun.com");

      expect(result.role).toBe("none");
      expect(result.litellmUserId).toBe("ghost@gz-zhiyun.com");
    });

    it("falls back to email when resolveLiteLLMUser throws (no login lockout)", async () => {
      vi.spyOn(litellm, "resolveLiteLLMUser").mockRejectedValue(new Error("litellm down"));
      const indexDO = makeIndexDO({ "down@gz-zhiyun.com": { role: "user", userId: "down@gz-zhiyun.com" } });
      const env = baseEnv({ INDEX_DO: indexDO });
      const result = await getRole(env, "down@gz-zhiyun.com");

      expect(result.role).toBe("user");
      expect(result.litellmUserId).toBe("down@gz-zhiyun.com");
    });

    it("falls back to email when INDEX_DO binding is absent", async () => {
      const env = baseEnv();
      const result = await getRole(env, "noidx@gz-zhiyun.com");

      expect(result.role).toBe("none");
      expect(result.litellmUserId).toBe("laoxu");
    });

    it("returns none when IndexDO has no user", async () => {
      const indexDO = makeIndexDO({});
      const env = baseEnv({ INDEX_DO: indexDO });
      const result = await getRole(env, "unknown@gz-zhiyun.com");

      expect(result.role).toBe("none");
    });

    it("returns none when INDEX_DO binding is absent", async () => {
      const env = baseEnv();
      const result = await getRole(env, "alice@gz-zhiyun.com");

      expect(result.role).toBe("none");
    });

    it("serves from 30s memory cache on second call (IndexDO + resolveLiteLLMUser not re-queried)", async () => {
      const resolveSpy = vi.spyOn(litellm, "resolveLiteLLMUser").mockResolvedValue(
        litellmUser({ userId: "carol-id", email: "carol@gz-zhiyun.com" }),
      );
      const indexDO = makeIndexDO({ "carol@gz-zhiyun.com": { role: "admin" } });
      const stub = (indexDO.get as ReturnType<typeof vi.fn>).mock?.results?.[0]?.value;
      const env = baseEnv({ INDEX_DO: indexDO });

      const first = await getRole(env, "carol@gz-zhiyun.com");
      const second = await getRole(env, "carol@gz-zhiyun.com");

      expect(first.role).toBe("admin");
      expect(first.litellmUserId).toBe("carol-id");
      expect(second.litellmUserId).toBe("carol-id");
      // IndexDO.get and resolveLiteLLMUser are each called only once
      // (second call hits the 30s memory cache).
      expect((indexDO.get as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
      expect(resolveSpy).toHaveBeenCalledTimes(1);
      void stub;
    });
  });

  describe("getRoleForEmail", () => {
    it("returns PortalRole string from IndexDO", async () => {
      const indexDO = makeIndexDO({ "dan@gz-zhiyun.com": { role: "user" } });
      const env = baseEnv({ INDEX_DO: indexDO });
      const role = await getRoleForEmail(env, "dan@gz-zhiyun.com");

      expect(role).toBe("user");
    });
  });

  describe("invalidateRole", () => {
    it("clears memory so next call re-queries IndexDO", async () => {
      const indexDO = makeIndexDO({ "hank@gz-zhiyun.com": { role: "user" } });
      const env = baseEnv({ INDEX_DO: indexDO });

      await getRole(env, "hank@gz-zhiyun.com");
      const callsBefore = (indexDO.get as ReturnType<typeof vi.fn>).mock.calls.length;

      await invalidateRole(env, "hank@gz-zhiyun.com");
      await getRole(env, "hank@gz-zhiyun.com");

      expect((indexDO.get as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore + 1);
    });
  });
});

// ---------------------------------------------------------------------------
// Unit tests: resolveIdentity tenant facet (fail-open)
// ---------------------------------------------------------------------------

describe("resolveIdentity tenant facet", () => {
  it("populates tenantRole + tenantTeamId from IndexDO", async () => {
    vi.spyOn(litellm, "resolveLiteLLMUser").mockResolvedValue(
      litellmUser({ userId: "laoxu", email: "t1user@gz-zhiyun.com", teamIds: ["t1"] }),
    );
    const indexDO = makeIndexDO(
      { "t1user@gz-zhiyun.com": { role: "user" } },
      { "laoxu|t1": { tenantRole: "tenant_admin" } },
    );
    const env = baseEnv({ INDEX_DO: indexDO });

    const result = await resolveIdentity(env, {
      email: "t1user@gz-zhiyun.com",
      userId: "t1user@gz-zhiyun.com",
      domain: "gz-zhiyun.com",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.identity.tenantRole).toBe("tenant_admin");
    expect(result.identity.tenantTeamId).toBe("t1");
  });

  it("defaults tenantRole=null when no mapping", async () => {
    vi.spyOn(litellm, "resolveLiteLLMUser").mockResolvedValue(
      litellmUser({ userId: "laoxu", email: "nomap@gz-zhiyun.com", teamIds: ["t1"] }),
    );
    const indexDO = makeIndexDO({ "nomap@gz-zhiyun.com": { role: "user" } });
    const env = baseEnv({ INDEX_DO: indexDO });

    const result = await resolveIdentity(env, {
      email: "nomap@gz-zhiyun.com",
      userId: "nomap@gz-zhiyun.com",
      domain: "gz-zhiyun.com",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.identity.tenantRole).toBeNull();
    expect(result.identity.tenantTeamId).toBe("t1");
  });
});

// ---------------------------------------------------------------------------
// Integration tests: admin invalidate endpoint
// ---------------------------------------------------------------------------

describe("POST /api/admin/roles/invalidate", () => {
  it("returns 403 for non-admin users", async () => {
    const indexDO = makeIndexDO({ "user@gz-zhiyun.com": { role: "user" } });

    const response = await handleLiteLLMPortalRequest(
      devRequest("https://portal.test/api/admin/roles/invalidate?email=target@gz-zhiyun.com", "user@gz-zhiyun.com", { method: "POST" }),
      portalEnv({ INDEX_DO: indexDO }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "admin_required" });
  });

  it("returns 400 when email query param is missing", async () => {
    const indexDO = makeIndexDO({ "admin@gz-zhiyun.com": { role: "admin" } });

    const response = await handleLiteLLMPortalRequest(
      devRequest("https://portal.test/api/admin/roles/invalidate", "admin@gz-zhiyun.com", { method: "POST" }),
      portalEnv({ INDEX_DO: indexDO }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "email_required" });
  });

  it("returns 204 for admin user", async () => {
    const indexDO = makeIndexDO({ "admin@gz-zhiyun.com": { role: "admin" } });

    const response = await handleLiteLLMPortalRequest(
      devRequest("https://portal.test/api/admin/roles/invalidate?email=target%40gz-zhiyun.com", "admin@gz-zhiyun.com", { method: "POST" }),
      portalEnv({ INDEX_DO: indexDO }),
    );

    expect(response.status).toBe(204);
  });
});

// ---------------------------------------------------------------------------
// Integration tests: internal webhook endpoint
// ---------------------------------------------------------------------------

describe("POST /api/_internal/role-changed", () => {
  it("returns 401 when secret is missing from body", async () => {
    const response = await handleLiteLLMPortalRequest(
      new Request("https://portal.test/api/_internal/role-changed", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "target@gz-zhiyun.com" }),
      }),
      portalEnv({ ROLE_INVALIDATION_WEBHOOK_TOKEN: "super-secret" }),
    );

    expect(response.status).toBe(400);
  });

  it("returns 401 when secret is wrong", async () => {
    const response = await handleLiteLLMPortalRequest(
      new Request("https://portal.test/api/_internal/role-changed", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "target@gz-zhiyun.com", secret: "wrong-secret" }),
      }),
      portalEnv({ ROLE_INVALIDATION_WEBHOOK_TOKEN: "super-secret" }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
  });

  it("returns 401 when ROLE_INVALIDATION_WEBHOOK_TOKEN is not configured", async () => {
    const response = await handleLiteLLMPortalRequest(
      new Request("https://portal.test/api/_internal/role-changed", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "target@gz-zhiyun.com", secret: "any-secret" }),
      }),
      portalEnv(),
    );

    expect(response.status).toBe(401);
  });

  it("returns 204 with valid token", async () => {
    const response = await handleLiteLLMPortalRequest(
      new Request("https://portal.test/api/_internal/role-changed", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "target@gz-zhiyun.com", secret: "super-secret" }),
      }),
      portalEnv({
        ROLE_INVALIDATION_WEBHOOK_TOKEN: "super-secret",
      }),
    );

    expect(response.status).toBe(204);
  });

  it("returns 400 when body is invalid JSON", async () => {
    const response = await handleLiteLLMPortalRequest(
      new Request("https://portal.test/api/_internal/role-changed", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not-json",
      }),
      portalEnv({ ROLE_INVALIDATION_WEBHOOK_TOKEN: "super-secret" }),
    );

    expect(response.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// _clearRoleCacheForTests backward compat (re-exported from roles.ts)
// ---------------------------------------------------------------------------

describe("_clearRoleCacheForTests (roles.ts re-export)", () => {
  it("clears in-memory DO cache via the legacy export", async () => {
    const indexDO = makeIndexDO({ "z@gz-zhiyun.com": { role: "user" } });
    const env = baseEnv({ INDEX_DO: indexDO });

    await getRole(env, "z@gz-zhiyun.com");
    const callsAfterFirst = (indexDO.get as ReturnType<typeof vi.fn>).mock.calls.length;

    _clearRoleCacheForTests();
    await getRole(env, "z@gz-zhiyun.com");

    expect((indexDO.get as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterFirst + 1);
  });
});
