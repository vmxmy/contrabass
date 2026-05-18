import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  importTeams,
  importUsers,
  applyBootstrapAdmins,
  finalizeImport,
  reconcileUserRoles,
} from "./litellm-importer";
import type { LiteLLMPortalEnv } from "../types";
import type { UserRecord } from "../durable/schemas";

// ---------------------------------------------------------------------------
// Stub factories
// ---------------------------------------------------------------------------

function makeIndexStub() {
  const teams: Array<{ id: string; alias: string }> = [];
  const users = new Map<string, UserRecord>();
  const identities = new Map<string, { emailLc: string; litellmUserId: string; teams: string[] }>();
  let imported = false;
  const auditLog: unknown[] = [];
  const stub = {
    setTeamsList: vi.fn(async (list: Array<{ id: string; alias: string }>) => {
      teams.splice(0, teams.length, ...list);
    }),
    putUser: vi.fn(async (rec: UserRecord) => {
      users.set(rec.email.toLowerCase(), rec);
    }),
    putIdentity: vi.fn(async (rec: { emailLc: string; litellmUserId: string; teams: string[] }) => {
      identities.set(rec.emailLc, rec);
    }),
    getUserByEmail: vi.fn(async (email: string) => users.get(email.toLowerCase()) ?? null),
    isImported: vi.fn(async () => imported),
    markImported: vi.fn(async () => { imported = true; }),
    appendAudit: vi.fn(async (e: unknown) => { auditLog.push(e); }),
  };
  return { teams, users, identities, auditLog, isImported: () => imported, setImported: (v: boolean) => { imported = v; }, stub };
}

function makeTeamStub() {
  const members = new Map<string, unknown>();
  const stub = {
    putTeam: vi.fn().mockResolvedValue(undefined),
    upsertMember: vi.fn(async (m: { userId: string }) => { members.set(m.userId, m); }),
  };
  return { members, stub };
}

function makeEnv(
  idx: ReturnType<typeof makeIndexStub>,
  team: ReturnType<typeof makeTeamStub>,
  overrides: Partial<LiteLLMPortalEnv> = {},
): LiteLLMPortalEnv {
  return {
    LITELLM_BASE_URL: "https://litellm.test",
    LITELLM_MASTER_KEY: "test-key",
    INDEX_DO: {
      idFromName: (_n: string) => ({ name: _n }) as unknown,
      get: () => idx.stub,
    } as unknown as DurableObjectNamespace,
    TEAM_CONFIG_DO: {
      idFromName: (_n: string) => ({ name: _n }) as unknown,
      get: () => team.stub,
    } as unknown as DurableObjectNamespace,
    BOOTSTRAP_ADMIN_EMAILS: "",
    ...overrides,
  } as LiteLLMPortalEnv;
}

// ---------------------------------------------------------------------------
// importTeams
// ---------------------------------------------------------------------------

describe("importTeams", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("walks one page and seeds teams + calls setTeamsList", async () => {
    const idx = makeIndexStub();
    const team = makeTeamStub();
    const env = makeEnv(idx, team);

    // extractRecords handles plain arrays, so return array directly for /team/list
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      const urlStr = String(url);
      if (urlStr.includes("page=1")) {
        return Promise.resolve(
          new Response(
            JSON.stringify([
              { team_id: "t1", team_alias: "alpha", models: ["gpt-4"], spend: 0, max_budget: 100, blocked: false },
              { team_id: "t2", team_alias: "beta", models: [], spend: 0, max_budget: null, blocked: false },
            ]),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
    });

    const result = await importTeams(env);

    expect(result.scannedTeams).toBe(2);
    expect(result.insertedTeams).toBe(2);
    expect(result.errors).toHaveLength(0);
    expect(team.stub.putTeam).toHaveBeenCalledTimes(2);
    expect(idx.stub.setTeamsList).toHaveBeenCalledOnce();
    expect(idx.teams).toHaveLength(2);
    expect(idx.teams.map((t) => t.id)).toEqual(["t1", "t2"]);
  });

  it("walks multiple pages and stops on empty page", async () => {
    const idx = makeIndexStub();
    const team = makeTeamStub();
    const env = makeEnv(idx, team);

    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      const urlStr = String(url);
      if (urlStr.includes("page=1")) {
        return Promise.resolve(
          new Response(
            JSON.stringify([
              { team_id: "t1", team_alias: "a", models: [], spend: 0, max_budget: null, blocked: false },
            ]),
            { status: 200 },
          ),
        );
      }
      if (urlStr.includes("page=2")) {
        return Promise.resolve(
          new Response(
            JSON.stringify([
              { team_id: "t2", team_alias: "b", models: [], spend: 0, max_budget: null, blocked: false },
            ]),
            { status: 200 },
          ),
        );
      }
      // page=3+ returns empty → stops
      return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
    });

    const result = await importTeams(env);

    expect(result.insertedTeams).toBe(2);
    expect(result.scannedTeams).toBe(2);
    // fetch was called 3 times: page 1, 2 (data), 3 (empty → break)
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
  });

  it("tolerates one bad team without aborting the loop", async () => {
    const idx = makeIndexStub();
    const team = makeTeamStub();
    const env = makeEnv(idx, team);

    // Make putTeam throw for t1 only
    team.stub.putTeam
      .mockRejectedValueOnce(new Error("storage error"))
      .mockResolvedValue(undefined);

    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      const urlStr = String(url);
      if (urlStr.includes("page=1")) {
        return Promise.resolve(
          new Response(
            JSON.stringify([
              { team_id: "t1", team_alias: "bad", models: [], spend: 0, max_budget: null, blocked: false },
              { team_id: "t2", team_alias: "good", models: [], spend: 0, max_budget: null, blocked: false },
            ]),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
    });

    const result = await importTeams(env);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].teamId).toBe("t1");
    expect(result.insertedTeams).toBe(1);
    // setTeamsList is still called (only good team in list)
    expect(idx.stub.setTeamsList).toHaveBeenCalledOnce();
    expect(idx.teams.map((t) => t.id)).toEqual(["t2"]);
  });
});

// ---------------------------------------------------------------------------
// importUsers
// ---------------------------------------------------------------------------

describe("importUsers", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("seeds users via putUser and calls upsertMember per team", async () => {
    const idx = makeIndexStub();
    const team = makeTeamStub();
    const env = makeEnv(idx, team);

    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      const urlStr = String(url);
      if (urlStr.includes("page=1")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              users: [
                { user_id: "u1", email: "alice@x.com", role: "proxy_admin", team_ids: ["t1"] },
                { user_id: "u2", email: "bob@x.com", role: "internal_user", team_ids: ["t1", "t2"] },
              ],
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(new Response(JSON.stringify({ users: [] }), { status: 200 }));
    });

    const result = await importUsers(env);

    expect(result.insertedUsers).toBe(2);
    expect(result.scannedUsers).toBe(2);
    expect(result.errors).toHaveLength(0);
    expect(idx.stub.putUser).toHaveBeenCalledTimes(2);
    // alice×1 team + bob×2 teams = 3 upsertMember calls
    expect(team.stub.upsertMember).toHaveBeenCalledTimes(3);
  });

  it("maps only proxy_admin to admin; proxy_admin_viewer and everything else to user", async () => {
    const idx = makeIndexStub();
    const team = makeTeamStub();
    const env = makeEnv(idx, team);

    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      const urlStr = String(url);
      if (urlStr.includes("page=1")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              users: [
                { user_id: "u1", email: "admin1@x.com", role: "proxy_admin", team_ids: [] },
                { user_id: "u2", email: "admin2@x.com", role: "proxy_admin_viewer", team_ids: [] },
                { user_id: "u3", email: "user1@x.com", role: "internal_user", team_ids: [] },
                { user_id: "u4", email: "user2@x.com", role: "team", team_ids: [] },
                { user_id: "u5", email: "user3@x.com", role: null, team_ids: [] },
              ],
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(new Response(JSON.stringify({ users: [] }), { status: 200 }));
    });

    await importUsers(env);

    const storedRoles = Array.from(idx.users.values()).map((u) => u.role);
    expect(storedRoles).toEqual(["admin", "user", "user", "user", "user"]);
  });

  it("stores the canonical LiteLLM user_id (not the email) and keeps email separate", async () => {
    const idx = makeIndexStub();
    const team = makeTeamStub();
    const env = makeEnv(idx, team);

    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      const urlStr = String(url);
      if (urlStr.includes("page=1")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              users: [
                { user_id: "laoxu", user_email: "xu@gz-zhiyun.com", email: "xu@gz-zhiyun.com", role: "internal_user", team_ids: [] },
              ],
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(new Response(JSON.stringify({ users: [] }), { status: 200 }));
    });

    const result = await importUsers(env);

    expect(result.insertedUsers).toBe(1);
    const stored = idx.users.get("xu@gz-zhiyun.com");
    expect(stored?.userId).toBe("laoxu");
    expect(stored?.email).toBe("xu@gz-zhiyun.com");
  });

  it("does not silently store the email as user_id when user_id is missing", async () => {
    const idx = makeIndexStub();
    const team = makeTeamStub();
    const env = makeEnv(idx, team);

    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      const urlStr = String(url);
      if (urlStr.includes("page=1")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              users: [
                { email: "noid@x.com", user_email: "noid@x.com", role: "internal_user", team_ids: [] },
              ],
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(new Response(JSON.stringify({ users: [] }), { status: 200 }));
    });

    const result = await importUsers(env);

    // The record is rejected (no user_id/id) rather than stored with the email
    // masquerading as the LiteLLM user_id.
    expect(result.insertedUsers).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(idx.users.get("noid@x.com")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// applyBootstrapAdmins
// ---------------------------------------------------------------------------

describe("applyBootstrapAdmins", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("forces an existing user to role=admin and increments promotedToAdmin", async () => {
    const idx = makeIndexStub();
    const team = makeTeamStub();
    const env = makeEnv(idx, team, { BOOTSTRAP_ADMIN_EMAILS: "alice@x.com" });

    // Pre-seed a user with role=user
    idx.users.set("alice@x.com", {
      userId: "alice",
      email: "alice@x.com",
      role: "user",
      teamId: null,
      createdAt: new Date().toISOString(),
    });

    const result = await applyBootstrapAdmins(env);

    expect(result.promotedToAdmin).toBe(1);
    expect(result.absentFromIndex).toHaveLength(0);
    expect(result.configuredEmails).toBe(1);
    expect((idx.users.get("alice@x.com") as UserRecord).role).toBe("admin");
  });

  it("does not re-increment promotedToAdmin if user is already admin", async () => {
    const idx = makeIndexStub();
    const team = makeTeamStub();
    const env = makeEnv(idx, team, { BOOTSTRAP_ADMIN_EMAILS: "alice@x.com" });

    idx.users.set("alice@x.com", {
      userId: "alice",
      email: "alice@x.com",
      role: "admin",
      teamId: null,
      createdAt: new Date().toISOString(),
    });

    const result = await applyBootstrapAdmins(env);

    expect(result.promotedToAdmin).toBe(0);
    expect(result.absentFromIndex).toHaveLength(0);
  });

  it("pushes absent users to absentFromIndex and does NOT create them", async () => {
    const idx = makeIndexStub();
    const team = makeTeamStub();
    const env = makeEnv(idx, team, { BOOTSTRAP_ADMIN_EMAILS: "absent@x.com" });

    const result = await applyBootstrapAdmins(env);

    expect(result.absentFromIndex).toContain("absent@x.com");
    expect(result.promotedToAdmin).toBe(0);
    expect(idx.users.has("absent@x.com")).toBe(false);
    // putUser must NOT have been called
    expect(idx.stub.putUser).not.toHaveBeenCalled();
  });

  it("returns zero counts when BOOTSTRAP_ADMIN_EMAILS is empty", async () => {
    const idx = makeIndexStub();
    const team = makeTeamStub();
    const env = makeEnv(idx, team, { BOOTSTRAP_ADMIN_EMAILS: "" });

    const result = await applyBootstrapAdmins(env);

    expect(result.configuredEmails).toBe(0);
    expect(result.promotedToAdmin).toBe(0);
    expect(result.absentFromIndex).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// finalizeImport
// ---------------------------------------------------------------------------

describe("finalizeImport", () => {
  beforeEach(() => vi.restoreAllMocks());

  const baseSummary = {
    teamCount: 5,
    userCount: 10,
    bootstrapAdmins: { configured: 2, promoted: 1, absentFromIndex: 1 },
    errors: [] as Array<{ entityId: string; reason: string }>,
  };

  it("first call appends audit, marks imported, returns alreadyImported=false", async () => {
    const idx = makeIndexStub();
    const team = makeTeamStub();
    const env = makeEnv(idx, team);

    const result = await finalizeImport(env, baseSummary);

    expect(result.alreadyImported).toBe(false);
    expect(idx.auditLog).toHaveLength(1);
    expect(idx.isImported()).toBe(true);
    expect(idx.stub.markImported).toHaveBeenCalledOnce();
    expect(idx.stub.appendAudit).toHaveBeenCalledOnce();
  });

  it("second call short-circuits: returns alreadyImported=true without appending audit", async () => {
    const idx = makeIndexStub();
    const team = makeTeamStub();
    const env = makeEnv(idx, team);

    // Mark already imported before calling
    idx.setImported(true);

    const result = await finalizeImport(env, baseSummary);

    expect(result.alreadyImported).toBe(true);
    expect(idx.auditLog).toHaveLength(0);
    expect(idx.stub.appendAudit).not.toHaveBeenCalled();
    expect(idx.stub.markImported).not.toHaveBeenCalled();
  });

  it("idempotency: two sequential calls produce exactly one audit entry", async () => {
    const idx = makeIndexStub();
    const team = makeTeamStub();
    const env = makeEnv(idx, team);

    const first = await finalizeImport(env, baseSummary);
    const second = await finalizeImport(env, baseSummary);

    expect(first.alreadyImported).toBe(false);
    expect(second.alreadyImported).toBe(true);
    expect(idx.auditLog).toHaveLength(1);
    expect(idx.stub.appendAudit).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// reconcileUserRoles — re-runnable role data scrub
// ---------------------------------------------------------------------------

describe("reconcileUserRoles", () => {
  beforeEach(() => vi.restoreAllMocks());

  function seedUsersResponse(users: unknown[]) {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      const urlStr = String(url);
      if (urlStr.includes("page=1")) {
        return Promise.resolve(new Response(JSON.stringify({ users }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ users: [] }), { status: 200 }));
    });
  }

  it("recomputes role from authoritative LiteLLM user_role; proxy_admin stays admin", async () => {
    const idx = makeIndexStub();
    const team = makeTeamStub();
    const env = makeEnv(idx, team);

    idx.users.set("admin1@x.com", {
      userId: "u1", email: "admin1@x.com", role: "admin", teamId: "t1",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    seedUsersResponse([
      { user_id: "u1", email: "admin1@x.com", role: "proxy_admin", team_ids: ["t1"] },
    ]);

    const result = await reconcileUserRoles(env);

    expect(result.scanned).toBe(1);
    expect(result.corrected).toBe(0);
    expect(result.unchanged).toBe(1);
    expect((idx.users.get("admin1@x.com") as UserRecord).role).toBe("admin");
  });

  it("corrects a poisoned proxy_admin_viewer from admin → user, preserving all other facets", async () => {
    const idx = makeIndexStub();
    const team = makeTeamStub();
    const env = makeEnv(idx, team);

    idx.users.set("xu@gz-zhiyun.com", {
      userId: "laoxu",
      email: "xu@gz-zhiyun.com",
      role: "admin",
      teamId: "team-xyz",
      tenantRole: "tenant_admin",
      maxBudget: 42,
      createdAt: "2026-02-02T00:00:00.000Z",
    } as UserRecord);

    seedUsersResponse([
      { user_id: "laoxu", email: "xu@gz-zhiyun.com", role: "proxy_admin_viewer", team_ids: ["team-xyz"] },
    ]);

    const result = await reconcileUserRoles(env);

    expect(result.scanned).toBe(1);
    expect(result.corrected).toBe(1);
    expect(result.unchanged).toBe(0);
    expect(result.errors).toHaveLength(0);

    const putArg = idx.stub.putUser.mock.calls.at(-1)?.[0] as UserRecord;
    expect(putArg.role).toBe("user");
    expect(putArg.userId).toBe("laoxu");
    expect(putArg.email).toBe("xu@gz-zhiyun.com");
    expect(putArg.teamId).toBe("team-xyz");
    expect((putArg as UserRecord & { tenantRole?: string }).tenantRole).toBe("tenant_admin");
    expect(putArg.maxBudget).toBe(42);
    expect(putArg.createdAt).toBe("2026-02-02T00:00:00.000Z");
    expect((idx.users.get("xu@gz-zhiyun.com") as UserRecord).role).toBe("user");
  });

  it("skips LiteLLM users absent from IndexDO (scanned, not corrected)", async () => {
    const idx = makeIndexStub();
    const team = makeTeamStub();
    const env = makeEnv(idx, team);

    seedUsersResponse([
      { user_id: "ghost", email: "ghost@x.com", role: "internal_user", team_ids: [] },
    ]);

    const result = await reconcileUserRoles(env);

    expect(result.scanned).toBe(1);
    expect(result.corrected).toBe(0);
    expect(result.unchanged).toBe(0);
    expect(idx.stub.putUser).not.toHaveBeenCalled();
  });

  it("is idempotent: a second run corrects nothing", async () => {
    const idx = makeIndexStub();
    const team = makeTeamStub();
    const env = makeEnv(idx, team);

    idx.users.set("xu@gz-zhiyun.com", {
      userId: "laoxu", email: "xu@gz-zhiyun.com", role: "admin", teamId: "team-xyz",
      createdAt: "2026-02-02T00:00:00.000Z",
    });
    seedUsersResponse([
      { user_id: "laoxu", email: "xu@gz-zhiyun.com", role: "proxy_admin_viewer", team_ids: ["team-xyz"] },
    ]);

    const first = await reconcileUserRoles(env);
    expect(first.corrected).toBe(1);

    const second = await reconcileUserRoles(env);
    expect(second.corrected).toBe(0);
    expect(second.unchanged).toBe(1);
  });

  it("isolates a per-user failure: loop continues, errors[] populated", async () => {
    const idx = makeIndexStub();
    const team = makeTeamStub();
    const env = makeEnv(idx, team);

    idx.users.set("bad@x.com", {
      userId: "ubad", email: "bad@x.com", role: "admin", teamId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    idx.users.set("good@x.com", {
      userId: "ugood", email: "good@x.com", role: "admin", teamId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    idx.stub.putUser
      .mockRejectedValueOnce(new Error("storage exploded"))
      .mockResolvedValue(undefined);

    seedUsersResponse([
      { user_id: "ubad", email: "bad@x.com", role: "internal_user", team_ids: [] },
      { user_id: "ugood", email: "good@x.com", role: "internal_user", team_ids: [] },
    ]);

    const result = await reconcileUserRoles(env);

    expect(result.scanned).toBe(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].userId).toBe("ubad");
    expect(result.corrected).toBe(1);
    // putUser called for both; the good user's write carries the corrected role.
    expect(idx.stub.putUser).toHaveBeenCalledTimes(2);
    const goodPut = idx.stub.putUser.mock.calls.at(-1)?.[0] as UserRecord;
    expect(goodPut.userId).toBe("ugood");
    expect(goodPut.role).toBe("user");
  });
});
