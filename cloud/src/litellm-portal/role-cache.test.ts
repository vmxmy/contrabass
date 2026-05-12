import { afterEach, describe, expect, it, vi } from "vitest";
import { getRole, invalidateRole, _resetMemoryRoleCacheForTests } from "./role-cache";
import { handleLiteLLMPortalRequest, type LiteLLMPortalEnv } from "./index";
import { _clearRoleCacheForTests } from "./roles";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  _resetMemoryRoleCacheForTests();
});

// ---------------------------------------------------------------------------
// Mock KV factory
// ---------------------------------------------------------------------------

function makeMemoryKV(): LiteLLMPortalEnv["ROLE_CACHE_KV"] & { _store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    _store: store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => { store.set(key, value); }),
    delete: vi.fn(async (key: string) => { store.delete(key); }),
  };
}

function baseEnv(overrides: Partial<LiteLLMPortalEnv> = {}): LiteLLMPortalEnv {
  return {
    LITELLM_BASE_URL: "https://litellm.test",
    LITELLM_MASTER_KEY: "master-key",
    CLOUDFLARE_ACCESS_AUD: "access-aud",
    CLOUDFLARE_ACCESS_TEAM_DOMAIN: "https://gz-zhiyun.cloudflareaccess.com",
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
// Unit tests: role-cache.ts
// ---------------------------------------------------------------------------

describe("role-cache", () => {
  describe("getRole", () => {
    it("fetches from origin when memory and KV are both empty", async () => {
      let fetchCount = 0;
      globalThis.fetch = async (input) => {
        const url = String(input);
        if (url.includes("/user/list")) {
          fetchCount++;
          return Response.json({
            users: [{ user_email: "alice@gz-zhiyun.com", user_role: "internal_user", user_id: "uid-alice" }],
          });
        }
        return new Response("not found", { status: 404 });
      };

      const env = baseEnv();
      const result = await getRole(env, "alice@gz-zhiyun.com");

      expect(result.role).toBe("user");
      expect(result.litellmUserId).toBe("uid-alice");
      expect(fetchCount).toBe(1);
    });

    it("returns from memory cache on second call without hitting origin again", async () => {
      let fetchCount = 0;
      globalThis.fetch = async (input) => {
        if (String(input).includes("/user/list")) {
          fetchCount++;
          return Response.json({
            users: [{ user_email: "bob@gz-zhiyun.com", user_role: "proxy_admin", user_id: "uid-bob" }],
          });
        }
        return new Response("not found", { status: 404 });
      };

      const env = baseEnv();
      const first = await getRole(env, "bob@gz-zhiyun.com");
      const second = await getRole(env, "bob@gz-zhiyun.com");

      expect(first.role).toBe("admin");
      expect(second.role).toBe("admin");
      expect(fetchCount).toBe(1);
    });

    it("reads from KV when memory is empty and KV has a valid entry", async () => {
      let fetchCount = 0;
      globalThis.fetch = async (input) => {
        if (String(input).includes("/user/list")) {
          fetchCount++;
          return Response.json({ users: [] });
        }
        return new Response("not found", { status: 404 });
      };

      const kv = makeMemoryKV();
      kv._store.set("role:carol@gz-zhiyun.com", JSON.stringify({
        role: "admin",
        litellmUserId: "uid-carol",
        savedAt: Date.now(),
      }));

      const env = baseEnv({ ROLE_CACHE_KV: kv });
      const result = await getRole(env, "carol@gz-zhiyun.com");

      expect(result.role).toBe("admin");
      expect(result.litellmUserId).toBe("uid-carol");
      expect(fetchCount).toBe(0);
    });

    it("writes through to KV after origin fetch", async () => {
      globalThis.fetch = async (input) => {
        if (String(input).includes("/user/list")) {
          return Response.json({
            users: [{ user_email: "dan@gz-zhiyun.com", user_role: "internal_user", user_id: "uid-dan" }],
          });
        }
        return new Response("not found", { status: 404 });
      };

      const kv = makeMemoryKV();
      const env = baseEnv({ ROLE_CACHE_KV: kv });
      await getRole(env, "dan@gz-zhiyun.com");

      expect(kv.put).toHaveBeenCalledOnce();
      const [key, value] = (kv.put as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string, unknown];
      expect(key).toBe("role:dan@gz-zhiyun.com");
      const parsed = JSON.parse(value) as { role: string; litellmUserId: string; savedAt: number };
      expect(parsed.role).toBe("user");
      expect(parsed.litellmUserId).toBe("uid-dan");
    });

    it("singleflight: 100 concurrent calls trigger exactly 1 LiteLLM fetch", async () => {
      let fetchCount = 0;
      globalThis.fetch = async (input) => {
        if (String(input).includes("/user/list")) {
          fetchCount++;
          return Response.json({
            users: [{ user_email: "eve@gz-zhiyun.com", user_role: "proxy_admin", user_id: "uid-eve" }],
          });
        }
        return new Response("not found", { status: 404 });
      };

      const env = baseEnv();
      const results = await Promise.all(
        Array.from({ length: 100 }, () => getRole(env, "eve@gz-zhiyun.com")),
      );

      expect(fetchCount).toBe(1);
      for (const r of results) {
        expect(r.role).toBe("admin");
        expect(r.litellmUserId).toBe("uid-eve");
      }
    });

    it("falls back gracefully when KV throws on get", async () => {
      let fetchCount = 0;
      globalThis.fetch = async (input) => {
        if (String(input).includes("/user/list")) {
          fetchCount++;
          return Response.json({
            users: [{ user_email: "frank@gz-zhiyun.com", user_role: "internal_user", user_id: "uid-frank" }],
          });
        }
        return new Response("not found", { status: 404 });
      };

      const kv: LiteLLMPortalEnv["ROLE_CACHE_KV"] = {
        get: vi.fn(async () => { throw new Error("kv_unavailable"); }),
        put: vi.fn(async () => {}),
        delete: vi.fn(async () => {}),
      };

      const env = baseEnv({ ROLE_CACHE_KV: kv });
      const result = await getRole(env, "frank@gz-zhiyun.com");

      expect(result.role).toBe("user");
      expect(fetchCount).toBe(1);
    });

    it("falls back gracefully when KV throws on put", async () => {
      globalThis.fetch = async (input) => {
        if (String(input).includes("/user/list")) {
          return Response.json({
            users: [{ user_email: "grace@gz-zhiyun.com", user_role: "internal_user", user_id: "uid-grace" }],
          });
        }
        return new Response("not found", { status: 404 });
      };

      const kv: LiteLLMPortalEnv["ROLE_CACHE_KV"] = {
        get: vi.fn(async () => null),
        put: vi.fn(async () => { throw new Error("kv_write_failed"); }),
        delete: vi.fn(async () => {}),
      };

      const env = baseEnv({ ROLE_CACHE_KV: kv });
      const result = await getRole(env, "grace@gz-zhiyun.com");

      expect(result.role).toBe("user");
      expect(result.litellmUserId).toBe("uid-grace");
    });
  });

  describe("invalidateRole", () => {
    it("clears memory so next call goes to origin", async () => {
      let fetchCount = 0;
      globalThis.fetch = async (input) => {
        if (String(input).includes("/user/list")) {
          fetchCount++;
          return Response.json({
            users: [{ user_email: "hank@gz-zhiyun.com", user_role: "internal_user", user_id: "uid-hank" }],
          });
        }
        return new Response("not found", { status: 404 });
      };

      const env = baseEnv();
      await getRole(env, "hank@gz-zhiyun.com");
      expect(fetchCount).toBe(1);

      await invalidateRole(env, "hank@gz-zhiyun.com");
      await getRole(env, "hank@gz-zhiyun.com");
      expect(fetchCount).toBe(2);
    });

    it("deletes KV entry on invalidate", async () => {
      globalThis.fetch = async () => Response.json({ users: [] });

      const kv = makeMemoryKV();
      kv._store.set("role:ivan@gz-zhiyun.com", JSON.stringify({
        role: "admin",
        litellmUserId: "uid-ivan",
        savedAt: Date.now(),
      }));

      const env = baseEnv({ ROLE_CACHE_KV: kv });
      await invalidateRole(env, "ivan@gz-zhiyun.com");

      expect(kv.delete).toHaveBeenCalledWith("role:ivan@gz-zhiyun.com");
      expect(kv._store.has("role:ivan@gz-zhiyun.com")).toBe(false);
    });

    it("survives KV delete errors silently", async () => {
      const kv: LiteLLMPortalEnv["ROLE_CACHE_KV"] = {
        get: vi.fn(async () => null),
        put: vi.fn(async () => {}),
        delete: vi.fn(async () => { throw new Error("kv_delete_failed"); }),
      };

      const env = baseEnv({ ROLE_CACHE_KV: kv });
      await expect(invalidateRole(env, "judy@gz-zhiyun.com")).resolves.toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Integration tests: admin invalidate endpoint
// ---------------------------------------------------------------------------

describe("POST /api/admin/roles/invalidate", () => {
  it("returns 403 for non-admin users", async () => {
    globalThis.fetch = async (input) => {
      if (String(input).includes("/user/list")) {
        return Response.json({
          users: [{ user_email: "user@gz-zhiyun.com", user_role: "internal_user", user_id: "uid-user" }],
        });
      }
      return new Response("not found", { status: 404 });
    };

    const response = await handleLiteLLMPortalRequest(
      devRequest("https://portal.test/api/admin/roles/invalidate?email=target@gz-zhiyun.com", "user@gz-zhiyun.com", { method: "POST" }),
      portalEnv({ LITELLM_PORTAL_DEV_AUTH: "true" }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "admin_required" });
  });

  it("returns 400 when email query param is missing", async () => {
    globalThis.fetch = async (input) => {
      if (String(input).includes("/user/list")) {
        return Response.json({
          users: [{ user_email: "admin@gz-zhiyun.com", user_role: "proxy_admin", user_id: "uid-admin" }],
        });
      }
      return new Response("not found", { status: 404 });
    };

    const response = await handleLiteLLMPortalRequest(
      devRequest("https://portal.test/api/admin/roles/invalidate", "admin@gz-zhiyun.com", { method: "POST" }),
      portalEnv({ LITELLM_PORTAL_DEV_AUTH: "true" }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "email_required" });
  });

  it("returns 204 and clears both cache layers for admin", async () => {
    const kv = makeMemoryKV();
    kv._store.set("role:target@gz-zhiyun.com", JSON.stringify({
      role: "admin",
      litellmUserId: "uid-target",
      savedAt: Date.now(),
    }));

    let litellmCallCount = 0;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes("/user/list?user_email=admin%40gz-zhiyun.com")) {
        return Response.json({
          users: [{ user_email: "admin@gz-zhiyun.com", user_role: "proxy_admin", user_id: "uid-admin" }],
        });
      }
      if (url.includes("/user/list?user_email=target%40gz-zhiyun.com")) {
        litellmCallCount++;
        return Response.json({ users: [] });
      }
      return new Response("not found", { status: 404 });
    };

    const env = portalEnv({ LITELLM_PORTAL_DEV_AUTH: "true", ROLE_CACHE_KV: kv });

    // Pre-populate memory for target
    await getRole(env, "target@gz-zhiyun.com");
    _resetMemoryRoleCacheForTests();
    // Put it back only in KV
    kv._store.set("role:target@gz-zhiyun.com", JSON.stringify({
      role: "admin",
      litellmUserId: "uid-target",
      savedAt: Date.now(),
    }));

    const response = await handleLiteLLMPortalRequest(
      devRequest("https://portal.test/api/admin/roles/invalidate?email=target%40gz-zhiyun.com", "admin@gz-zhiyun.com", { method: "POST" }),
      env,
    );

    expect(response.status).toBe(204);
    expect(kv._store.has("role:target@gz-zhiyun.com")).toBe(false);
    expect(kv.delete).toHaveBeenCalledWith("role:target@gz-zhiyun.com");
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

  it("returns 204 and invalidates cache with valid token", async () => {
    const kv = makeMemoryKV();
    kv._store.set("role:target@gz-zhiyun.com", JSON.stringify({
      role: "admin",
      litellmUserId: "uid-target",
      savedAt: Date.now(),
    }));

    const response = await handleLiteLLMPortalRequest(
      new Request("https://portal.test/api/_internal/role-changed", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "target@gz-zhiyun.com", secret: "super-secret" }),
      }),
      portalEnv({
        ROLE_CACHE_KV: kv,
        ROLE_INVALIDATION_WEBHOOK_TOKEN: "super-secret",
      }),
    );

    expect(response.status).toBe(204);
    expect(kv._store.has("role:target@gz-zhiyun.com")).toBe(false);
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
  it("clears in-flight and memory state via the legacy export", async () => {
    let fetchCount = 0;
    globalThis.fetch = async (input) => {
      if (String(input).includes("/user/list")) {
        fetchCount++;
        return Response.json({
          users: [{ user_email: "z@gz-zhiyun.com", user_role: "internal_user", user_id: "uid-z" }],
        });
      }
      return new Response("not found", { status: 404 });
    };

    const env = baseEnv();
    await getRole(env, "z@gz-zhiyun.com");
    expect(fetchCount).toBe(1);

    _clearRoleCacheForTests();
    await getRole(env, "z@gz-zhiyun.com");
    expect(fetchCount).toBe(2);
  });
});
