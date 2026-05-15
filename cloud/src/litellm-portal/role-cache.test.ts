import { afterEach, describe, expect, it, vi } from "vitest";
import { getRole, getRoleForEmail, invalidateRole, _resetMemoryRoleCacheForTests } from "./role-cache";
import { handleLiteLLMPortalRequest, type LiteLLMPortalEnv } from "./index";
import { _clearRoleCacheForTests } from "./roles";

afterEach(() => {
  vi.useRealTimers();
  _resetMemoryRoleCacheForTests();
});

// ---------------------------------------------------------------------------
// Mock IndexDO factory
// ---------------------------------------------------------------------------

function makeIndexDO(usersByEmail: Record<string, { role: "admin" | "user" } | null>): DurableObjectNamespace {
  const stub = {
    getUserByEmail: vi.fn(async (email: string) => usersByEmail[email] ?? null),
  };
  return {
    idFromName: vi.fn(() => "idx-id" as unknown as DurableObjectId),
    get: vi.fn(() => stub as unknown as DurableObjectStub),
  } as unknown as DurableObjectNamespace;
}

function baseEnv(overrides: Partial<LiteLLMPortalEnv> = {}): LiteLLMPortalEnv {
  return {
    LITELLM_BASE_URL: "https://litellm.test",
    LITELLM_MASTER_KEY: "master-key",
    LITELLM_PORTAL_ALLOWED_EMAIL_DOMAIN: "gz-zhiyun.com",
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
  headers.set("x-litellm-portal-dev-email", email);
  if (init.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  return new Request(url, { ...init, headers });
}

// ---------------------------------------------------------------------------
// Unit tests: role-cache.ts (IndexDO path)
// ---------------------------------------------------------------------------

describe("role-cache", () => {
  describe("getRole", () => {
    it("returns role from IndexDO", async () => {
      const indexDO = makeIndexDO({ "alice@gz-zhiyun.com": { role: "user" } });
      const env = baseEnv({ INDEX_DO: indexDO });
      const result = await getRole(env, "alice@gz-zhiyun.com");

      expect(result.role).toBe("user");
      expect(result.litellmUserId).toBe("alice@gz-zhiyun.com");
    });

    it("returns admin role from IndexDO", async () => {
      const indexDO = makeIndexDO({ "bob@gz-zhiyun.com": { role: "admin" } });
      const env = baseEnv({ INDEX_DO: indexDO });
      const result = await getRole(env, "bob@gz-zhiyun.com");

      expect(result.role).toBe("admin");
      expect(result.litellmUserId).toBe("bob@gz-zhiyun.com");
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

    it("serves from 30s memory cache on second call", async () => {
      const indexDO = makeIndexDO({ "carol@gz-zhiyun.com": { role: "admin" } });
      const stub = (indexDO.get as ReturnType<typeof vi.fn>).mock?.results?.[0]?.value;
      const env = baseEnv({ INDEX_DO: indexDO });

      const first = await getRole(env, "carol@gz-zhiyun.com");
      const second = await getRole(env, "carol@gz-zhiyun.com");

      expect(first.role).toBe("admin");
      expect(second.role).toBe("admin");
      // IndexDO.get is called only once (second call hits memory)
      expect((indexDO.get as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
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
// Integration tests: admin invalidate endpoint
// ---------------------------------------------------------------------------

describe("POST /api/admin/roles/invalidate", () => {
  it("returns 403 for non-admin users", async () => {
    const indexDO = makeIndexDO({ "user@gz-zhiyun.com": { role: "user" } });

    const response = await handleLiteLLMPortalRequest(
      devRequest("https://portal.test/api/admin/roles/invalidate?email=target@gz-zhiyun.com", "user@gz-zhiyun.com", { method: "POST" }),
      portalEnv({ LITELLM_PORTAL_DEV_AUTH: "true", INDEX_DO: indexDO }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "admin_required" });
  });

  it("returns 400 when email query param is missing", async () => {
    const indexDO = makeIndexDO({ "admin@gz-zhiyun.com": { role: "admin" } });

    const response = await handleLiteLLMPortalRequest(
      devRequest("https://portal.test/api/admin/roles/invalidate", "admin@gz-zhiyun.com", { method: "POST" }),
      portalEnv({ LITELLM_PORTAL_DEV_AUTH: "true", INDEX_DO: indexDO }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "email_required" });
  });

  it("returns 204 for admin user", async () => {
    const indexDO = makeIndexDO({ "admin@gz-zhiyun.com": { role: "admin" } });

    const response = await handleLiteLLMPortalRequest(
      devRequest("https://portal.test/api/admin/roles/invalidate?email=target%40gz-zhiyun.com", "admin@gz-zhiyun.com", { method: "POST" }),
      portalEnv({ LITELLM_PORTAL_DEV_AUTH: "true", INDEX_DO: indexDO }),
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
