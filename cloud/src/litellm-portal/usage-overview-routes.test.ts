import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "./routes";
import { issueSession, SESSION_COOKIE_NAME } from "./auth/session";
import { _clearRoleCacheForTests } from "./roles";
import type { LiteLLMPortalEnv } from "./types";

const ADMIN_EMAIL = "admin@gz-zhiyun.com";
const USER_EMAIL = "bob@gz-zhiyun.com";
const SESSION_SECRET = "test-secret-32bytes-paddedXXXXXX";

const USERS = [
  {
    userId: ADMIN_EMAIL,
    email: ADMIN_EMAIL,
    role: "admin" as const,
    teamId: "t1",
    createdAt: new Date().toISOString(),
  },
  { userId: USER_EMAIL, email: USER_EMAIL, role: "user" as const, teamId: "t1", createdAt: new Date().toISOString() },
];

function emptyArrays() {
  return {
    queryTimeseries: vi.fn().mockResolvedValue([]),
    queryModelBreakdown: vi.fn().mockResolvedValue([]),
    queryHourOfDay: vi
      .fn()
      .mockResolvedValue(Array.from({ length: 24 }, (_, h) => ({ hour: h, totalTokens: 0, requests: 0, spend: 0 }))),
    queryPerUserSeries: vi.fn().mockResolvedValue([]),
    queryRecentEvents: vi.fn().mockResolvedValue([]),
    queryKpiWithDelta: vi.fn().mockResolvedValue({
      current: { spend: 0, requests: 0, totalTokens: 0 },
      previous: { spend: 0, requests: 0, totalTokens: 0 },
    }),
  };
}

function makeEnv(): LiteLLMPortalEnv {
  const indexStub = {
    listTeams: vi.fn().mockResolvedValue([{ id: "t1", alias: "a" }]),
    listAllUsers: vi.fn().mockResolvedValue({ users: USERS, cursor: undefined }),
    getUserByEmail: vi.fn(async (e: string) => USERS.find((u) => u.email === e) ?? null),
    getUserById: vi.fn(async (i: string) => USERS.find((u) => u.userId === i) ?? null),
  };
  return {
    PORTAL_SESSION_SECRET: SESSION_SECRET,
    PORTAL_ALLOWED_EMAIL_DOMAINS: "gz-zhiyun.com",
    LITELLM_BASE_URL: "https://litellm.test",
    LITELLM_MASTER_KEY: "k",
    INDEX_DO: {
      idFromName: vi.fn().mockReturnValue({}),
      get: vi.fn().mockReturnValue(indexStub),
    } as unknown as DurableObjectNamespace,
    USAGE_DO: {
      idFromName: vi.fn().mockReturnValue({}),
      get: vi.fn().mockReturnValue(emptyArrays()),
    } as unknown as DurableObjectNamespace,
  } as unknown as LiteLLMPortalEnv;
}

async function cookie(env: LiteLLMPortalEnv, email: string): Promise<string> {
  return `${SESSION_COOKIE_NAME}=${await issueSession(env, { email, userId: email })}`;
}

afterEach(() => {
  _clearRoleCacheForTests();
  vi.restoreAllMocks();
});

describe("usage overview endpoints", () => {
  it("GET /api/usage/overview requires auth (401 without cookie)", async () => {
    const env = makeEnv();
    const res = await app.fetch(new Request("https://x/api/usage/overview"), env);
    expect(res.status).toBe(401);
  });

  it("self overview returns available + self scope, no perUser", async () => {
    const env = makeEnv();
    const req = new Request("https://x/api/usage/overview?window=7d", {
      headers: { Cookie: await cookie(env, USER_EMAIL) },
    });
    const res = await app.fetch(req, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.scope).toBe("self");
    expect(body.available).toBe(true);
    expect(body).not.toHaveProperty("perUser");
  });

  it("invalid window -> 400", async () => {
    const env = makeEnv();
    const req = new Request("https://x/api/usage/overview?window=90d", {
      headers: { Cookie: await cookie(env, USER_EMAIL) },
    });
    const res = await app.fetch(req, env);
    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, unknown>).error).toBe("unsupported_usage_window");
  });

  it("non-admin gets 403 on /api/admin/usage/overview", async () => {
    const env = makeEnv();
    const req = new Request("https://x/api/admin/usage/overview", {
      headers: { Cookie: await cookie(env, USER_EMAIL) },
    });
    const res = await app.fetch(req, env);
    expect(res.status).toBe(403);
  });

  it("admin global overview has perUser + summary, no recent", async () => {
    const env = makeEnv();
    const req = new Request("https://x/api/admin/usage/overview?window=7d", {
      headers: { Cookie: await cookie(env, ADMIN_EMAIL) },
    });
    const res = await app.fetch(req, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.scope).toBe("global");
    expect(body).toHaveProperty("perUser");
    expect(body).toHaveProperty("summary");
    expect(body).not.toHaveProperty("recent");
  });

  it("old timeseries endpoints are gone (404)", async () => {
    const env = makeEnv();
    const c = await cookie(env, ADMIN_EMAIL);
    const a = await app.fetch(new Request("https://x/api/usage/timeseries", { headers: { Cookie: c } }), env);
    const b = await app.fetch(new Request("https://x/api/admin/usage/timeseries", { headers: { Cookie: c } }), env);
    expect(a.status).toBe(404);
    expect(b.status).toBe(404);
  });
});

describe("/api/admin/summary DO-backed", () => {
  it("returns 200 with schema-valid AdminSummary and performs zero litellmFetch", async () => {
    const env = makeEnv();
    // litellmFetch must never be called — mock globalThis.fetch to throw if called
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("litellmFetch must not be called from /api/admin/summary");
    });

    const req = new Request("https://x/api/admin/summary", {
      headers: { Cookie: await cookie(env, ADMIN_EMAIL) },
    });
    const res = await app.fetch(req, env);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    // All fields from the DO-backed summary must be present and correct types
    expect(typeof body.userCount).toBe("number");
    expect(typeof body.teamCount).toBe("number");
    expect(typeof body.adminCount).toBe("number");
    expect(typeof body.riskCount).toBe("number");
    expect(typeof body.totalSpend).toBe("number");
    expect(typeof body.totalBudget).toBe("number");
    expect(typeof body.sampledUserCount).toBe("number");
    expect(typeof body.limited).toBe("boolean");
  });

  it("non-admin gets 403 on /api/admin/summary", async () => {
    const env = makeEnv();
    const req = new Request("https://x/api/admin/summary", {
      headers: { Cookie: await cookie(env, USER_EMAIL) },
    });
    const res = await app.fetch(req, env);
    expect(res.status).toBe(403);
  });
});
