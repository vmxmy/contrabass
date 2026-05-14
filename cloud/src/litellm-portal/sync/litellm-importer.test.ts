import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  importTeams,
  importUsers,
  applyBootstrapAdmins,
  finalizeImport,
} from "./litellm-importer";
import type { LiteLLMPortalEnv } from "../types";
import type { UserRecord } from "../durable/schemas";

// ---------------------------------------------------------------------------
// Stub factories
// ---------------------------------------------------------------------------

function makeIndexStub() {
  const teams: Array<{ id: string; alias: string }> = [];
  const users = new Map<string, UserRecord>();
  let imported = false;
  const auditLog: unknown[] = [];
  const stub = {
    setTeamsList: vi.fn(async (list: Array<{ id: string; alias: string }>) => {
      teams.splice(0, teams.length, ...list);
    }),
    putUser: vi.fn(async (rec: UserRecord) => {
      users.set(rec.email.toLowerCase(), rec);
    }),
    getUserByEmail: vi.fn(async (email: string) => users.get(email.toLowerCase()) ?? null),
    isImported: vi.fn(async () => imported),
    markImported: vi.fn(async () => { imported = true; }),
    appendAudit: vi.fn(async (e: unknown) => { auditLog.push(e); }),
  };
  return { teams, users, auditLog, isImported: () => imported, setImported: (v: boolean) => { imported = v; }, stub };
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

  it("maps proxy_admin and proxy_admin_viewer to admin, everything else to user", async () => {
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
    expect(storedRoles).toEqual(["admin", "admin", "user", "user", "user"]);
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
