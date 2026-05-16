import { describe, it, expect } from "vitest";
import { IndexDO } from "./index-do";
import type { LiteLLMPortalEnv } from "../types";
import { makeTestSqlStorage } from "../../test/sql-storage";

// ---------------------------------------------------------------------------
// In-memory Storage mock
// ---------------------------------------------------------------------------

interface MockStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(opts?: {
    prefix?: string;
    limit?: number;
    reverse?: boolean;
    startAfter?: string;
  }): Promise<Map<string, T>>;
  transaction<T>(fn: (txn: MockStorage) => Promise<T>): Promise<T>;
  setAlarm(time: number): Promise<void>;
  getAlarm(): Promise<number | null>;
}

function makeStorage(sql?: SqlStorage): { data: Map<string, unknown>; storage: MockStorage & { sql?: SqlStorage }; getAlarm: () => number | null } {
  const data = new Map<string, unknown>();
  let alarm: number | null = null;
  const storage: MockStorage & { sql?: SqlStorage } = {
    async get<T>(key: string): Promise<T | undefined> {
      return data.get(key) as T | undefined;
    },
    async put<T>(key: string, value: T): Promise<void> {
      data.set(key, value);
    },
    async delete(key: string): Promise<boolean> {
      return data.delete(key);
    },
    async list<T>(opts?: {
      prefix?: string;
      limit?: number;
      reverse?: boolean;
      startAfter?: string;
    }): Promise<Map<string, T>> {
      let entries = Array.from(data.entries()).filter(
        ([k]) => !opts?.prefix || k.startsWith(opts.prefix)
      );
      if (opts?.startAfter != null) {
        entries = entries.filter(([k]) => k > opts.startAfter!);
      }
      entries.sort(([a], [b]) =>
        opts?.reverse ? b.localeCompare(a) : a.localeCompare(b)
      );
      if (opts?.limit != null) {
        entries = entries.slice(0, opts.limit);
      }
      return new Map(entries as [string, T][]);
    },
    async transaction<T>(fn: (txn: MockStorage) => Promise<T>): Promise<T> {
      return fn(storage);
    },
    async setAlarm(time: number): Promise<void> {
      alarm = time;
    },
    async getAlarm(): Promise<number | null> {
      return alarm;
    },
  };
  if (sql) storage.sql = sql;
  return {
    data,
    storage,
    getAlarm: () => alarm,
  };
}

function makeIndexDO() {
  const { data, storage } = makeStorage();
  const env = {} as LiteLLMPortalEnv;
  // IndexDO extends DurableObject which stores ctx and env as-is
  const ctx = { storage } as unknown as DurableObjectState;
  const obj = new IndexDO(ctx, env);
  return { obj, data, storage };
}

function makeSqlIndexDO() {
  const { data, storage } = makeStorage(makeTestSqlStorage());
  const env = {} as LiteLLMPortalEnv;
  const ctx = { storage } as unknown as DurableObjectState;
  const obj = new IndexDO(ctx, env);
  return { obj, data, storage };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("IndexDO", () => {
  it("setTeamsList + listTeams roundtrip", async () => {
    const { obj } = makeIndexDO();
    await obj.setTeamsList([
      { id: "t1", alias: "a" },
      { id: "t2", alias: "b" },
    ]);
    const teams = await obj.listTeams();
    expect(teams).toEqual([
      { id: "t1", alias: "a" },
      { id: "t2", alias: "b" },
    ]);
  });

  it("listTeams returns empty array when nothing stored", async () => {
    const { obj } = makeIndexDO();
    const teams = await obj.listTeams();
    expect(teams).toEqual([]);
  });

  it("putUser writes both user:{id} and email:{lc} keys", async () => {
    const { obj, data } = makeIndexDO();
    const record = {
      userId: "u1",
      email: "Alice@Example.com",
      role: "admin" as const,
      teamId: "t1",
      createdAt: new Date().toISOString(),
    };
    await obj.putUser(record);
    expect(data.has("user:u1")).toBe(true);
    expect(data.has("email:alice@example.com")).toBe(true);
  });

  it("getUserByEmail lowercases lookup and follows pointer", async () => {
    const { obj } = makeIndexDO();
    await obj.putUser({
      userId: "u1",
      email: "alice@x.com",
      role: "user",
      teamId: null,
      createdAt: new Date().toISOString(),
    });
    const found = await obj.getUserByEmail("ALICE@X.COM");
    expect(found?.userId).toBe("u1");
  });

  it("getUserByEmail returns null for unknown email", async () => {
    const { obj } = makeIndexDO();
    const found = await obj.getUserByEmail("nobody@x.com");
    expect(found).toBeNull();
  });

  it("putUser reconciles a stale email-keyed placeholder to the canonical user_id (KV)", async () => {
    const { obj } = makeIndexDO();
    // Simulate a first-login placeholder keyed by email.
    await obj.putUser({
      userId: "xu@gz-zhiyun.com",
      email: "xu@gz-zhiyun.com",
      role: "user",
      teamId: null,
      createdAt: new Date().toISOString(),
    });
    // Importer later learns the real LiteLLM user_id for the same email.
    await obj.putUser({
      userId: "laoxu",
      email: "xu@gz-zhiyun.com",
      role: "user",
      teamId: null,
      createdAt: new Date().toISOString(),
    });

    const byEmail = await obj.getUserByEmail("xu@gz-zhiyun.com");
    expect(byEmail?.userId).toBe("laoxu");
    // The stale email-keyed record must be gone.
    expect(await obj.getUserById("xu@gz-zhiyun.com")).toBeNull();
    expect((await obj.getUserById("laoxu"))?.email).toBe("xu@gz-zhiyun.com");
  });

  it("putUser reconciles a stale email-keyed placeholder to the canonical user_id (SQL)", async () => {
    const { obj } = makeSqlIndexDO();
    await obj.putUser({
      userId: "xu@gz-zhiyun.com",
      email: "xu@gz-zhiyun.com",
      role: "user",
      teamId: null,
      createdAt: new Date().toISOString(),
    });
    await obj.putUser({
      userId: "laoxu",
      email: "xu@gz-zhiyun.com",
      role: "user",
      teamId: null,
      createdAt: new Date().toISOString(),
    });

    const byEmail = await obj.getUserByEmail("xu@gz-zhiyun.com");
    expect(byEmail?.userId).toBe("laoxu");
    expect(await obj.getUserById("xu@gz-zhiyun.com")).toBeNull();
    expect((await obj.listAllUsers()).users.map((u) => u.userId)).toEqual(["laoxu"]);
  });

  it("isImported returns false before markImported", async () => {
    const { obj } = makeIndexDO();
    expect(await obj.isImported()).toBe(false);
  });

  it("markImported sets isImported to true", async () => {
    const { obj } = makeIndexDO();
    await obj.markImported();
    expect(await obj.isImported()).toBe(true);
  });

  it("storeNonce + consumeNonce round-trip single-use", async () => {
    const { obj } = makeIndexDO();
    const nonce = {
      token: "abc",
      email: "alice@x.com",
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      consumedAt: null,
    };
    await obj.storeNonce(nonce);
    const first = await obj.consumeNonce("abc");
    expect(first).not.toBeNull();
    expect(first?.token).toBe("abc");
    // Second call: nonce is now consumed
    const second = await obj.consumeNonce("abc");
    expect(second).toBeNull();
  });

  it("consumeNonce returns null for expired nonce", async () => {
    const { obj } = makeIndexDO();
    await obj.storeNonce({
      token: "exp",
      email: "a@b.com",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      consumedAt: null,
    });
    expect(await obj.consumeNonce("exp")).toBeNull();
  });

  it("consumeNonce returns null for unknown token", async () => {
    const { obj } = makeIndexDO();
    expect(await obj.consumeNonce("unknown")).toBeNull();
  });

  it("storeNonce schedules alarm for earliest expiry", async () => {
    const { storage } = makeStorage();
    const env = {} as LiteLLMPortalEnv;
    const ctx = { storage } as unknown as DurableObjectState;
    const indexDO = new IndexDO(ctx, env);

    const later = Date.now() + 60000;
    const earlier = Date.now() + 30000;

    await indexDO.storeNonce({
      token: "t1",
      email: "a@b.com",
      expiresAt: new Date(later).toISOString(),
      consumedAt: null,
    });
    const firstAlarm = await storage.getAlarm();
    expect(firstAlarm).toBeCloseTo(later, -3);

    await indexDO.storeNonce({
      token: "t2",
      email: "a@b.com",
      expiresAt: new Date(earlier).toISOString(),
      consumedAt: null,
    });
    const secondAlarm = await storage.getAlarm();
    expect(secondAlarm).toBeLessThan(firstAlarm!);
  });

  it("storeNonce does not move alarm forward if existing alarm is earlier", async () => {
    const { storage } = makeStorage();
    const env = {} as LiteLLMPortalEnv;
    const ctx = { storage } as unknown as DurableObjectState;
    const indexDO = new IndexDO(ctx, env);

    const earlier = Date.now() + 10000;
    const later = Date.now() + 60000;

    await indexDO.storeNonce({
      token: "t1",
      email: "a@b.com",
      expiresAt: new Date(earlier).toISOString(),
      consumedAt: null,
    });
    const firstAlarm = await storage.getAlarm();

    await indexDO.storeNonce({
      token: "t2",
      email: "a@b.com",
      expiresAt: new Date(later).toISOString(),
      consumedAt: null,
    });
    const secondAlarm = await storage.getAlarm();
    // Alarm should remain at the earlier time
    expect(secondAlarm).toBe(firstAlarm);
  });

  it("appendAudit + listAudit returns reverse chronological order", async () => {
    const { obj } = makeIndexDO();
    const t1 = "2026-01-01T00:00:00.000Z";
    const t2 = "2026-01-02T00:00:00.000Z";
    await obj.appendAudit({
      id: "a1",
      ts: t1,
      actorEmail: "x@x.com",
      action: "test",
      entityKind: "k",
      entityId: "e",
      before: null,
      after: null,
      reason: null,
    });
    await obj.appendAudit({
      id: "a2",
      ts: t2,
      actorEmail: "x@x.com",
      action: "test",
      entityKind: "k",
      entityId: "e",
      before: null,
      after: null,
      reason: null,
    });
    const audit = await obj.listAudit();
    expect(audit.length).toBe(2);
    expect(audit[0].ts).toBe(t2); // newest first
    expect(audit[1].ts).toBe(t1);
  });

  it("listAllUsers cursor pagination", async () => {
    const { obj } = makeIndexDO();
    for (let i = 0; i < 5; i++) {
      await obj.putUser({
        userId: `u${i}`,
        email: `user${i}@x.com`,
        role: "user",
        teamId: null,
        createdAt: new Date().toISOString(),
      });
    }
    const page1 = await obj.listAllUsers({ limit: 2 });
    expect(page1.users.length).toBe(2);
    expect(page1.cursor).toBeDefined();

    const page2 = await obj.listAllUsers({ limit: 2, cursor: page1.cursor });
    expect(page2.users.length).toBe(2);
    // Pages must not overlap
    const page1Ids = new Set(page1.users.map((u) => u.userId));
    for (const u of page2.users) {
      expect(page1Ids.has(u.userId)).toBe(false);
    }
  });

  it("listAllUsers cursor is undefined on last page", async () => {
    const { obj } = makeIndexDO();
    for (let i = 0; i < 3; i++) {
      await obj.putUser({
        userId: `u${i}`,
        email: `user${i}@x.com`,
        role: "user",
        teamId: null,
        createdAt: new Date().toISOString(),
      });
    }
    // Request more than exist
    const result = await obj.listAllUsers({ limit: 10 });
    expect(result.users.length).toBe(3);
    expect(result.cursor).toBeUndefined();
  });

  it("alarm cleans up expired nonces and reschedules for remaining", async () => {
    const { obj } = makeIndexDO();
    const expired = {
      token: "old",
      email: "a@b.com",
      expiresAt: new Date(Date.now() - 5000).toISOString(),
      consumedAt: null,
    };
    const future = {
      token: "new",
      email: "a@b.com",
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      consumedAt: null,
    };
    await obj.storeNonce(expired);
    await obj.storeNonce(future);
    await obj.alarm();
    // Expired nonce should be gone
    expect(await obj.consumeNonce("old")).toBeNull();
    // Future nonce still retrievable (not expired)
    const found = await obj.consumeNonce("new");
    expect(found).not.toBeNull();
  });

  it("SQL path backfills legacy KV and can delete legacy keys", async () => {
    const { obj, data } = makeSqlIndexDO();
    data.set("teams:list", [{ id: "t1", alias: "team one" }]);
    data.set("user:u1", {
      userId: "u1",
      email: "Alice@Example.com",
      role: "admin",
      teamId: "t1",
      createdAt: new Date().toISOString(),
    });
    data.set("email:alice@example.com", { userId: "u1", teamId: "t1", role: "admin" });
    data.set("meta:imported", true);

    const beforeCleanup = await obj.getStorageMigrationState();
    expect(beforeCleanup.backend).toBe("sql");
    expect(beforeCleanup.teams).toBe(1);
    expect(beforeCleanup.users).toBe(1);
    expect(beforeCleanup.legacyKeys).toBe(4);
    expect((await obj.getUserByEmail("alice@example.com"))?.userId).toBe("u1");
    expect(await obj.isImported()).toBe(true);

    const cleanup = await obj.deleteLegacyKV();
    expect(cleanup).toEqual({ deleted: 4, skipped: false });
    expect(data.size).toBe(0);
    expect(await obj.listTeams()).toEqual([{ id: "t1", alias: "team one" }]);
    expect((await obj.getUserById("u1"))?.email).toBe("Alice@Example.com");
    expect((await obj.getStorageMigrationState()).legacyKvDeleted).toBe(true);
  });

  it("SQL path writes new records without creating legacy KV keys", async () => {
    const { obj, data } = makeSqlIndexDO();
    await obj.setTeamsList([{ id: "t2", alias: "team two" }]);
    await obj.putUser({
      userId: "u2",
      email: "bob@example.com",
      role: "user",
      teamId: "t2",
      createdAt: new Date().toISOString(),
    });

    expect(data.size).toBe(0);
    expect((await obj.getStorageMigrationState()).users).toBe(1);
    expect((await obj.listAllUsers()).users.map((u) => u.userId)).toEqual(["u2"]);
  });

  // -------------------------------------------------------------------------
  // Invites (admin-invite tenant onboarding)
  // -------------------------------------------------------------------------

  function pendingInvite(overrides: Partial<{ emailLc: string; teamId: string; teamRole: "admin" | "user"; invitedBy: string }> = {}) {
    return {
      emailLc: "invitee@x.com",
      teamId: "t1",
      teamRole: "user" as const,
      status: "pending" as const,
      invitedBy: "admin@x.com",
      createdAt: new Date().toISOString(),
      consumedAt: null,
      ...overrides,
    };
  }

  for (const [label, make] of [
    ["KV", makeIndexDO],
    ["SQL", makeSqlIndexDO],
  ] as const) {
    it(`putInvite + getInvite roundtrip (${label})`, async () => {
      // #given
      const { obj } = make();
      const inv = pendingInvite();
      // #when
      await obj.putInvite(inv);
      // #then
      expect(await obj.getInvite("invitee@x.com")).toEqual(inv);
    });

    it(`getInvite returns null for unknown email (${label})`, async () => {
      const { obj } = make();
      expect(await obj.getInvite("nobody@x.com")).toBeNull();
    });

    it(`putInvite upserts on emailLc — re-invite overwrites (${label})`, async () => {
      // #given an existing pending invite to t1
      const { obj } = make();
      await obj.putInvite(pendingInvite({ teamId: "t1" }));
      // #when re-invited to a different team
      await obj.putInvite(pendingInvite({ teamId: "t2", teamRole: "admin" }));
      // #then latest wins, single row
      const got = await obj.getInvite("invitee@x.com");
      expect(got?.teamId).toBe("t2");
      expect(got?.teamRole).toBe("admin");
      expect((await obj.listInvites()).length).toBe(1);
    });

    it(`listInvites filters by status (${label})`, async () => {
      const { obj } = make();
      await obj.putInvite(pendingInvite({ emailLc: "a@x.com" }));
      await obj.putInvite(pendingInvite({ emailLc: "b@x.com" }));
      await obj.markInviteConsumed("b@x.com");
      expect((await obj.listInvites({ status: "pending" })).map((i) => i.emailLc)).toEqual(["a@x.com"]);
      expect((await obj.listInvites({ status: "consumed" })).map((i) => i.emailLc)).toEqual(["b@x.com"]);
      expect((await obj.listInvites()).length).toBe(2);
    });

    it(`markInviteConsumed is idempotent (${label})`, async () => {
      // #given
      const { obj } = make();
      await obj.putInvite(pendingInvite());
      // #when consumed once
      const first = await obj.markInviteConsumed("invitee@x.com");
      // #then status flips and consumedAt set
      expect(first?.status).toBe("consumed");
      expect(first?.consumedAt).not.toBeNull();
      // #when consumed again — no-op, returns the already-consumed record unchanged
      const second = await obj.markInviteConsumed("invitee@x.com");
      expect(second?.status).toBe("consumed");
      expect(second?.consumedAt).toBe(first?.consumedAt);
    });

    it(`markInviteConsumed returns null for unknown email (${label})`, async () => {
      const { obj } = make();
      expect(await obj.markInviteConsumed("nobody@x.com")).toBeNull();
    });

    it(`revokeInvite flips pending → revoked (${label})`, async () => {
      const { obj } = make();
      await obj.putInvite(pendingInvite());
      const revoked = await obj.revokeInvite("invitee@x.com");
      expect(revoked?.status).toBe("revoked");
      expect((await obj.getInvite("invitee@x.com"))?.status).toBe("revoked");
    });

    it(`revokeInvite on a consumed invite returns it unchanged (caller maps 409) (${label})`, async () => {
      const { obj } = make();
      await obj.putInvite(pendingInvite());
      await obj.markInviteConsumed("invitee@x.com");
      const result = await obj.revokeInvite("invitee@x.com");
      expect(result?.status).toBe("consumed");
      // must NOT have been downgraded to revoked
      expect((await obj.getInvite("invitee@x.com"))?.status).toBe("consumed");
    });

    it(`revokeInvite returns null for unknown email (${label})`, async () => {
      const { obj } = make();
      expect(await obj.revokeInvite("nobody@x.com")).toBeNull();
    });
  }

  it("SQL path stores invites without creating legacy KV keys", async () => {
    const { obj, data } = makeSqlIndexDO();
    await obj.putInvite(pendingInvite());
    expect(data.size).toBe(0);
    expect((await obj.getInvite("invitee@x.com"))?.teamId).toBe("t1");
  });

});
