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

describe("UsageDO queryTimeseries + queryModelBreakdown", () => {
  const day0 = Date.parse("2026-05-12T10:00:00+08:00");
  const day1 = Date.parse("2026-05-13T10:00:00+08:00");

  async function seed(obj: UsageDO) {
    await obj.writeSpendEvents([
      {
        requestId: "a",
        tsMs: day0,
        userId: "u1",
        teamId: "t",
        model: "gpt",
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
        spend: 1,
      },
      {
        requestId: "b",
        tsMs: day1,
        userId: "u1",
        teamId: "t",
        model: "gpt",
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 3,
        spend: 2,
      },
      {
        requestId: "c",
        tsMs: day1,
        userId: "u2",
        teamId: "t",
        model: "claude",
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 5,
        spend: 4,
      },
    ]);
  }

  it("queryTimeseries day grain buckets by Asia/Shanghai day, global scope", async () => {
    const obj = makeUsageDO();
    await seed(obj);
    const r = await obj.queryTimeseries({
      scope: { kind: "global" },
      grain: "day",
      fromMs: Date.parse("2026-05-12T00:00:00+08:00"),
      toMs: Date.parse("2026-05-14T00:00:00+08:00"),
    });
    expect(r.map((b) => [b.label, b.spend, b.requests])).toEqual([
      ["05-12", 1, 1],
      ["05-13", 6, 2],
    ]);
  });

  it("queryModelBreakdown aggregates per model, user scope", async () => {
    const obj = makeUsageDO();
    await seed(obj);
    const r = await obj.queryModelBreakdown({
      scope: { kind: "user", userId: "u1" },
      fromMs: Date.parse("2026-05-12T00:00:00+08:00"),
      toMs: Date.parse("2026-05-14T00:00:00+08:00"),
    });
    expect(r).toEqual([{ model: "gpt", spend: 3, totalTokens: 5, requests: 2 }]);
  });
});

describe("UsageDO hourOfDay + perUserSeries + userDetail", () => {
  const t09 = Date.parse("2026-05-13T09:30:00+08:00");
  const t09b = Date.parse("2026-05-13T09:45:00+08:00");
  const t14 = Date.parse("2026-05-13T14:00:00+08:00");

  async function seed(obj: UsageDO) {
    await obj.writeSpendEvents([
      {
        requestId: "a",
        tsMs: t09,
        userId: "u1",
        teamId: "t",
        model: "gpt",
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 2,
        spend: 1,
      },
      {
        requestId: "b",
        tsMs: t09b,
        userId: "u1",
        teamId: "t",
        model: "gpt",
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 3,
        spend: 2,
      },
      {
        requestId: "c",
        tsMs: t14,
        userId: "u2",
        teamId: "t",
        model: "claude",
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 4,
        spend: 3,
      },
    ]);
  }

  it("queryHourOfDay returns 24 buckets, summed into hour-of-day", async () => {
    const obj = makeUsageDO();
    await seed(obj);
    const r = await obj.queryHourOfDay({
      scope: { kind: "global" },
      fromMs: Date.parse("2026-05-13T00:00:00+08:00"),
      toMs: Date.parse("2026-05-14T00:00:00+08:00"),
    });
    expect(r).toHaveLength(24);
    expect(r[9]).toEqual({ hour: 9, totalTokens: 5, requests: 2, spend: 3 });
    expect(r[14]).toEqual({ hour: 14, totalTokens: 4, requests: 1, spend: 3 });
    expect(r[0]).toEqual({ hour: 0, totalTokens: 0, requests: 0, spend: 0 });
  });

  it("queryPerUserSeries returns one series per user, topN by spend", async () => {
    const obj = makeUsageDO();
    await seed(obj);
    const r = await obj.queryPerUserSeries({
      grain: "day",
      fromMs: Date.parse("2026-05-13T00:00:00+08:00"),
      toMs: Date.parse("2026-05-14T00:00:00+08:00"),
      topN: 5,
    });
    const u2 = r.find((s) => s.userId === "u2");
    const u1 = r.find((s) => s.userId === "u1");
    expect(u2?.points[0].spend).toBe(3);
    expect(u1?.points[0].spend).toBe(3);
  });

  it("queryUserDetail aggregates models + hours for one user", async () => {
    const obj = makeUsageDO();
    await seed(obj);
    const d = await obj.queryUserDetail({
      userId: "u1",
      fromMs: Date.parse("2026-05-13T00:00:00+08:00"),
      toMs: Date.parse("2026-05-14T00:00:00+08:00"),
    });
    expect(d.spend).toBe(3);
    expect(d.requests).toBe(2);
    expect(d.models).toEqual([{ model: "gpt", spend: 3, totalTokens: 5, requests: 2 }]);
    expect(d.hours[9]).toEqual({ hour: 9, totalTokens: 5, requests: 2, spend: 3 });
  });

  it("queryUserDetail stays consistent for a user with daily rows but no events (no fallback)", async () => {
    const obj = makeUsageDO();
    await obj.upsertDailyRows([
      {
        date: "2026-05-13",
        userId: "u9",
        model: "gpt",
        spend: 42,
        totalTokens: 100,
        promptTokens: 0,
        completionTokens: 0,
        requests: 7,
        successRequests: 7,
        failedRequests: 0,
      },
    ]);
    const d = await obj.queryUserDetail({
      userId: "u9",
      fromMs: Date.parse("2026-05-13T00:00:00+08:00"),
      toMs: Date.parse("2026-05-14T00:00:00+08:00"),
    });
    // KPI is events-only (eventsOnly: true) → consistent with empty models/hours, NOT the daily 42/7.
    expect(d.spend).toBe(0);
    expect(d.requests).toBe(0);
    expect(d.totalTokens).toBe(0);
    expect(d.models).toEqual([]);
    expect(d.hours.every((h) => h.totalTokens === 0 && h.requests === 0 && h.spend === 0)).toBe(true);
  });
});
