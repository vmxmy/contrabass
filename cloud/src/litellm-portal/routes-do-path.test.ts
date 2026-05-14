import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { app } from "./routes";
import { issueSession, SESSION_COOKIE_NAME } from "./auth/session";
import { _clearRoleCacheForTests } from "./roles";
import type { LiteLLMPortalEnv } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ADMIN_EMAIL = "admin@gz-zhiyun.com";
const SESSION_SECRET = "test-secret-32bytes-paddedXXXXXX";

const TEAMS_DATA = [
  { id: "t1", alias: "alpha" },
  { id: "t2", alias: "beta" },
];

const USERS_DATA = [
  {
    userId: ADMIN_EMAIL,
    email: ADMIN_EMAIL,
    role: "admin" as const,
    teamId: "t1",
    createdAt: new Date().toISOString(),
  },
  {
    userId: "bob@gz-zhiyun.com",
    email: "bob@gz-zhiyun.com",
    role: "user" as const,
    teamId: "t2",
    createdAt: new Date().toISOString(),
  },
];

const SYNC_META = {
  lastSyncedAt: "2026-05-14T15:00:00.000Z",
  lastSyncError: null,
  dirty: false,
};

const TEAM_RECORD = {
  id: "t1",
  alias: "alpha",
  models: ["gpt-4"],
  maxBudget: 100,
  tpmLimit: null as number | null,
  rpmLimit: null as number | null,
  blocked: false,
};

function makeIndexDOStub() {
  return {
    listTeams: vi.fn().mockResolvedValue(TEAMS_DATA),
    listAllUsers: vi.fn().mockResolvedValue({ users: USERS_DATA, cursor: undefined }),
    getUserByEmail: vi.fn(async (email: string) =>
      USERS_DATA.find((u) => u.email === email) ?? null,
    ),
    putUser: vi.fn().mockResolvedValue(undefined),
  };
}

function makeTeamConfigDOStub(overrides: { getTeam?: () => Promise<typeof TEAM_RECORD | null> } = {}) {
  return {
    getTeam: overrides.getTeam ?? vi.fn().mockResolvedValue(TEAM_RECORD),
    putTeam: vi.fn().mockResolvedValue(undefined),
    getSyncMetadata: vi.fn().mockResolvedValue(SYNC_META),
  };
}

function makeIndexDONamespace(stub: ReturnType<typeof makeIndexDOStub>) {
  return {
    idFromName: vi.fn().mockReturnValue({}),
    get: vi.fn().mockReturnValue(stub),
  };
}

function makeTeamConfigDONamespace(stub: ReturnType<typeof makeTeamConfigDOStub>) {
  return {
    idFromName: vi.fn().mockReturnValue({}),
    get: vi.fn().mockReturnValue(stub),
  };
}

function makeFlagOnEnv(
  indexDOStub: ReturnType<typeof makeIndexDOStub>,
  teamConfigDOStub: ReturnType<typeof makeTeamConfigDOStub>,
  overrides: Partial<LiteLLMPortalEnv> = {},
): LiteLLMPortalEnv {
  return {
    PORTAL_DO_SOT_ENABLED: "true",
    PORTAL_SESSION_SECRET: SESSION_SECRET,
    PORTAL_ALLOWED_EMAIL_DOMAINS: "gz-zhiyun.com",
    LITELLM_BASE_URL: "https://litellm.test",
    LITELLM_MASTER_KEY: "test-key",
    LITELLM_PORTAL_WRITE_OPS_ENABLED: "true",
    INDEX_DO: makeIndexDONamespace(indexDOStub) as unknown as DurableObjectNamespace,
    TEAM_CONFIG_DO: makeTeamConfigDONamespace(teamConfigDOStub) as unknown as DurableObjectNamespace,
    LITELLM_SYNC_QUEUE: { send: vi.fn().mockResolvedValue(undefined) } as unknown as Queue,
    LITELLM_SYNC_DLQ: { send: vi.fn().mockResolvedValue(undefined) } as unknown as Queue,
    ...overrides,
  } as unknown as LiteLLMPortalEnv;
}

async function adminCookie(env: LiteLLMPortalEnv): Promise<string> {
  const value = await issueSession(env, { email: ADMIN_EMAIL, userId: ADMIN_EMAIL });
  return `${SESSION_COOKIE_NAME}=${value}`;
}

async function adminRequest(
  url: string,
  env: LiteLLMPortalEnv,
  init: RequestInit = {},
): Promise<Request> {
  const cookie = await adminCookie(env);
  const headers = new Headers(init.headers);
  headers.set("Cookie", cookie);
  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return new Request(url, { ...init, headers });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

afterEach(() => {
  _clearRoleCacheForTests();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DO-path admin routes (PORTAL_DO_SOT_ENABLED=true)", () => {

  describe("GET /api/admin/teams", () => {
    it("returns DO-sourced teams with sync metadata fields", async () => {
      const indexStub = makeIndexDOStub();
      const teamStub = makeTeamConfigDOStub();
      const env = makeFlagOnEnv(indexStub, teamStub);

      const res = await app.fetch(
        await adminRequest("https://x/api/admin/teams", env),
        env,
      );

      expect(res.status).toBe(200);
      const data = await res.json() as { teams: Array<Record<string, unknown>> };
      expect(Array.isArray(data.teams)).toBe(true);
      expect(data.teams.length).toBe(2);

      const team1 = data.teams.find((t) => t.id === "t1");
      expect(team1).toBeDefined();
      expect(team1?.alias).toBe("alpha");
      expect(team1?.lastSyncedAt).toBe("2026-05-14T15:00:00.000Z");
      expect(team1?.lastSyncError).toBeNull();
    });

    it("returns 403 when INDEX_DO binding is missing (role resolves to none)", async () => {
      // When INDEX_DO is absent, getRoleViaIndexDO returns "none" for every user
      // (including the session-cookie holder), so requireAdmin fires 403 before the
      // route handler's own INDEX_DO guard is reached.
      const teamStub = makeTeamConfigDOStub();
      const env = makeFlagOnEnv(makeIndexDOStub(), teamStub, { INDEX_DO: undefined });

      const res = await app.fetch(
        await adminRequest("https://x/api/admin/teams", env),
        env,
      );

      expect(res.status).toBe(403);
      const data = await res.json() as Record<string, unknown>;
      expect(data.error).toBe("admin_required");
    });

    it("returns 401 without a valid session cookie", async () => {
      const indexStub = makeIndexDOStub();
      const teamStub = makeTeamConfigDOStub();
      const env = makeFlagOnEnv(indexStub, teamStub);

      const res = await app.fetch(
        new Request("https://x/api/admin/teams"),
        env,
      );

      expect(res.status).toBe(401);
    });
  });

  describe("GET /api/admin/users", () => {
    it("returns DO-sourced users with cursor-pagination shape", async () => {
      const indexStub = makeIndexDOStub();
      const teamStub = makeTeamConfigDOStub();
      const env = makeFlagOnEnv(indexStub, teamStub);

      const res = await app.fetch(
        await adminRequest("https://x/api/admin/users?page=1&size=50", env),
        env,
      );

      expect(res.status).toBe(200);
      const data = await res.json() as {
        users: Array<Record<string, unknown>>;
        totalCount: number;
        page: number;
        size: number;
      };
      expect(Array.isArray(data.users)).toBe(true);
      expect(data.totalCount).toBe(2);
      expect(data.page).toBe(1);
      expect(data.size).toBe(50);

      const adminUser = data.users.find((u) => u.userId === ADMIN_EMAIL);
      expect(adminUser).toBeDefined();
      expect(adminUser?.role).toBe("admin");
    });

    it("returns second page with smaller slice", async () => {
      const indexStub = makeIndexDOStub();
      const teamStub = makeTeamConfigDOStub();
      const env = makeFlagOnEnv(indexStub, teamStub);

      const res = await app.fetch(
        await adminRequest("https://x/api/admin/users?page=2&size=1", env),
        env,
      );

      expect(res.status).toBe(200);
      const data = await res.json() as {
        users: Array<Record<string, unknown>>;
        totalCount: number;
        page: number;
      };
      expect(data.users.length).toBe(1);
      expect(data.page).toBe(2);
    });
  });

  describe("PATCH /api/admin/teams/:teamId/limits", () => {
    it("writes to TeamConfigDO and enqueues sync, returns metadata", async () => {
      const indexStub = makeIndexDOStub();
      const teamStub = makeTeamConfigDOStub();
      const env = makeFlagOnEnv(indexStub, teamStub);

      const res = await app.fetch(
        await adminRequest("https://x/api/admin/teams/t1/limits", env, {
          method: "PATCH",
          body: JSON.stringify({ tpmLimit: 5000, rpmLimit: 200, maxBudget: 50, reason: "budget-cut" }),
        }),
        env,
      );

      expect(res.status).toBe(200);
      const data = await res.json() as Record<string, unknown>;
      expect(data.team).toBeDefined();
      expect(data.lastSyncedAt).toBe("2026-05-14T15:00:00.000Z");
      expect(data.enqueued).toBe(true);

      expect(teamStub.putTeam).toHaveBeenCalledOnce();
      const putArg = teamStub.putTeam.mock.calls[0][0] as Record<string, unknown>;
      expect(putArg.tpmLimit).toBe(5000);
      expect(putArg.rpmLimit).toBe(200);
      expect(putArg.maxBudget).toBe(50);
    });

    it("returns 503 when TEAM_CONFIG_DO binding is missing", async () => {
      const indexStub = makeIndexDOStub();
      const teamStub = makeTeamConfigDOStub();
      const env = makeFlagOnEnv(indexStub, teamStub, { TEAM_CONFIG_DO: undefined });

      const res = await app.fetch(
        await adminRequest("https://x/api/admin/teams/t1/limits", env, {
          method: "PATCH",
          body: JSON.stringify({ tpmLimit: 1000, reason: "test" }),
        }),
        env,
      );

      expect(res.status).toBe(503);
      const data = await res.json() as Record<string, unknown>;
      expect(data.error).toBe("team_config_do_unavailable");
    });

    it("returns 404 when team does not exist in TeamConfigDO", async () => {
      const indexStub = makeIndexDOStub();
      const teamStub = makeTeamConfigDOStub({
        getTeam: vi.fn().mockResolvedValue(null),
      });
      const env = makeFlagOnEnv(indexStub, teamStub);

      const res = await app.fetch(
        await adminRequest("https://x/api/admin/teams/nonexistent/limits", env, {
          method: "PATCH",
          body: JSON.stringify({ tpmLimit: 1000, reason: "test" }),
        }),
        env,
      );

      expect(res.status).toBe(404);
      const data = await res.json() as Record<string, unknown>;
      expect(data.error).toBe("team_not_found");
    });
  });

  describe("PATCH /api/admin/users/:userId", () => {
    it("writes updated user to IndexDO and enqueues sync", async () => {
      const indexStub = makeIndexDOStub();
      const teamStub = makeTeamConfigDOStub();
      const env = makeFlagOnEnv(indexStub, teamStub);

      const targetEmail = "bob@gz-zhiyun.com";
      const res = await app.fetch(
        await adminRequest(
          `https://x/api/admin/users/${encodeURIComponent(targetEmail)}`,
          env,
          {
            method: "PATCH",
            body: JSON.stringify({ role: "proxy_admin", maxBudget: 200, reason: "promotion" }),
          },
        ),
        env,
      );

      expect(res.status).toBe(200);
      const data = await res.json() as Record<string, unknown>;
      expect(data.userId).toBe(targetEmail);
      expect(data.role).toBe("admin");
      expect(data.enqueued).toBe(true);

      expect(indexStub.putUser).toHaveBeenCalledOnce();
      const putArg = indexStub.putUser.mock.calls[0][0] as Record<string, unknown>;
      expect(putArg.role).toBe("admin");
      expect(putArg.maxBudget).toBe(200);
    });

    it("returns 403 when INDEX_DO binding is missing (role resolves to none)", async () => {
      // INDEX_DO is used for both role resolution and the write handler.
      // When the binding is absent, getRoleViaIndexDO returns "none" so
      // requireAdmin blocks at 403 before the handler's own 503 guard fires.
      const teamStub = makeTeamConfigDOStub();
      const env = makeFlagOnEnv(makeIndexDOStub(), teamStub, { INDEX_DO: undefined });

      const res = await app.fetch(
        await adminRequest("https://x/api/admin/users/bob%40gz-zhiyun.com", env, {
          method: "PATCH",
          body: JSON.stringify({ role: "proxy_admin", reason: "test" }),
        }),
        env,
      );

      expect(res.status).toBe(403);
      const data = await res.json() as Record<string, unknown>;
      expect(data.error).toBe("admin_required");
    });

    it("returns 404 when user does not exist in IndexDO", async () => {
      const indexStub = makeIndexDOStub();
      // Override getUserByEmail to always return null
      indexStub.getUserByEmail = vi.fn().mockResolvedValue(null);
      const teamStub = makeTeamConfigDOStub();
      const env = makeFlagOnEnv(indexStub, teamStub);

      // Admin user must still resolve for auth — rebuild stub after env creation
      // so the auth call (ADMIN_EMAIL) falls through to null too…
      // Instead, we use a separate IndexDO namespace that returns admin for auth
      // but null for the target user. We do this by making getUserByEmail smart:
      const smartIndexStub = makeIndexDOStub();
      smartIndexStub.getUserByEmail = vi.fn(async (email: string) => {
        if (email === ADMIN_EMAIL) {
          return USERS_DATA.find((u) => u.email === ADMIN_EMAIL) ?? null;
        }
        return null;
      });
      const envWithSmartStub = makeFlagOnEnv(smartIndexStub, teamStub);

      const res = await app.fetch(
        await adminRequest("https://x/api/admin/users/nobody%40gz-zhiyun.com", envWithSmartStub, {
          method: "PATCH",
          body: JSON.stringify({ role: "internal_user", reason: "test" }),
        }),
        envWithSmartStub,
      );

      expect(res.status).toBe(404);
      const data = await res.json() as Record<string, unknown>;
      expect(data.error).toBe("user_not_found");
    });
  });

  describe("Non-admin user (flag=true)", () => {
    it("returns 403 when authenticated user lacks admin role", async () => {
      const regularEmail = "bob@gz-zhiyun.com";
      const indexStub = makeIndexDOStub();
      const teamStub = makeTeamConfigDOStub();
      const env = makeFlagOnEnv(indexStub, teamStub);

      const sessionValue = await issueSession(env, { email: regularEmail, userId: regularEmail });
      const cookie = `${SESSION_COOKIE_NAME}=${sessionValue}`;

      const res = await app.fetch(
        new Request("https://x/api/admin/teams", {
          headers: { Cookie: cookie },
        }),
        env,
      );

      expect(res.status).toBe(403);
      const data = await res.json() as Record<string, unknown>;
      expect(data.error).toBe("admin_required");
    });
  });
});
