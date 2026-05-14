import { describe, it, expect } from "vitest";
import { IndexDO } from "./index-do";
import type { LiteLLMPortalEnv } from "../types";

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

function makeStorage(): { data: Map<string, unknown>; storage: MockStorage; getAlarm: () => number | null } {
  const data = new Map<string, unknown>();
  let alarm: number | null = null;
  const storage: MockStorage = {
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
});
