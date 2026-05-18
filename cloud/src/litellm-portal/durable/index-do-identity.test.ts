import { describe, it, expect } from "vitest";
import { IndexDO } from "./index-do";
import type { LiteLLMPortalEnv } from "../types";
import type { IdentityMapRecord } from "./schemas";
import { makeTestSqlStorage } from "../../test/sql-storage";

function makeStorage(sql: SqlStorage) {
  const data = new Map<string, unknown>();
  const storage = {
    async get<T>(k: string) { return data.get(k) as T | undefined; },
    async put<T>(k: string, v: T) { data.set(k, v); },
    async delete(k: string) { return data.delete(k); },
    async list() { return new Map(); },
    async transaction<T>(fn: (t: unknown) => Promise<T>) { return fn(storage); },
    async setAlarm() {},
    async getAlarm() { return null; },
    sql,
  };
  return storage;
}

function makeSqlIndexDO() {
  const storage = makeStorage(makeTestSqlStorage());
  const ctx = { storage } as unknown as DurableObjectState;
  return new IndexDO(ctx, {} as LiteLLMPortalEnv);
}

function rec(over: Partial<IdentityMapRecord> = {}): IdentityMapRecord {
  return {
    emailLc: "xu@ziikoo.com",
    litellmUserId: "laoxu",
    teams: ["ea0e8075-9937-4751-b412-0543212979bd"],
    userRole: "proxy_admin_viewer",
    origin: "recorded",
    lastReconciledAt: new Date().toISOString(),
    ...over,
  };
}

describe("IndexDO identity map", () => {
  it("putIdentity + getIdentityByEmail roundtrip (case/space-insensitive key)", async () => {
    const obj = makeSqlIndexDO();
    await obj.putIdentity(rec());
    const got = await obj.getIdentityByEmail("  XU@Ziikoo.com  ");
    expect(got?.litellmUserId).toBe("laoxu");
    expect(got?.teams).toEqual(["ea0e8075-9937-4751-b412-0543212979bd"]);
    expect(got?.origin).toBe("recorded");
  });

  it("getIdentityByUserId resolves the reverse direction", async () => {
    const obj = makeSqlIndexDO();
    await obj.putIdentity(rec());
    const got = await obj.getIdentityByUserId("laoxu");
    expect(got?.emailLc).toBe("xu@ziikoo.com");
  });

  it("putIdentity upserts on email_lc (origin can be promoted)", async () => {
    const obj = makeSqlIndexDO();
    await obj.putIdentity(rec({ origin: "recorded" }));
    await obj.putIdentity(rec({ origin: "migrated", litellmUserId: "laoxu-3f9a1c20" }));
    const got = await obj.getIdentityByEmail("xu@ziikoo.com");
    expect(got?.origin).toBe("migrated");
    expect(got?.litellmUserId).toBe("laoxu-3f9a1c20");
  });

  it("listIdentities paginates by email_lc cursor", async () => {
    const obj = makeSqlIndexDO();
    await obj.putIdentity(rec({ emailLc: "a@x.com", litellmUserId: "a" }));
    await obj.putIdentity(rec({ emailLc: "b@x.com", litellmUserId: "b" }));
    await obj.putIdentity(rec({ emailLc: "c@x.com", litellmUserId: "c" }));
    const p1 = await obj.listIdentities({ limit: 2 });
    expect(p1.identities.map((i) => i.emailLc)).toEqual(["a@x.com", "b@x.com"]);
    expect(p1.cursor).toBe("b@x.com");
    const p2 = await obj.listIdentities({ limit: 2, cursor: p1.cursor });
    expect(p2.identities.map((i) => i.emailLc)).toEqual(["c@x.com"]);
    expect(p2.cursor).toBeUndefined();
  });

  it("deleteIdentity removes the row", async () => {
    const obj = makeSqlIndexDO();
    await obj.putIdentity(rec());
    await obj.deleteIdentity("xu@ziikoo.com");
    expect(await obj.getIdentityByEmail("xu@ziikoo.com")).toBeNull();
  });

  it("identity table is additive — existing user CRUD still works", async () => {
    const obj = makeSqlIndexDO();
    await obj.putUser({
      userId: "laoxu",
      email: "xu@ziikoo.com",
      role: "admin",
      teamId: null,
      createdAt: new Date().toISOString(),
    });
    await obj.putIdentity(rec());
    const user = await obj.getUserByEmail("xu@ziikoo.com");
    const identity = await obj.getIdentityByEmail("xu@ziikoo.com");
    expect(user?.userId).toBe("laoxu");
    expect(identity?.litellmUserId).toBe("laoxu");
  });
});
