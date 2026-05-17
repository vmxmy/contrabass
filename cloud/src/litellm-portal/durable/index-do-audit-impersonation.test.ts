import { describe, it, expect } from "vitest";
import { IndexDO } from "./index-do";
import type { LiteLLMPortalEnv } from "../types";
import { makeTestSqlStorage } from "../../test/sql-storage";

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

function makeStorage(sql?: SqlStorage): MockStorage & { sql?: SqlStorage } {
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
  return storage;
}

function makeSqlIndexDO() {
  const storage = makeStorage(makeTestSqlStorage());
  const env = {} as LiteLLMPortalEnv;
  const ctx = { storage } as unknown as DurableObjectState;
  const obj = new IndexDO(ctx, env);
  return { obj };
}

describe("IndexDO audit impersonation envelope (SQL path)", () => {
  it("round-trips an audit event WITH an impersonation envelope", async () => {
    // #given
    const { obj } = makeSqlIndexDO();
    const ts = "2026-01-03T00:00:00.000Z";

    // #when
    await obj.appendAudit({
      id: "imp-1",
      ts,
      actorEmail: "o@x.com",
      action: "test",
      entityKind: "k",
      entityId: "e",
      before: null,
      after: null,
      reason: null,
      impersonation: {
        realActor: "o@x.com",
        effectiveTeam: "t1",
        viaImpersonation: true,
      },
    });
    const audit = await obj.listAudit();

    // #then
    expect(audit.length).toBe(1);
    expect(audit[0].impersonation).toEqual({
      realActor: "o@x.com",
      effectiveTeam: "t1",
      viaImpersonation: true,
    });
  });

  it("stores null impersonation when the event is not impersonated", async () => {
    // #given
    const { obj } = makeSqlIndexDO();
    const ts = "2026-01-03T01:00:00.000Z";

    // #when
    await obj.appendAudit({
      id: "imp-2",
      ts,
      actorEmail: "o@x.com",
      action: "test",
      entityKind: "k",
      entityId: "e",
      before: null,
      after: null,
      reason: null,
    });
    const audit = await obj.listAudit();

    // #then
    expect(audit.length).toBe(1);
    expect(audit[0].impersonation == null).toBe(true);
  });
});
