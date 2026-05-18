import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "./routes";
import { issueSession, SESSION_COOKIE_NAME } from "./auth/session";
import { _clearRoleCacheForTests } from "./roles";
import type { LiteLLMPortalEnv } from "./types";

const ADMIN_EMAIL = "admin@gz-zhiyun.com";
const USER_EMAIL = "bob@gz-zhiyun.com";
const SESSION_SECRET = "test-secret-32bytes-paddedXXXXXX";

const ROLES: Record<string, { role: "admin" | "user" }> = {
  [ADMIN_EMAIL]: { role: "admin" },
  [USER_EMAIL]: { role: "user" },
};

function makeIndexDO(): DurableObjectNamespace {
  const stub = {
    getUserByEmail: vi.fn(async (email: string) => ROLES[email] ?? null),
    // Mapped identity: a real (non-"@") LiteLLM user_id slug, so self-scope
    // usage resolves to a mapped user (not the email-fallback "unmapped" path).
    getIdentityByEmail: vi.fn(async (email: string) => {
      const r = ROLES[email];
      if (!r) return null;
      return {
        emailLc: email.toLowerCase(),
        litellmUserId: email.split("@")[0],
        teams: [],
        userRole: r.role === "admin" ? "proxy_admin" : "internal_user",
        origin: "recorded" as const,
        lastReconciledAt: new Date().toISOString(),
      };
    }),
    putIdentity: vi.fn(async () => {}),
    listTeams: vi.fn(async () => [{ id: "t1", alias: "alpha" }]),
    listAllUsers: vi.fn(async () => ({
      users: [
        { userId: ADMIN_EMAIL, email: ADMIN_EMAIL, role: "admin" as const, maxBudget: 100 },
        { userId: USER_EMAIL, email: USER_EMAIL, role: "user" as const, maxBudget: 50 },
      ],
      cursor: undefined,
    })),
  };
  return {
    idFromName: vi.fn(() => "idx-id" as unknown as DurableObjectId),
    get: vi.fn(() => stub as unknown as DurableObjectStub),
  } as unknown as DurableObjectNamespace;
}

function makeEnv(): LiteLLMPortalEnv {
  return {
    PORTAL_SESSION_SECRET: SESSION_SECRET,
    PORTAL_ALLOWED_EMAIL_DOMAINS: "gz-zhiyun.com",
    LITELLM_BASE_URL: "https://litellm.test",
    LITELLM_MASTER_KEY: "k",
    INDEX_DO: makeIndexDO(),
  } as unknown as LiteLLMPortalEnv;
}

async function cookie(env: LiteLLMPortalEnv, email: string): Promise<string> {
  return `${SESSION_COOKIE_NAME}=${await issueSession(env, { email, userId: email })}`;
}

const day = (d: string, spend: number, reqs: number) => ({
  date: d,
  metrics: { spend, api_requests: reqs, total_tokens: reqs * 2 },
  breakdown: { models: { gpt: { metrics: { spend, api_requests: reqs, total_tokens: reqs * 2 } } } },
});

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  _clearRoleCacheForTests();
  vi.restoreAllMocks();
});

describe("usage overview HTTP routes", () => {
  it("GET /api/usage/overview without auth cookie -> 401", async () => {
    // #given an env with no session cookie on the request
    const env = makeEnv();
    // #when the unauthenticated request hits the auth-gated route
    const res = await app.fetch(new Request("https://x/api/usage/overview"), env);
    // #then the auth middleware rejects before any LiteLLM call
    expect(res.status).toBe(401);
  });

  it("GET /api/usage/overview?window=90d (authed) -> 400 unsupported_usage_window", async () => {
    // #given an authenticated non-admin user requesting an unsupported window
    const env = makeEnv();
    const req = new Request("https://x/api/usage/overview?window=90d", {
      headers: { Cookie: await cookie(env, USER_EMAIL) },
    });
    // #when parseDashboardRequest validates the window before any LiteLLM call
    const res = await app.fetch(req, env);
    // #then the request is rejected deterministically
    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, unknown>).error).toBe("unsupported_usage_window");
  });

  it("GET /api/admin/usage/overview as non-admin -> 403", async () => {
    // #given an authenticated user without the admin role
    const env = makeEnv();
    const req = new Request("https://x/api/admin/usage/overview", {
      headers: { Cookie: await cookie(env, USER_EMAIL) },
    });
    // #when the admin gate runs before the handler
    const res = await app.fetch(req, env);
    // #then access is denied
    expect(res.status).toBe(403);
  });

  describe("happy-path 200 contract (LiteLLM mocked available)", () => {
    beforeEach(() => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ results: [day("2026-05-16", 7, 70), day("2026-05-15", 5, 50)] }), {
            status: 200,
          }),
        );
    });

    it("self overview -> 200 scope=self, available, kpi/trend/models, no recent/hourOfDay", async () => {
      // #given an authenticated self user with LiteLLM returning daily-activity data
      const env = makeEnv();
      const req = new Request("https://x/api/usage/overview?window=7d", {
        headers: { Cookie: await cookie(env, USER_EMAIL) },
      });
      // #when the dashboard is built from the live LiteLLM source
      const res = await app.fetch(req, env);
      // #then the new self contract is returned
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.scope).toBe("self");
      expect(body.available).toBe(true);
      expect(body).toHaveProperty("kpi");
      expect(body).toHaveProperty("trend");
      expect(body).toHaveProperty("models");
      expect(body).not.toHaveProperty("recent");
      expect(body).not.toHaveProperty("hourOfDay");
    });

    it("admin global overview -> 200 scope=global, perUser+summary, no recent/hourOfDay", async () => {
      // #given an authenticated admin with LiteLLM returning aggregated data
      const env = makeEnv();
      const req = new Request("https://x/api/admin/usage/overview?window=7d", {
        headers: { Cookie: await cookie(env, ADMIN_EMAIL) },
      });
      // #when the admin dashboard is built from the live LiteLLM source
      const res = await app.fetch(req, env);
      // #then the new global contract is returned
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.scope).toBe("global");
      expect(body).toHaveProperty("perUser");
      expect(body).toHaveProperty("summary");
      expect(body).not.toHaveProperty("recent");
      expect(body).not.toHaveProperty("hourOfDay");
    });
  });
});
