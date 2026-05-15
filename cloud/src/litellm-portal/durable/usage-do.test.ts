import { describe, it, expect } from "vitest";
import { UsageDO } from "./usage-do";
import type { LiteLLMPortalEnv } from "../types";
import { makeTestSqlStorage } from "../../test/sql-storage";

function makeUsageDO() {
  const env = {} as LiteLLMPortalEnv;
  const ctx = { storage: { sql: makeTestSqlStorage() } } as unknown as DurableObjectState;
  return new UsageDO(ctx, env);
}

describe("UsageDO schema", () => {
  it("initializes tables and is idempotent across calls", async () => {
    const obj = makeUsageDO();
    await obj.writeSpendEvents([]);
    await expect(obj.writeSpendEvents([])).resolves.toBeUndefined();
  });
});

describe("UsageDO writeSpendEvents dedupe + cursor", () => {
  it("INSERT OR IGNORE dedupes by requestId across calls", async () => {
    const obj = makeUsageDO();
    const ev = {
      requestId: "r1",
      tsMs: 1000,
      userId: "u1",
      teamId: "t1",
      model: "gpt",
      promptTokens: 1,
      completionTokens: 2,
      totalTokens: 3,
      spend: 0.5,
    };
    await obj.writeSpendEvents([ev]);
    await obj.writeSpendEvents([{ ...ev, spend: 999 }]);
    const recent = await obj.queryRecentEvents({ userId: "u1", limit: 10 });
    expect(recent).toEqual([{ tsMs: 1000, model: "gpt", totalTokens: 3, spend: 0.5 }]);
  });

  it("sync cursor get returns null then round-trips set", async () => {
    const obj = makeUsageDO();
    expect(await obj.getSyncCursor("spend_logs")).toBeNull();
    await obj.setSyncCursor("spend_logs", { cursorMs: 5000, lastError: null });
    expect(await obj.getSyncCursor("spend_logs")).toBe(5000);
  });
});

describe("UsageDO upsertDailyRows + pruneRetention", () => {
  it("upsert overwrites the (date,user,model) row", async () => {
    const obj = makeUsageDO();
    const base = {
      date: "2026-05-10",
      userId: "__global__",
      model: "gpt",
      spend: 1,
      totalTokens: 10,
      promptTokens: 4,
      completionTokens: 6,
      requests: 2,
      successRequests: 2,
      failedRequests: 0,
    };
    await obj.upsertDailyRows([base]);
    await obj.upsertDailyRows([{ ...base, spend: 9, requests: 5 }]);
    const k = await obj.queryKpiWithDelta({
      scope: { kind: "global" },
      currentFromMs: Date.parse("2026-05-10T00:00:00+08:00"),
      currentToMs: Date.parse("2026-05-11T00:00:00+08:00"),
      previousFromMs: Date.parse("2026-05-09T00:00:00+08:00"),
      previousToMs: Date.parse("2026-05-10T00:00:00+08:00"),
    });
    expect(k.current.spend).toBe(9);
    expect(k.current.requests).toBe(5);
  });

  it("pruneRetention deletes old events and old daily rows", async () => {
    const obj = makeUsageDO();
    const now = Date.parse("2026-05-15T12:00:00+08:00");
    await obj.writeSpendEvents([
      {
        requestId: "old",
        tsMs: now - 40 * 86400000,
        userId: "u1",
        teamId: "t",
        model: "m",
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 1,
        spend: 0,
      },
      {
        requestId: "fresh",
        tsMs: now - 1 * 86400000,
        userId: "u1",
        teamId: "t",
        model: "m",
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 1,
        spend: 0,
      },
    ]);
    await obj.upsertDailyRows([
      {
        date: "2024-01-01",
        userId: "__global__",
        model: "m",
        spend: 0,
        totalTokens: 0,
        promptTokens: 0,
        completionTokens: 0,
        requests: 0,
        successRequests: null,
        failedRequests: null,
      },
    ]);
    await obj.pruneRetention(now);
    const recent = await obj.queryRecentEvents({ userId: "u1", limit: 10 });
    expect(recent.map((r) => r.tsMs)).toEqual([now - 1 * 86400000]);
    expect(await obj.countDailyRows()).toBe(0);
  });
});
