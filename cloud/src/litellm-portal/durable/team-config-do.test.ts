import { describe, it, expect } from "vitest";
import { TeamConfigDO } from "./team-config-do";
import type { LiteLLMPortalEnv } from "../types";

interface MockStorage {
  get<T>(k: string): Promise<T | undefined>;
  put<T>(k: string, v: T): Promise<void>;
  delete(k: string): Promise<boolean>;
  list<T>(opts?: { prefix?: string }): Promise<Map<string, T>>;
  transaction<T>(fn: (txn: MockStorage) => Promise<T>): Promise<T>;
}

function makeStorage() {
  const data = new Map<string, unknown>();
  const storage: MockStorage = {
    async get<T>(k: string): Promise<T | undefined> {
      return data.get(k) as T | undefined;
    },
    async put<T>(k: string, v: T): Promise<void> {
      data.set(k, v);
    },
    async delete(k: string): Promise<boolean> {
      return data.delete(k);
    },
    async list<T>(opts?: { prefix?: string }): Promise<Map<string, T>> {
      const all = Array.from(data.entries()).filter(
        ([k]) => !opts?.prefix || k.startsWith(opts.prefix),
      );
      return new Map(all as [string, T][]);
    },
    async transaction<T>(fn: (txn: MockStorage) => Promise<T>): Promise<T> {
      return fn(storage);
    },
  };
  return { data, storage };
}

function makeDO() {
  const { data, storage } = makeStorage();
  const ctx = { storage } as unknown as DurableObjectState;
  const env = {} as LiteLLMPortalEnv;
  const obj = new TeamConfigDO(ctx, env);
  return { obj, data };
}

describe("TeamConfigDO", () => {
  it("putTeam writes team + meta:dirty=true atomically", async () => {
    const { obj, data } = makeDO();
    const team = { id: "t1", alias: "a", models: ["gpt-4"], blocked: false };
    await obj.putTeam(team);
    expect(data.get("team")).toEqual(team);
    expect(data.get("meta:dirty")).toBe(true);
  });

  it("getTeam returns null when unset", async () => {
    const { obj } = makeDO();
    expect(await obj.getTeam()).toBeNull();
  });

  it("upsertMember + listMembers", async () => {
    const { obj } = makeDO();
    await obj.upsertMember({ userId: "u1", role: "admin" });
    await obj.upsertMember({ userId: "u2", role: "user" });
    const members = await obj.listMembers();
    expect(members.length).toBe(2);
  });

  it("removeMember removes the entry + sets dirty", async () => {
    const { obj, data } = makeDO();
    await obj.upsertMember({ userId: "u1", role: "admin" });
    data.set("meta:dirty", false);
    await obj.removeMember("u1");
    expect(await obj.listMembers()).toEqual([]);
    expect(data.get("meta:dirty")).toBe(true);
  });

  it("putSpend does NOT touch dirty (spend is mirror)", async () => {
    const { obj, data } = makeDO();
    data.set("meta:dirty", false);
    await obj.putSpend({
      teamId: "t1",
      currentSpend: 12.5,
      maxBudget: 100,
      fetchedAt: new Date().toISOString(),
    });
    expect(data.get("meta:dirty")).toBe(false);
    expect((data.get("spend:current") as { currentSpend: number }).currentSpend).toBe(12.5);
  });

  it("recordSyncSuccess clears dirty + error, sets lastSyncedAt and lastIdempotencyKey", async () => {
    const { obj, data } = makeDO();
    data.set("meta:dirty", true);
    data.set("meta:lastSyncError", "oops");
    await obj.recordSyncSuccess("idem-1");
    expect(data.get("meta:dirty")).toBe(false);
    expect(data.get("meta:lastSyncError")).toBeUndefined();
    expect(data.get("meta:lastSyncedAt")).toBeTypeOf("string");
    expect(data.get("meta:lastIdempotencyKey")).toBe("idem-1");
  });

  it("recordSyncError truncates reason to 200 chars", async () => {
    const { obj, data } = makeDO();
    const longReason = "x".repeat(500);
    await obj.recordSyncError(longReason);
    expect((data.get("meta:lastSyncError") as string).length).toBe(200);
  });

  it("getSyncMetadata returns null defaults", async () => {
    const { obj } = makeDO();
    expect(await obj.getSyncMetadata()).toEqual({
      lastSyncedAt: null,
      lastSyncError: null,
      dirty: false,
    });
  });

  it("upsertKey + listKeys + deleteKey", async () => {
    const { obj } = makeDO();
    const key = {
      id: "k1",
      alias: "key1",
      displayKey: "sk-...",
      userId: "u1",
      teamId: "t1",
      models: [],
      blocked: false,
      createdAt: new Date().toISOString(),
    };
    await obj.upsertKey(key);
    expect((await obj.listKeys()).length).toBe(1);
    await obj.deleteKey("k1");
    expect((await obj.listKeys()).length).toBe(0);
  });
});
