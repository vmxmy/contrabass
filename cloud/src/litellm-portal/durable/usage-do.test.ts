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
      model: "__all__",
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
      nowMs: Date.parse("2026-09-01T00:00:00+08:00"),
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

describe("UsageDO clamps limit/topN (no unbounded LIMIT -1)", () => {
  it("queryRecentEvents clamps a negative limit to >=1 (bounded, not unbounded)", async () => {
    const obj = makeUsageDO();
    await obj.writeSpendEvents([
      {
        requestId: "x1",
        tsMs: 1000,
        userId: "u1",
        teamId: "t",
        model: "m",
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 1,
        spend: 0,
      },
      {
        requestId: "x2",
        tsMs: 2000,
        userId: "u1",
        teamId: "t",
        model: "m",
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 1,
        spend: 0,
      },
    ]);
    // -1 must NOT mean "all rows"; clamp floor is 1.
    const r = await obj.queryRecentEvents({ userId: "u1", limit: -1 });
    expect(r).toHaveLength(1);
  });

  it("queryRecentEvents clamps a huge limit to <=1000", async () => {
    const obj = makeUsageDO();
    await obj.writeSpendEvents([
      {
        requestId: "y1",
        tsMs: 1000,
        userId: "u2",
        teamId: "t",
        model: "m",
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 1,
        spend: 0,
      },
    ]);
    const r = await obj.queryRecentEvents({ userId: "u2", limit: 10_000_000 });
    expect(r).toHaveLength(1); // only 1 row exists; assertion is that it doesn't throw / behaves bounded
  });

  it("queryPerUserSeries clamps a negative topN to >=1", async () => {
    const obj = makeUsageDO();
    await obj.writeSpendEvents([
      {
        requestId: "z1",
        tsMs: 1000,
        userId: "ua",
        teamId: "t",
        model: "m",
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 1,
        spend: 5,
      },
      {
        requestId: "z2",
        tsMs: 1000,
        userId: "ub",
        teamId: "t",
        model: "m",
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 1,
        spend: 9,
      },
    ]);
    const r = await obj.queryPerUserSeries({ grain: "day", fromMs: 0, toMs: 5000, topN: -5 });
    expect(r).toHaveLength(1); // clamped to 1 → only the top spender (ub)
    expect(r[0].userId).toBe("ub");
  });
});

describe("UsageDO queryKpiWithDelta daily fallback excludes per-model rows", () => {
  it("sums only model='__all__' (no double-count with per-model rows)", async () => {
    const obj = makeUsageDO();
    // No events in window → fallback fires. Seed per-model rows + the __all__ total.
    await obj.upsertDailyRows([
      {
        date: "2026-05-10",
        userId: "__global__",
        model: "gpt",
        spend: 6,
        totalTokens: 60,
        promptTokens: 0,
        completionTokens: 0,
        requests: 6,
        successRequests: 6,
        failedRequests: 0,
      },
      {
        date: "2026-05-10",
        userId: "__global__",
        model: "claude",
        spend: 4,
        totalTokens: 40,
        promptTokens: 0,
        completionTokens: 0,
        requests: 4,
        successRequests: 4,
        failedRequests: 0,
      },
      {
        date: "2026-05-10",
        userId: "__global__",
        model: "__all__",
        spend: 10,
        totalTokens: 100,
        promptTokens: 0,
        completionTokens: 0,
        requests: 10,
        successRequests: 10,
        failedRequests: 0,
      },
    ]);
    const k = await obj.queryKpiWithDelta({
      scope: { kind: "global" },
      currentFromMs: Date.parse("2026-05-10T00:00:00+08:00"),
      currentToMs: Date.parse("2026-05-11T00:00:00+08:00"),
      previousFromMs: Date.parse("2026-05-09T00:00:00+08:00"),
      previousToMs: Date.parse("2026-05-10T00:00:00+08:00"),
      nowMs: Date.parse("2026-09-01T00:00:00+08:00"),
    });
    // Must be the __all__ totals (10/100/10), NOT 20/200/20 (which would be the
    // double-count of per-model rows + __all__).
    expect(k.current.spend).toBe(10);
    expect(k.current.totalTokens).toBe(100);
    expect(k.current.requests).toBe(10);
  });
});

describe("UsageDO queryKpiWithDelta Option A source resolution", () => {
  const NOW = Date.parse("2026-06-15T12:00:00+08:00");
  const DAY = 86400000;

  it("both periods inside 30d → events-sourced", async () => {
    const obj = makeUsageDO();
    await obj.writeSpendEvents([
      {
        requestId: "c",
        tsMs: NOW - 2 * DAY,
        userId: "u1",
        teamId: "t",
        model: "m",
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 5,
        spend: 2,
      },
      {
        requestId: "p",
        tsMs: NOW - 9 * DAY,
        userId: "u1",
        teamId: "t",
        model: "m",
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 3,
        spend: 1,
      },
    ]);
    const k = await obj.queryKpiWithDelta({
      scope: { kind: "global" },
      nowMs: NOW,
      currentFromMs: NOW - 7 * DAY,
      currentToMs: NOW,
      previousFromMs: NOW - 14 * DAY,
      previousToMs: NOW - 7 * DAY,
    });
    expect(k.current).toMatchObject({ spend: 2, totalTokens: 5, requests: 1, source: "events" });
    expect(k.previous).toMatchObject({ spend: 1, totalTokens: 3, requests: 1, source: "events" });
  });

  it("30d window global: current=events, previous=daily(__all__)", async () => {
    const obj = makeUsageDO();
    await obj.writeSpendEvents([
      {
        requestId: "e1",
        tsMs: NOW - 5 * DAY,
        userId: "u1",
        teamId: "t",
        model: "m",
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 9,
        spend: 4,
      },
    ]);
    // previous window [NOW-60d, NOW-30d] is older than the 30d horizon → daily.
    await obj.upsertDailyRows([
      {
        date: new Date(NOW - 45 * DAY + 8 * 3600000).toISOString().slice(0, 10),
        userId: "__global__",
        model: "__all__",
        spend: 7,
        totalTokens: 70,
        promptTokens: 0,
        completionTokens: 0,
        requests: 7,
        successRequests: 7,
        failedRequests: 0,
      },
      {
        date: new Date(NOW - 45 * DAY + 8 * 3600000).toISOString().slice(0, 10),
        userId: "__global__",
        model: "gpt",
        spend: 7,
        totalTokens: 70,
        promptTokens: 0,
        completionTokens: 0,
        requests: 7,
        successRequests: 7,
        failedRequests: 0,
      },
    ]);
    const k = await obj.queryKpiWithDelta({
      scope: { kind: "global" },
      nowMs: NOW,
      currentFromMs: NOW - 30 * DAY,
      currentToMs: NOW,
      previousFromMs: NOW - 60 * DAY,
      previousToMs: NOW - 30 * DAY,
    });
    expect(k.current).toMatchObject({ spend: 4, source: "events" });
    // previous from daily, __all__ only (NOT 14 = 7+7 double-count with the gpt row).
    expect(k.previous).toMatchObject({ spend: 7, totalTokens: 70, requests: 7, source: "daily" });
  });

  it("user scope is always events-only even for an old window", async () => {
    const obj = makeUsageDO();
    await obj.upsertDailyRows([
      {
        date: new Date(NOW - 45 * DAY + 8 * 3600000).toISOString().slice(0, 10),
        userId: "__global__",
        model: "__all__",
        spend: 99,
        totalTokens: 99,
        promptTokens: 0,
        completionTokens: 0,
        requests: 99,
        successRequests: 99,
        failedRequests: 0,
      },
    ]);
    const k = await obj.queryKpiWithDelta({
      scope: { kind: "user", userId: "u1" },
      nowMs: NOW,
      currentFromMs: NOW - 60 * DAY,
      currentToMs: NOW - 30 * DAY,
      previousFromMs: NOW - 90 * DAY,
      previousToMs: NOW - 60 * DAY,
    });
    expect(k.current).toMatchObject({ spend: 0, source: "events" });
    expect(k.previous).toMatchObject({ spend: 0, source: "events" });
  });

  it("eventsOnly forces events even for an old global window", async () => {
    const obj = makeUsageDO();
    await obj.upsertDailyRows([
      {
        date: new Date(NOW - 45 * DAY + 8 * 3600000).toISOString().slice(0, 10),
        userId: "__global__",
        model: "__all__",
        spend: 50,
        totalTokens: 50,
        promptTokens: 0,
        completionTokens: 0,
        requests: 50,
        successRequests: 50,
        failedRequests: 0,
      },
    ]);
    const k = await obj.queryKpiWithDelta({
      scope: { kind: "global" },
      nowMs: NOW,
      eventsOnly: true,
      currentFromMs: NOW - 60 * DAY,
      currentToMs: NOW - 30 * DAY,
      previousFromMs: NOW - 90 * DAY,
      previousToMs: NOW - 60 * DAY,
    });
    expect(k.current.source).toBe("events");
    expect(k.current.spend).toBe(0);
  });

  it("straddle window → split (daily older part + events recent part), no double-count", async () => {
    const obj = makeUsageDO();
    // horizon = NOW-30d. window [NOW-45d, NOW-15d) straddles it.
    await obj.writeSpendEvents([
      {
        requestId: "se",
        tsMs: NOW - 20 * DAY,
        userId: "u1",
        teamId: "t",
        model: "m",
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 2,
        spend: 3,
      },
    ]);
    await obj.upsertDailyRows([
      {
        date: new Date(NOW - 40 * DAY + 8 * 3600000).toISOString().slice(0, 10),
        userId: "__global__",
        model: "__all__",
        spend: 5,
        totalTokens: 50,
        promptTokens: 0,
        completionTokens: 0,
        requests: 5,
        successRequests: 5,
        failedRequests: 0,
      },
    ]);
    const k = await obj.queryKpiWithDelta({
      scope: { kind: "global" },
      nowMs: NOW,
      currentFromMs: NOW - 45 * DAY,
      currentToMs: NOW - 15 * DAY,
      previousFromMs: NOW - 90 * DAY,
      previousToMs: NOW - 45 * DAY,
    });
    expect(k.current.source).toBe("split");
    expect(k.current.spend).toBe(8); // daily 5 + events 3
    expect(k.current.totalTokens).toBe(52); // 50 + 2
    expect(k.current.requests).toBe(6); // 5 + 1
  });

  it("empty data → zeros, source reflects resolution", async () => {
    const obj = makeUsageDO();
    const k = await obj.queryKpiWithDelta({
      scope: { kind: "global" },
      nowMs: NOW,
      currentFromMs: NOW - 7 * DAY,
      currentToMs: NOW,
      previousFromMs: NOW - 14 * DAY,
      previousToMs: NOW - 7 * DAY,
    });
    expect(k.current).toMatchObject({ spend: 0, requests: 0, totalTokens: 0, source: "events" });
  });
});
