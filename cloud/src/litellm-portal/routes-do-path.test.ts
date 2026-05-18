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

// User whose userId is a UUID-like string, distinct from their email.
// This exercises the adminUpdateUserDO path where userId !== email.
const NON_EMAIL_USER = {
  userId: "user-abc-123",
  email: "alice@example.com",
  role: "user" as const,
  teamId: "t1",
  createdAt: new Date().toISOString(),
};

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
  NON_EMAIL_USER,
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

type StubInvite = {
  emailLc: string;
  teamId: string;
  teamRole: "admin" | "user";
  status: "pending" | "consumed" | "revoked";
  invitedBy: string;
  createdAt: string;
  consumedAt: string | null;
};

function makeIndexDOStub() {
  const invites = new Map<string, StubInvite>();
  return {
    listTeams: vi.fn().mockResolvedValue(TEAMS_DATA),
    setTeamsList: vi.fn().mockResolvedValue(undefined),
    listAllUsers: vi.fn().mockResolvedValue({ users: USERS_DATA, cursor: undefined }),
    getUserByEmail: vi.fn(async (email: string) =>
      USERS_DATA.find((u) => u.email === email) ?? null,
    ),
    getUserById: vi.fn(async (userId: string) =>
      USERS_DATA.find((u) => u.userId === userId) ?? null,
    ),
    putUser: vi.fn().mockResolvedValue(undefined),
    putInvite: vi.fn(async (r: StubInvite) => {
      invites.set(r.emailLc.toLowerCase(), { ...r });
    }),
    getInvite: vi.fn(async (emailLc: string) => invites.get(emailLc.toLowerCase()) ?? null),
    listInvites: vi.fn(async (opts?: { status?: StubInvite["status"] }) =>
      [...invites.values()]
        .filter((i) => !opts?.status || i.status === opts.status)
        .sort((a, b) => a.emailLc.localeCompare(b.emailLc)),
    ),
    revokeInvite: vi.fn(async (emailLc: string) => {
      const cur = invites.get(emailLc.toLowerCase());
      if (!cur) return null;
      if (cur.status === "consumed" || cur.status === "revoked") return cur;
      const next: StubInvite = { ...cur, status: "revoked" };
      invites.set(emailLc.toLowerCase(), next);
      return next;
    }),
    appendAudit: vi.fn().mockResolvedValue(undefined),
    putTenantRole: vi.fn().mockResolvedValue(undefined),
    // test-only: pre-seed an invite at a chosen status
    __seedInvite: (r: StubInvite) => invites.set(r.emailLc.toLowerCase(), { ...r }),
    getStorageMigrationState: vi.fn().mockResolvedValue({
      backend: "sql",
      teams: 2,
      users: 3,
      nonces: 0,
      auditEvents: 1,
      legacyKeys: 4,
      legacyKvDeleted: false,
    }),
    deleteLegacyKV: vi.fn().mockResolvedValue({ deleted: 4, skipped: false }),
  };
}

function makeTeamConfigDOStub(overrides: { getTeam?: () => Promise<typeof TEAM_RECORD | null> } = {}) {
  let webhook: { url: string; updatedAt: string; updatedBy: string } | null = null;
  return {
    getTeam: overrides.getTeam ?? vi.fn().mockResolvedValue(TEAM_RECORD),
    putTeam: vi.fn().mockResolvedValue(undefined),
    getAlertWebhook: vi.fn(async () => webhook),
    setAlertWebhook: vi.fn(async (w: { url: string; updatedAt: string; updatedBy: string }) => {
      webhook = w;
    }),
    clearAlertWebhook: vi.fn(async () => {
      webhook = null;
    }),
    getSyncMetadata: vi.fn().mockResolvedValue(SYNC_META),
    getStorageMigrationState: vi.fn().mockResolvedValue({
      backend: "sql",
      hasTeam: true,
      members: 1,
      keys: 1,
      hasSpend: true,
      dirty: false,
      legacyKeys: 3,
      legacyKvDeleted: false,
    }),
    deleteLegacyKV: vi.fn().mockResolvedValue({ deleted: 3, skipped: false }),
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
// Tenant-scope helpers (exercise Task 4 requireTenantAdmin + /api/tenant/*)
// ---------------------------------------------------------------------------

const TENANT_ADMIN_EMAIL = "ta@gz-zhiyun.com";
const TENANT_MEMBER_EMAIL = "member@gz-zhiyun.com";
const TENANT_TEAM_ID = "t1";

// Identity resolution chain (role-cache.ts):
//   1. IndexDO.getUserByEmail(email) -> platform role (must be non-"admin")
//   2. resolveLiteLLMUser(email) -> teamIds  (mocked global fetch /user/list)
//   3. IndexDO.getTenantRole(userId, teamId) -> { tenantRole }
function stubTenantFetch(): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/user/list")) {
      const u = new URL(url);
      const email = (u.searchParams.get("user_email") ?? "").toLowerCase();
      return new Response(
        JSON.stringify([
          { user_id: email, user_email: email, teams: [TENANT_TEAM_ID] },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  });
}

function makeTenantIndexDOStub(tenantRoleByEmail: Record<string, "tenant_admin" | "member">) {
  const base = makeIndexDOStub();
  return {
    ...base,
    // Non-admin platform role so requireTenantAdmin uses the tenant facet.
    getUserByEmail: vi.fn(async (email: string) => {
      const lc = email.toLowerCase();
      if (lc in tenantRoleByEmail) {
        return { userId: lc, email: lc, role: "user" as const, teamId: TENANT_TEAM_ID, createdAt: new Date().toISOString() };
      }
      return USERS_DATA.find((u) => u.email === email) ?? null;
    }),
    getTenantRole: vi.fn(async (userId: string, teamId: string) => {
      const lc = userId.toLowerCase();
      if (teamId === TENANT_TEAM_ID && lc in tenantRoleByEmail) {
        return { tenantRole: tenantRoleByEmail[lc] };
      }
      return null;
    }),
  };
}

function makeTenantAdminEnv(
  indexStub: ReturnType<typeof makeTenantIndexDOStub>,
  teamStub: ReturnType<typeof makeTeamConfigDOStub>,
  overrides: Partial<LiteLLMPortalEnv> = {},
): LiteLLMPortalEnv {
  return makeFlagOnEnv(
    indexStub as unknown as ReturnType<typeof makeIndexDOStub>,
    teamStub,
    overrides,
  );
}

async function tenantRequest(
  email: string,
  url: string,
  env: LiteLLMPortalEnv,
  init: RequestInit = {},
): Promise<Request> {
  const value = await issueSession(env, { email, userId: email });
  const headers = new Headers(init.headers);
  headers.set("Cookie", `${SESSION_COOKIE_NAME}=${value}`);
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

describe("DO-path admin routes", () => {

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


  describe("DO storage migration admin routes", () => {
    it("returns migration state for index and team config DOs", async () => {
      const indexStub = makeIndexDOStub();
      const teamStub = makeTeamConfigDOStub();
      const env = makeFlagOnEnv(indexStub, teamStub);

      const res = await app.fetch(
        await adminRequest("https://x/api/admin/do-storage/migration-state?limit=1", env),
        env,
      );

      expect(res.status).toBe(200);
      const data = await res.json() as {
        index: Record<string, unknown>;
        teams: Array<{ id: string; state: Record<string, unknown> }>;
        limited: boolean;
      };
      expect(data.index.backend).toBe("sql");
      expect(data.index.legacyKeys).toBe(4);
      expect(data.teams.length).toBe(1);
      expect(data.teams[0].state.legacyKeys).toBe(3);
      expect(data.limited).toBe(true);
    });

    it("deletes legacy KV only with typed confirmation", async () => {
      const indexStub = makeIndexDOStub();
      const teamStub = makeTeamConfigDOStub();
      const env = makeFlagOnEnv(indexStub, teamStub);

      const bad = await app.fetch(
        await adminRequest("https://x/api/admin/do-storage/delete-legacy-kv", env, {
          method: "POST",
          body: JSON.stringify({ confirm: "delete" }),
        }),
        env,
      );
      expect(bad.status).toBe(422);
      expect(indexStub.deleteLegacyKV).not.toHaveBeenCalled();

      const ok = await app.fetch(
        await adminRequest("https://x/api/admin/do-storage/delete-legacy-kv", env, {
          method: "POST",
          body: JSON.stringify({ confirm: "delete-legacy-do-kv", teamIds: ["t1"] }),
        }),
        env,
      );

      expect(ok.status).toBe(200);
      const data = await ok.json() as { index: { deleted: number }; teams: Array<{ result: { deleted: number } }> };
      expect(data.index.deleted).toBe(4);
      expect(data.teams).toHaveLength(1);
      expect(data.teams[0].result.deleted).toBe(3);
      expect(indexStub.deleteLegacyKV).toHaveBeenCalledOnce();
      expect(teamStub.deleteLegacyKV).toHaveBeenCalledOnce();
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
      expect(data.totalCount).toBe(3);
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
      smartIndexStub.getUserById = vi.fn(async (_userId: string) => null);
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

    it("proxy_admin_viewer MUST NOT persist as admin in IndexDO (escalation guard)", async () => {
      // Regression: submitting role:"proxy_admin_viewer" must persist "user" to
      // IndexDO, NOT "admin". Previously the || predicate mapped viewer→admin,
      // creating a back-door identical to the litellm-importer path already fixed.
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
            body: JSON.stringify({ role: "proxy_admin_viewer", reason: "test" }),
          },
        ),
        env,
      );

      expect(res.status).toBe(200);
      expect(indexStub.putUser).toHaveBeenCalledOnce();
      const putArg = indexStub.putUser.mock.calls[0][0] as Record<string, unknown>;
      // MUST persist "user", never "admin"
      expect(putArg.role).toBe("user");
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

  // ---------------------------------------------------------------------------
  // Codex review: additional coverage
  // ---------------------------------------------------------------------------

  describe("PATCH /api/admin/users/:userId — userId !== email", () => {
    it("looks up user by userId (not email) and preserves email field in stored record", async () => {
      // NON_EMAIL_USER has userId="user-abc-123" and email="alice@example.com".
      // adminUpdateUserDO must call getUserById("user-abc-123"), not getUserByEmail.
      // The stored record (putUser arg) must retain the original email value.
      const indexStub = makeIndexDOStub();
      const teamStub = makeTeamConfigDOStub();
      const env = makeFlagOnEnv(indexStub, teamStub);

      const res = await app.fetch(
        await adminRequest(
          `https://x/api/admin/users/${encodeURIComponent(NON_EMAIL_USER.userId)}`,
          env,
          {
            method: "PATCH",
            body: JSON.stringify({ role: "proxy_admin", reason: "promotion" }),
          },
        ),
        env,
      );

      expect(res.status).toBe(200);
      const data = await res.json() as Record<string, unknown>;
      // Response userId must be the non-email userId, not the email.
      expect(data.userId).toBe(NON_EMAIL_USER.userId);

      // getUserById must have been called with the userId, not the email.
      expect(indexStub.getUserById).toHaveBeenCalledWith(NON_EMAIL_USER.userId);
      // getUserByEmail must NOT have been called for this lookup.
      expect(indexStub.getUserByEmail).not.toHaveBeenCalledWith(NON_EMAIL_USER.userId);

      // putUser must have been called with a record that still carries the original email.
      expect(indexStub.putUser).toHaveBeenCalledOnce();
      const putArg = indexStub.putUser.mock.calls[0][0] as Record<string, unknown>;
      expect(putArg.userId).toBe(NON_EMAIL_USER.userId);
      expect(putArg.email).toBe(NON_EMAIL_USER.email);
    });
  });

  describe("PATCH /api/admin/teams/:teamId/limits — dryRun=true is non-mutating", () => {
    it("returns would-be-updated record with dryRun=true and does NOT call putTeam or enqueueSync", async () => {
      const indexStub = makeIndexDOStub();
      const teamStub = makeTeamConfigDOStub();
      const syncQueue = { send: vi.fn().mockResolvedValue(undefined) };
      const env = makeFlagOnEnv(indexStub, teamStub, {
        LITELLM_SYNC_QUEUE: syncQueue as unknown as Queue,
      });

      const res = await app.fetch(
        await adminRequest(
          "https://x/api/admin/teams/t1/limits?dryRun=true",
          env,
          {
            method: "PATCH",
            body: JSON.stringify({ tpmLimit: 9999, rpmLimit: 500, maxBudget: 75, reason: "dry-run-check" }),
          },
        ),
        env,
      );

      expect(res.status).toBe(200);
      const data = await res.json() as Record<string, unknown>;

      // Response must declare dryRun=true and carry the would-be-updated team.
      expect(data.dryRun).toBe(true);
      expect(data.enqueued).toBe(false);
      expect(data.team).toBeDefined();
      const team = data.team as Record<string, unknown>;
      expect(team.tpmLimit).toBe(9999);
      expect(team.rpmLimit).toBe(500);
      expect(team.maxBudget).toBe(75);

      // putTeam must NOT have been called — dryRun must be non-mutating.
      expect(teamStub.putTeam).not.toHaveBeenCalled();

      // The sync queue must NOT have been called.
      expect(syncQueue.send).not.toHaveBeenCalled();
    });
  });

  // TODO(post-cutover): adminKeyDisable and adminKeyDelete are not yet routed
  // through the DO path. Once those routes are implemented, replace these
  // placeholders with real tests that assert TeamConfigDO.upsertKey / deleteKey
  // calls and queue messages.
  describe("Key operations under DO flag", () => {
    it.todo("adminDisableKey: assert TeamConfigDO.upsertKey called and queue receives key.update");
    it.todo("adminDeleteKey: assert TeamConfigDO.deleteKey called and queue receives key.delete");
  });

  // -------------------------------------------------------------------------
  // F1 — admin-invite tenant onboarding
  // -------------------------------------------------------------------------
  describe("Admin-invite tenant onboarding", () => {
    const origFetch = globalThis.fetch;
    afterEach(() => {
      globalThis.fetch = origFetch;
    });

    function mockTeamNew(teamId: string, status = 200) {
      globalThis.fetch = vi.fn(async () =>
        new Response(JSON.stringify(status === 200 ? { team_id: teamId } : { detail: "bad" }), {
          status,
          headers: { "content-type": "application/json" },
        }),
      ) as unknown as typeof fetch;
    }

    describe("POST /api/admin/teams", () => {
      it("creates the team in LiteLLM, materializes DOs, audits", async () => {
        const indexStub = makeIndexDOStub();
        const teamStub = makeTeamConfigDOStub();
        const env = makeFlagOnEnv(indexStub, teamStub);
        mockTeamNew("team_new_1");

        const res = await app.fetch(
          await adminRequest("https://x/api/admin/teams", env, {
            method: "POST",
            body: JSON.stringify({ reason: "user_request", alias: "Acme", models: ["gpt-4o"], maxBudget: 100 }),
          }),
          env,
        );

        expect(res.status).toBe(200);
        const data = await res.json() as Record<string, unknown>;
        expect(data).toMatchObject({ teamId: "team_new_1", alias: "Acme", models: ["gpt-4o"], maxBudget: 100, dryRun: false });
        expect(teamStub.putTeam).toHaveBeenCalledWith(
          expect.objectContaining({ id: "team_new_1", alias: "Acme", models: ["gpt-4o"], blocked: false }),
        );
        expect(indexStub.setTeamsList).toHaveBeenCalledWith(
          expect.arrayContaining([{ id: "team_new_1", alias: "Acme" }]),
        );
        expect(indexStub.appendAudit).toHaveBeenCalled();
      });

      it("dryRun does not call LiteLLM or mutate DOs", async () => {
        const indexStub = makeIndexDOStub();
        const teamStub = makeTeamConfigDOStub();
        const env = makeFlagOnEnv(indexStub, teamStub);
        // Admin auth itself issues a LiteLLM fetch (resolveLiteLLMUser); the
        // contract is only that /team/new is NOT hit on a dry run.
        const fetchSpy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
          new Response("[]", { status: 200, headers: { "content-type": "application/json" } }),
        );
        globalThis.fetch = fetchSpy as unknown as typeof fetch;

        const res = await app.fetch(
          await adminRequest("https://x/api/admin/teams?dryRun=true", env, {
            method: "POST",
            body: JSON.stringify({ reason: "other", alias: "Dry", models: [] }),
          }),
          env,
        );

        expect(res.status).toBe(200);
        expect((await res.json() as Record<string, unknown>).dryRun).toBe(true);
        const teamNewCalls = fetchSpy.mock.calls.filter((args) =>
          String(args[0]).includes("/team/new"),
        );
        expect(teamNewCalls).toHaveLength(0);
        expect(teamStub.putTeam).not.toHaveBeenCalled();
      });

      it("maps a LiteLLM 422 to 422", async () => {
        const env = makeFlagOnEnv(makeIndexDOStub(), makeTeamConfigDOStub());
        mockTeamNew("", 422);
        const res = await app.fetch(
          await adminRequest("https://x/api/admin/teams", env, {
            method: "POST",
            body: JSON.stringify({ reason: "other", alias: "Bad", models: [] }),
          }),
          env,
        );
        expect(res.status).toBe(422);
      });

      it("returns 422 on schema violation (missing reason)", async () => {
        const env = makeFlagOnEnv(makeIndexDOStub(), makeTeamConfigDOStub());
        const res = await app.fetch(
          await adminRequest("https://x/api/admin/teams", env, {
            method: "POST",
            body: JSON.stringify({ alias: "NoReason", models: [] }),
          }),
          env,
        );
        expect(res.status).toBe(422);
      });

      it("returns 404 (not_found) when write-ops disabled", async () => {
        const env = makeFlagOnEnv(makeIndexDOStub(), makeTeamConfigDOStub(), {
          LITELLM_PORTAL_WRITE_OPS_ENABLED: "false",
        });
        const res = await app.fetch(
          await adminRequest("https://x/api/admin/teams", env, {
            method: "POST",
            body: JSON.stringify({ reason: "other", alias: "X", models: [] }),
          }),
          env,
        );
        expect(res.status).toBe(404);
      });

      it("returns 401 without a session cookie", async () => {
        const env = makeFlagOnEnv(makeIndexDOStub(), makeTeamConfigDOStub());
        const res = await app.fetch(
          new Request("https://x/api/admin/teams", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ reason: "other", alias: "X", models: [] }),
          }),
          env,
        );
        expect(res.status).toBe(401);
      });
    });

    describe("/api/admin/invites", () => {
      it("POST creates a pending invite when the team exists", async () => {
        const indexStub = makeIndexDOStub();
        const env = makeFlagOnEnv(indexStub, makeTeamConfigDOStub());

        const res = await app.fetch(
          await adminRequest("https://x/api/admin/invites", env, {
            method: "POST",
            body: JSON.stringify({ reason: "user_request", email: "Invitee@gz-zhiyun.com", teamId: "t1", teamRole: "user" }),
          }),
          env,
        );

        expect(res.status).toBe(200);
        const data = await res.json() as { invite: Record<string, unknown>; dryRun: boolean };
        expect(data.invite).toMatchObject({ email: "invitee@gz-zhiyun.com", teamId: "t1", teamRole: "user", status: "pending", consumedAt: null });
        expect(data.dryRun).toBe(false);
        expect(indexStub.putInvite).toHaveBeenCalled();
        expect(indexStub.appendAudit).toHaveBeenCalled();
      });

      it("POST returns 404 when the team does not exist", async () => {
        const teamStub = makeTeamConfigDOStub({ getTeam: vi.fn().mockResolvedValue(null) });
        const env = makeFlagOnEnv(makeIndexDOStub(), teamStub);
        const res = await app.fetch(
          await adminRequest("https://x/api/admin/invites", env, {
            method: "POST",
            body: JSON.stringify({ reason: "other", email: "a@gz-zhiyun.com", teamId: "ghost" }),
          }),
          env,
        );
        expect(res.status).toBe(404);
        expect((await res.json() as Record<string, unknown>).error).toBe("team_not_found");
      });

      it("POST returns 409 when the email already has a consumed invite", async () => {
        const indexStub = makeIndexDOStub();
        indexStub.__seedInvite({
          emailLc: "used@gz-zhiyun.com",
          teamId: "t1",
          teamRole: "user",
          status: "consumed",
          invitedBy: ADMIN_EMAIL,
          createdAt: new Date().toISOString(),
          consumedAt: new Date().toISOString(),
        });
        const env = makeFlagOnEnv(indexStub, makeTeamConfigDOStub());
        const res = await app.fetch(
          await adminRequest("https://x/api/admin/invites", env, {
            method: "POST",
            body: JSON.stringify({ reason: "other", email: "used@gz-zhiyun.com", teamId: "t1" }),
          }),
          env,
        );
        expect(res.status).toBe(409);
      });

      it("GET lists invites and filters by status", async () => {
        const indexStub = makeIndexDOStub();
        indexStub.__seedInvite({ emailLc: "p@gz-zhiyun.com", teamId: "t1", teamRole: "user", status: "pending", invitedBy: ADMIN_EMAIL, createdAt: new Date().toISOString(), consumedAt: null });
        indexStub.__seedInvite({ emailLc: "c@gz-zhiyun.com", teamId: "t1", teamRole: "user", status: "consumed", invitedBy: ADMIN_EMAIL, createdAt: new Date().toISOString(), consumedAt: new Date().toISOString() });
        const env = makeFlagOnEnv(indexStub, makeTeamConfigDOStub());

        const all = await app.fetch(await adminRequest("https://x/api/admin/invites", env), env);
        expect((await all.json() as { invites: unknown[] }).invites.length).toBe(2);

        const pending = await app.fetch(await adminRequest("https://x/api/admin/invites?status=pending", env), env);
        const pendingData = await pending.json() as { invites: Array<{ email: string }> };
        expect(pendingData.invites.map((i) => i.email)).toEqual(["p@gz-zhiyun.com"]);
      });

      it("DELETE revokes a pending invite with matching confirmEmail", async () => {
        const indexStub = makeIndexDOStub();
        indexStub.__seedInvite({ emailLc: "rev@gz-zhiyun.com", teamId: "t1", teamRole: "user", status: "pending", invitedBy: ADMIN_EMAIL, createdAt: new Date().toISOString(), consumedAt: null });
        const env = makeFlagOnEnv(indexStub, makeTeamConfigDOStub());

        const res = await app.fetch(
          await adminRequest("https://x/api/admin/invites/rev@gz-zhiyun.com", env, {
            method: "DELETE",
            body: JSON.stringify({ reason: "user_request", confirmEmail: "rev@gz-zhiyun.com" }),
          }),
          env,
        );
        expect(res.status).toBe(200);
        expect((await res.json() as Record<string, unknown>).status).toBe("revoked");
      });

      it("DELETE returns 403 on confirmEmail mismatch", async () => {
        const indexStub = makeIndexDOStub();
        indexStub.__seedInvite({ emailLc: "m@gz-zhiyun.com", teamId: "t1", teamRole: "user", status: "pending", invitedBy: ADMIN_EMAIL, createdAt: new Date().toISOString(), consumedAt: null });
        const env = makeFlagOnEnv(indexStub, makeTeamConfigDOStub());
        const res = await app.fetch(
          await adminRequest("https://x/api/admin/invites/m@gz-zhiyun.com", env, {
            method: "DELETE",
            body: JSON.stringify({ reason: "other", confirmEmail: "different@gz-zhiyun.com" }),
          }),
          env,
        );
        expect(res.status).toBe(403);
      });

      it("DELETE returns 404 for an unknown invite", async () => {
        const env = makeFlagOnEnv(makeIndexDOStub(), makeTeamConfigDOStub());
        const res = await app.fetch(
          await adminRequest("https://x/api/admin/invites/ghost@gz-zhiyun.com", env, {
            method: "DELETE",
            body: JSON.stringify({ reason: "other", confirmEmail: "ghost@gz-zhiyun.com" }),
          }),
          env,
        );
        expect(res.status).toBe(404);
      });

      it("DELETE returns 409 when the invite was already consumed", async () => {
        const indexStub = makeIndexDOStub();
        indexStub.__seedInvite({ emailLc: "done@gz-zhiyun.com", teamId: "t1", teamRole: "user", status: "consumed", invitedBy: ADMIN_EMAIL, createdAt: new Date().toISOString(), consumedAt: new Date().toISOString() });
        const env = makeFlagOnEnv(indexStub, makeTeamConfigDOStub());
        const res = await app.fetch(
          await adminRequest("https://x/api/admin/invites/done@gz-zhiyun.com", env, {
            method: "DELETE",
            body: JSON.stringify({ reason: "other", confirmEmail: "done@gz-zhiyun.com" }),
          }),
          env,
        );
        expect(res.status).toBe(409);
      });
    });
  });

  // -------------------------------------------------------------------------
  // F2 — per-team budget alert webhook routes
  // -------------------------------------------------------------------------
  describe("Per-team alert webhook routes", () => {
    const VALID = "https://hooks.example.com/budget";

    it("PUT sets the webhook and GET reads it back", async () => {
      const indexStub = makeIndexDOStub();
      const teamStub = makeTeamConfigDOStub();
      const env = makeFlagOnEnv(indexStub, teamStub);

      const put = await app.fetch(
        await adminRequest("https://x/api/admin/teams/t1/alert-webhook", env, {
          method: "PUT",
          body: JSON.stringify({ reason: "routine_maintenance", url: VALID }),
        }),
        env,
      );
      expect(put.status).toBe(200);
      expect((await put.json() as Record<string, unknown>).url).toBe(VALID);
      expect(teamStub.setAlertWebhook).toHaveBeenCalled();
      expect(indexStub.appendAudit).toHaveBeenCalled();

      const get = await app.fetch(
        await adminRequest("https://x/api/admin/teams/t1/alert-webhook", env),
        env,
      );
      expect((await get.json() as Record<string, unknown>).url).toBe(VALID);
    });

    it("PUT rejects an http (non-https) URL with 422", async () => {
      const env = makeFlagOnEnv(makeIndexDOStub(), makeTeamConfigDOStub());
      const res = await app.fetch(
        await adminRequest("https://x/api/admin/teams/t1/alert-webhook", env, {
          method: "PUT",
          body: JSON.stringify({ reason: "other", url: "http://hooks.example.com/x" }),
        }),
        env,
      );
      expect(res.status).toBe(422);
    });

    it("PUT rejects an SSRF target (metadata IP) with 422", async () => {
      const env = makeFlagOnEnv(makeIndexDOStub(), makeTeamConfigDOStub());
      const res = await app.fetch(
        await adminRequest("https://x/api/admin/teams/t1/alert-webhook", env, {
          method: "PUT",
          body: JSON.stringify({ reason: "other", url: "https://169.254.169.254/latest" }),
        }),
        env,
      );
      expect(res.status).toBe(422);
    });

    it("PUT returns 404 when the team does not exist", async () => {
      const teamStub = makeTeamConfigDOStub({ getTeam: vi.fn().mockResolvedValue(null) });
      const env = makeFlagOnEnv(makeIndexDOStub(), teamStub);
      const res = await app.fetch(
        await adminRequest("https://x/api/admin/teams/ghost/alert-webhook", env, {
          method: "PUT",
          body: JSON.stringify({ reason: "other", url: VALID }),
        }),
        env,
      );
      expect(res.status).toBe(404);
    });

    it("DELETE clears the webhook", async () => {
      const teamStub = makeTeamConfigDOStub();
      const env = makeFlagOnEnv(makeIndexDOStub(), teamStub);
      await app.fetch(
        await adminRequest("https://x/api/admin/teams/t1/alert-webhook", env, {
          method: "PUT",
          body: JSON.stringify({ reason: "other", url: VALID }),
        }),
        env,
      );
      const del = await app.fetch(
        await adminRequest("https://x/api/admin/teams/t1/alert-webhook", env, {
          method: "DELETE",
          body: JSON.stringify({ reason: "user_request" }),
        }),
        env,
      );
      expect(del.status).toBe(200);
      expect((await del.json() as Record<string, unknown>).url).toBeNull();
      expect(teamStub.clearAlertWebhook).toHaveBeenCalled();
    }, 15000);

    it("PUT returns 404 when write-ops disabled", async () => {
      const env = makeFlagOnEnv(makeIndexDOStub(), makeTeamConfigDOStub(), {
        LITELLM_PORTAL_WRITE_OPS_ENABLED: "false",
      });
      const res = await app.fetch(
        await adminRequest("https://x/api/admin/teams/t1/alert-webhook", env, {
          method: "PUT",
          body: JSON.stringify({ reason: "other", url: VALID }),
        }),
        env,
      );
      expect(res.status).toBe(404);
    });

    it("GET returns 401 without a session cookie", async () => {
      const env = makeFlagOnEnv(makeIndexDOStub(), makeTeamConfigDOStub());
      const res = await app.fetch(
        new Request("https://x/api/admin/teams/t1/alert-webhook"),
        env,
      );
      expect(res.status).toBe(401);
    });
  });

  // -------------------------------------------------------------------------
  // F3 — monthly billing CSV archive routes
  // -------------------------------------------------------------------------
  describe("Billing archive routes", () => {
    function makeR2(
      overrides: Partial<{
        get: ReturnType<typeof vi.fn>;
        list: ReturnType<typeof vi.fn>;
      }> = {},
    ) {
      return {
        head: vi.fn().mockResolvedValue(null),
        put: vi.fn().mockResolvedValue(undefined),
        get: overrides.get ?? vi.fn().mockResolvedValue(null),
        list: overrides.list ?? vi.fn().mockResolvedValue({ objects: [] }),
      };
    }

    it("GET /api/admin/billing/:yearMonth returns the CSV with download headers", async () => {
      const indexStub = makeIndexDOStub();
      const r2 = makeR2({
        get: vi.fn().mockResolvedValue({ body: "team_id,team_alias\nt1,alpha" }),
      });
      const env = makeFlagOnEnv(indexStub, makeTeamConfigDOStub(), {
        BILLING_ARCHIVE_R2: r2 as unknown as R2Bucket,
      });

      const res = await app.fetch(
        await adminRequest("https://x/api/admin/billing/2026-04", env),
        env,
      );

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/csv");
      expect(res.headers.get("content-disposition")).toBe(
        'attachment; filename="billing-2026-04.csv"',
      );
      expect(await res.text()).toBe("team_id,team_alias\nt1,alpha");
      expect(r2.get).toHaveBeenCalledWith("billing/2026/04.csv");
      expect(indexStub.appendAudit).toHaveBeenCalled();
    });

    it("GET /api/admin/billing/:yearMonth returns the FULL multi-team CSV unfiltered", async () => {
      const fullCsv =
        "team_id,team_alias,spend,requests\n" +
        "t1,alpha,12.50,100\n" +
        "t2,beta,99.99,5000\n" +
        "t3,gamma,7.00,42";
      const r2 = makeR2({ get: vi.fn().mockResolvedValue({ body: fullCsv }) });
      const env = makeFlagOnEnv(makeIndexDOStub(), makeTeamConfigDOStub(), {
        BILLING_ARCHIVE_R2: r2 as unknown as R2Bucket,
      });

      const res = await app.fetch(
        await adminRequest("https://x/api/admin/billing/2026-04", env),
        env,
      );

      expect(res.status).toBe(200);
      // Admin sees every tenant's row, byte-identical to the archive.
      expect(await res.text()).toBe(fullCsv);
    });

    it("GET /api/admin/billing/:yearMonth returns 404 when the object is absent", async () => {
      const r2 = makeR2();
      const env = makeFlagOnEnv(makeIndexDOStub(), makeTeamConfigDOStub(), {
        BILLING_ARCHIVE_R2: r2 as unknown as R2Bucket,
      });

      const res = await app.fetch(
        await adminRequest("https://x/api/admin/billing/2026-04", env),
        env,
      );

      expect(res.status).toBe(404);
      expect((await res.json() as Record<string, unknown>).error).toBe(
        "billing_archive_not_found",
      );
    });

    it("GET /api/admin/billing/:yearMonth returns 400 for a malformed period", async () => {
      const env = makeFlagOnEnv(makeIndexDOStub(), makeTeamConfigDOStub(), {
        BILLING_ARCHIVE_R2: makeR2() as unknown as R2Bucket,
      });

      const res = await app.fetch(
        await adminRequest("https://x/api/admin/billing/2026-4", env),
        env,
      );

      expect(res.status).toBe(400);
      expect((await res.json() as Record<string, unknown>).error).toBe("invalid_period");
    });

    it("GET /api/admin/billing returns 503 when R2 binding is missing", async () => {
      const env = makeFlagOnEnv(makeIndexDOStub(), makeTeamConfigDOStub(), {
        BILLING_ARCHIVE_R2: undefined,
      });

      const res = await app.fetch(
        await adminRequest("https://x/api/admin/billing", env),
        env,
      );

      expect(res.status).toBe(503);
      expect((await res.json() as Record<string, unknown>).error).toBe(
        "billing_archive_unavailable",
      );
    });

    it("GET /api/admin/billing lists available periods from R2 keys", async () => {
      const r2 = makeR2({
        list: vi.fn().mockResolvedValue({
          objects: [
            { key: "billing/2026/03.csv" },
            { key: "billing/2026/04.csv" },
            { key: "billing/not-a-period.txt" },
          ],
        }),
      });
      const env = makeFlagOnEnv(makeIndexDOStub(), makeTeamConfigDOStub(), {
        BILLING_ARCHIVE_R2: r2 as unknown as R2Bucket,
      });

      const res = await app.fetch(
        await adminRequest("https://x/api/admin/billing", env),
        env,
      );

      expect(res.status).toBe(200);
      expect((await res.json() as Record<string, unknown>).periods).toEqual([
        "2026-03",
        "2026-04",
      ]);
    });

    it("GET /api/admin/billing/:yearMonth returns 401 without a session cookie", async () => {
      const env = makeFlagOnEnv(makeIndexDOStub(), makeTeamConfigDOStub(), {
        BILLING_ARCHIVE_R2: makeR2() as unknown as R2Bucket,
      });

      const res = await app.fetch(
        new Request("https://x/api/admin/billing/2026-04"),
        env,
      );

      expect(res.status).toBe(401);
    });

    it("GET /api/admin/billing/:yearMonth returns 403 when INDEX_DO is missing", async () => {
      const env = makeFlagOnEnv(makeIndexDOStub(), makeTeamConfigDOStub(), {
        INDEX_DO: undefined,
        BILLING_ARCHIVE_R2: makeR2() as unknown as R2Bucket,
      });

      const res = await app.fetch(
        await adminRequest("https://x/api/admin/billing/2026-04", env),
        env,
      );

      expect(res.status).toBe(403);
      expect((await res.json() as Record<string, unknown>).error).toBe("admin_required");
    });
  });
});

// ---------------------------------------------------------------------------
// Task 5 — tenant-scoped /api/tenant/* (invites, alert-webhook, billing)
// Also validates Task 4 requireTenantAdmin gating.
// ---------------------------------------------------------------------------

describe("DO-path tenant routes (/api/tenant/*)", () => {
  describe("GET /api/tenant/invites", () => {
    it("returns 200 for a tenant_admin of its own team", async () => {
      stubTenantFetch();
      const indexStub = makeTenantIndexDOStub({ [TENANT_ADMIN_EMAIL]: "tenant_admin" });
      indexStub.__seedInvite({ emailLc: "p@gz-zhiyun.com", teamId: TENANT_TEAM_ID, teamRole: "user", status: "pending", invitedBy: TENANT_ADMIN_EMAIL, createdAt: new Date().toISOString(), consumedAt: null });
      indexStub.__seedInvite({ emailLc: "other@gz-zhiyun.com", teamId: "t2", teamRole: "user", status: "pending", invitedBy: ADMIN_EMAIL, createdAt: new Date().toISOString(), consumedAt: null });
      const env = makeTenantAdminEnv(indexStub, makeTeamConfigDOStub());

      const res = await app.fetch(
        await tenantRequest(TENANT_ADMIN_EMAIL, "https://x/api/tenant/invites", env),
        env,
      );

      expect(res.status).toBe(200);
      const data = await res.json() as { invites: Array<{ email: string; teamId: string }> };
      // Filtered to own team only.
      expect(data.invites.every((i) => i.teamId === TENANT_TEAM_ID)).toBe(true);
      expect(data.invites.map((i) => i.email)).toEqual(["p@gz-zhiyun.com"]);
    });

    it("returns 403 for a member (not tenant_admin)", async () => {
      stubTenantFetch();
      const indexStub = makeTenantIndexDOStub({ [TENANT_MEMBER_EMAIL]: "member" });
      const env = makeTenantAdminEnv(indexStub, makeTeamConfigDOStub());

      const res = await app.fetch(
        await tenantRequest(TENANT_MEMBER_EMAIL, "https://x/api/tenant/invites", env),
        env,
      );

      expect(res.status).toBe(403);
      expect((await res.json() as Record<string, unknown>).error).toBe("tenant_admin_required");
    });

    it("returns 403 no_tenant_scope for a platform admin with no tenantTeamId", async () => {
      // #given a platform admin (role==="admin"): requireTenantAdmin passes the
      // superset through, but the admin's IndexDO user record has no teamId, so
      // the portal-authoritative tenantTeamId derivation resolves to null.
      const indexStub = makeIndexDOStub();
      indexStub.getUserByEmail = vi.fn().mockResolvedValue({
        userId: ADMIN_EMAIL,
        email: ADMIN_EMAIL,
        role: "admin" as const,
        teamId: null,
        createdAt: new Date().toISOString(),
      });
      const env = makeFlagOnEnv(indexStub, makeTeamConfigDOStub());

      // #when hitting a tenant route
      const res = await app.fetch(
        await adminRequest("https://x/api/tenant/invites", env),
        env,
      );

      // #then tenantTeamOr403 rejects with no_tenant_scope
      expect(res.status).toBe(403);
      expect((await res.json() as Record<string, unknown>).error).toBe("no_tenant_scope");
    });
  });

  describe("POST /api/tenant/invites", () => {
    it("pins teamId to the caller's own team and ignores a body teamId", async () => {
      stubTenantFetch();
      const indexStub = makeTenantIndexDOStub({ [TENANT_ADMIN_EMAIL]: "tenant_admin" });
      const env = makeTenantAdminEnv(indexStub, makeTeamConfigDOStub());

      const res = await app.fetch(
        await tenantRequest(TENANT_ADMIN_EMAIL, "https://x/api/tenant/invites", env, {
          method: "POST",
          body: JSON.stringify({ reason: "other", email: "new@gz-zhiyun.com", teamId: "t2" }),
        }),
        env,
      );

      expect(res.status).toBe(200);
      expect(indexStub.putInvite).toHaveBeenCalledTimes(1);
      const stored = indexStub.putInvite.mock.calls[0][0] as { teamId: string; emailLc: string };
      expect(stored.teamId).toBe(TENANT_TEAM_ID);
      expect(stored.emailLc).toBe("new@gz-zhiyun.com");
    });

    it("returns 403 for a member", async () => {
      stubTenantFetch();
      const indexStub = makeTenantIndexDOStub({ [TENANT_MEMBER_EMAIL]: "member" });
      const env = makeTenantAdminEnv(indexStub, makeTeamConfigDOStub());

      const res = await app.fetch(
        await tenantRequest(TENANT_MEMBER_EMAIL, "https://x/api/tenant/invites", env, {
          method: "POST",
          body: JSON.stringify({ reason: "other", email: "x@gz-zhiyun.com" }),
        }),
        env,
      );

      expect(res.status).toBe(403);
      expect(indexStub.putInvite).not.toHaveBeenCalled();
    });
  });

  describe("PUT /api/tenant/alert-webhook", () => {
    const VALID = "https://hooks.example.com/budget";

    it("sets the webhook for the caller's own team (200)", async () => {
      stubTenantFetch();
      const indexStub = makeTenantIndexDOStub({ [TENANT_ADMIN_EMAIL]: "tenant_admin" });
      const teamStub = makeTeamConfigDOStub();
      const env = makeTenantAdminEnv(indexStub, teamStub);

      const res = await app.fetch(
        await tenantRequest(TENANT_ADMIN_EMAIL, "https://x/api/tenant/alert-webhook", env, {
          method: "PUT",
          body: JSON.stringify({ reason: "routine_maintenance", url: VALID }),
        }),
        env,
      );

      expect(res.status).toBe(200);
      const body = await res.json() as { teamId: string; url: string };
      expect(body.teamId).toBe(TENANT_TEAM_ID);
      expect(body.url).toBe(VALID);
      expect(teamStub.setAlertWebhook).toHaveBeenCalled();
    });

    it("rejects an SSRF metadata target with 422", async () => {
      stubTenantFetch();
      const indexStub = makeTenantIndexDOStub({ [TENANT_ADMIN_EMAIL]: "tenant_admin" });
      const env = makeTenantAdminEnv(indexStub, makeTeamConfigDOStub());

      const res = await app.fetch(
        await tenantRequest(TENANT_ADMIN_EMAIL, "https://x/api/tenant/alert-webhook", env, {
          method: "PUT",
          body: JSON.stringify({ reason: "other", url: "http://169.254.169.254/x" }),
        }),
        env,
      );

      expect(res.status).toBe(422);
    });

    it("returns 403 for a member", async () => {
      stubTenantFetch();
      const indexStub = makeTenantIndexDOStub({ [TENANT_MEMBER_EMAIL]: "member" });
      const teamStub = makeTeamConfigDOStub();
      const env = makeTenantAdminEnv(indexStub, teamStub);

      const res = await app.fetch(
        await tenantRequest(TENANT_MEMBER_EMAIL, "https://x/api/tenant/alert-webhook", env, {
          method: "PUT",
          body: JSON.stringify({ reason: "other", url: VALID }),
        }),
        env,
      );

      expect(res.status).toBe(403);
      expect(teamStub.setAlertWebhook).not.toHaveBeenCalled();
    });
  });

  describe("GET /api/tenant/billing/:yearMonth", () => {
    function makeR2(get: ReturnType<typeof vi.fn>) {
      return {
        head: vi.fn().mockResolvedValue(null),
        put: vi.fn().mockResolvedValue(undefined),
        get,
        list: vi.fn().mockResolvedValue({ objects: [] }),
      };
    }

    const MULTI_TEAM_CSV =
      "team_id,team_alias,spend,requests\n" +
      "t1,alpha,12.50,100\n" +
      "t2,beta,99.99,5000\n" +
      "t3,gamma,7.00,42";

    it("returns ONLY the caller's own team rows (no cross-tenant leak)", async () => {
      stubTenantFetch();
      const indexStub = makeTenantIndexDOStub({ [TENANT_ADMIN_EMAIL]: "tenant_admin" });
      const env = makeTenantAdminEnv(indexStub, makeTeamConfigDOStub(), {
        BILLING_ARCHIVE_R2: makeR2(
          vi.fn().mockResolvedValue({ body: MULTI_TEAM_CSV }),
        ) as unknown as R2Bucket,
      });

      const res = await app.fetch(
        await tenantRequest(TENANT_ADMIN_EMAIL, "https://x/api/tenant/billing/2026-04", env),
        env,
      );

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/csv");
      const body = await res.text();
      // Header preserved + only the caller's (t1) row.
      expect(body).toBe("team_id,team_alias,spend,requests\nt1,alpha,12.50,100");
      // No other tenant's data is present.
      expect(body).not.toContain("t2,beta");
      expect(body).not.toContain("t3,gamma");
      expect(body).not.toContain("99.99");
      expect(body).not.toContain("5000");
    });

    it("returns header-only CSV 200 when the team has no rows (valid empty bill)", async () => {
      stubTenantFetch();
      const indexStub = makeTenantIndexDOStub({ [TENANT_ADMIN_EMAIL]: "tenant_admin" });
      const noT1Csv = "team_id,team_alias,spend,requests\nt2,beta,99.99,5000\nt3,gamma,7.00,42";
      const env = makeTenantAdminEnv(indexStub, makeTeamConfigDOStub(), {
        BILLING_ARCHIVE_R2: makeR2(
          vi.fn().mockResolvedValue({ body: noT1Csv }),
        ) as unknown as R2Bucket,
      });

      const res = await app.fetch(
        await tenantRequest(TENANT_ADMIN_EMAIL, "https://x/api/tenant/billing/2026-04", env),
        env,
      );

      expect(res.status).toBe(200);
      expect(await res.text()).toBe("team_id,team_alias,spend,requests");
    });

    it("returns 404 when the object is absent (still authorized)", async () => {
      stubTenantFetch();
      const indexStub = makeTenantIndexDOStub({ [TENANT_ADMIN_EMAIL]: "tenant_admin" });
      const env = makeTenantAdminEnv(indexStub, makeTeamConfigDOStub(), {
        BILLING_ARCHIVE_R2: makeR2(vi.fn().mockResolvedValue(null)) as unknown as R2Bucket,
      });

      const res = await app.fetch(
        await tenantRequest(TENANT_ADMIN_EMAIL, "https://x/api/tenant/billing/2026-04", env),
        env,
      );

      expect(res.status).toBe(404);
      expect((await res.json() as Record<string, unknown>).error).toBe("billing_archive_not_found");
    });

    it("returns 403 for a member", async () => {
      stubTenantFetch();
      const indexStub = makeTenantIndexDOStub({ [TENANT_MEMBER_EMAIL]: "member" });
      const env = makeTenantAdminEnv(indexStub, makeTeamConfigDOStub(), {
        BILLING_ARCHIVE_R2: makeR2(vi.fn().mockResolvedValue(null)) as unknown as R2Bucket,
      });

      const res = await app.fetch(
        await tenantRequest(TENANT_MEMBER_EMAIL, "https://x/api/tenant/billing/2026-04", env),
        env,
      );

      expect(res.status).toBe(403);
    });
  });

  describe("PUT /api/admin/teams/:teamId/members/:userId/tenant-role", () => {
    it("admin sets a member's tenantRole → 200 + IndexDO.putTenantRole called + audit", async () => {
      const indexStub = makeIndexDOStub();
      const env = makeFlagOnEnv(indexStub, makeTeamConfigDOStub());
      const res = await app.fetch(
        await adminRequest(
          "https://x/api/admin/teams/t1/members/u1/tenant-role",
          env,
          { method: "PUT", body: JSON.stringify({ reason: "user_request", tenantRole: "tenant_admin" }) },
        ),
        env,
      );
      expect(res.status).toBe(200);
      expect(indexStub.putTenantRole).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "u1", teamId: "t1", tenantRole: "tenant_admin" }),
      );
      expect(indexStub.appendAudit).toHaveBeenCalled();
    });

    it("422 on bad tenantRole; 404 write-ops disabled", async () => {
      const env = makeFlagOnEnv(makeIndexDOStub(), makeTeamConfigDOStub());
      expect(
        (await app.fetch(
          await adminRequest(
            "https://x/api/admin/teams/t1/members/u1/tenant-role",
            env,
            { method: "PUT", body: JSON.stringify({ reason: "other", tenantRole: "boss" }) },
          ),
          env,
        )).status,
      ).toBe(422);
      const off = makeFlagOnEnv(makeIndexDOStub(), makeTeamConfigDOStub(), {
        LITELLM_PORTAL_WRITE_OPS_ENABLED: "false",
      });
      expect(
        (await app.fetch(
          await adminRequest(
            "https://x/api/admin/teams/t1/members/u1/tenant-role",
            off,
            { method: "PUT", body: JSON.stringify({ reason: "other", tenantRole: "member" }) },
          ),
          off,
        )).status,
      ).toBe(404);
    });
  });
});
