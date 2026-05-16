import { describe, it, expect } from "vitest";
import { parseDashboardRequest, toUsageScope, buildDashboard, buildSummary } from "./dashboard";
import type { UsageSource, IndexDOLike, UsageRollup } from "./dashboard-schemas";
import { DashboardResponseSchema } from "./dashboard-schemas";

function usageStub(over: Partial<UsageSource> = {}): UsageSource {
  return {
    queryTimeseries: async () => [{ startMs: 1, label: "05-01", totalTokens: 10, requests: 2, spend: 1 }],
    queryModelBreakdown: async () => [{ model: "gpt", spend: 1, totalTokens: 10, requests: 2 }],
    queryKpiWithDelta: async () => ({
      current: { spend: 5, requests: 3, totalTokens: 50 },
      previous: { spend: 4, requests: 2, totalTokens: 40 },
    }),
    ...over,
  };
}
function indexStub(): IndexDOLike {
  return {
    listTeams: async () => [
      { id: "t1", alias: "a" },
      { id: "t2", alias: "b" },
    ],
    listAllUsers: async () => ({
      users: [
        { userId: "u1", role: "admin", maxBudget: 10 },
        { userId: "u2", role: "user", maxBudget: 1 },
      ],
      cursor: undefined,
    }),
  };
}
function rollupStub(overUsers?: UsageRollup["users"]): UsageRollup {
  return {
    generatedAt: "2026-05-15T00:00:00Z",
    users: overUsers ?? [
      { userId: "u1", maxBudget: 10, win: { "24h": { spend: 0, requests: 0, totalTokens: 0 }, "48h": { spend: 0, requests: 0, totalTokens: 0 }, "7d": { spend: 2, requests: 1, totalTokens: 20 }, "30d": { spend: 5, requests: 3, totalTokens: 50 } } },
      { userId: "u2", maxBudget: 1,  win: { "24h": { spend: 0, requests: 0, totalTokens: 0 }, "48h": { spend: 0, requests: 0, totalTokens: 0 }, "7d": { spend: 5, requests: 2, totalTokens: 40 }, "30d": { spend: 8, requests: 4, totalTokens: 80 } } },
    ],
  };
}
const NOW = Date.parse("2026-05-15T00:00:00Z");

describe("parseDashboardRequest", () => {
  it("defaults window=30d, auto grain=day", () => {
    const r = parseDashboardRequest(new URL("https://x/api/usage/overview"));
    expect(r).toEqual({ ok: true, window: "30d", grain: "day", grainFallback: false });
  });

  it("accepts 24h with auto hour grain", () => {
    const r = parseDashboardRequest(new URL("https://x/api/usage/overview?window=24h"));
    expect(r).toEqual({ ok: true, window: "24h", grain: "hour", grainFallback: false });
  });

  it("rejects unsupported window with 400 body", () => {
    const r = parseDashboardRequest(new URL("https://x/o?window=90d"));
    expect(r).toEqual({
      ok: false,
      body: { error: "unsupported_usage_window", allowed: ["24h", "48h", "7d", "30d"] },
    });
  });

  it("incompatible explicit grain falls back to auto with flag", () => {
    const r = parseDashboardRequest(new URL("https://x/o?window=24h&grain=day"));
    expect(r).toEqual({ ok: true, window: "24h", grain: "hour", grainFallback: true });
  });

  it("toUsageScope maps self/member to user, global to global", () => {
    expect(toUsageScope({ kind: "self", userId: "u1" })).toEqual({ kind: "user", userId: "u1" });
    expect(toUsageScope({ kind: "member", userId: "m1" })).toEqual({ kind: "user", userId: "m1" });
    expect(toUsageScope({ kind: "global" })).toEqual({ kind: "global" });
  });
});

describe("buildDashboard", () => {
  it("self scope omits perUser/summary/recent, returns kpi/trend/models", async () => {
    const res = await buildDashboard(
      { usage: usageStub(), index: indexStub(), rollup: null, now: NOW },
      { scope: { kind: "self", userId: "u1" }, window: "7d", grain: "day", grainFallback: false },
    );
    expect(res.scope).toBe("self");
    expect(res).not.toHaveProperty("perUser");
    expect(res).not.toHaveProperty("summary");
    expect(res).not.toHaveProperty("recent");
    expect(res.kpi.spend).toEqual({ current: 5, previous: 4, deltaPct: 25 });
    expect(res.available).toBe(true);
    expect(res.empty).toBe(false);
  });

  it("global scope includes perUser from rollup + summary; no recent", async () => {
    const res = await buildDashboard(
      { usage: usageStub(), index: indexStub(), rollup: rollupStub(), now: NOW },
      { scope: { kind: "global" }, window: "7d", grain: "day", grainFallback: false },
    );
    expect(res.scope).toBe("global");
    expect(res).not.toHaveProperty("recent");
    // u2 spend=5 > u1 spend=2 for 7d → sorted desc, both > 0
    expect(res.perUser).toHaveLength(2);
    expect(res.perUser![0].userId).toBe("u2");
    // riskCount: u2 maxBudget=1, win[7d].spend=5 > 1 → risk; u1 maxBudget=10, win[7d].spend=2 ≤ 10 → no risk
    expect(res.summary).toEqual({
      userCount: 2,
      adminCount: 1,
      teamCount: 2,
      totalSpend: 5,
      totalBudget: 11,
      riskCount: 1,
      sampled: false,
    });
  });

  it("global scope with null rollup: perUser=[], riskCount=0", async () => {
    const res = await buildDashboard(
      { usage: usageStub(), index: indexStub(), rollup: null, now: NOW },
      { scope: { kind: "global" }, window: "7d", grain: "day", grainFallback: false },
    );
    expect(res.perUser).toHaveLength(0);
    expect(res.summary?.riskCount).toBe(0);
  });

  it("member scope shaped like self with member:<id> label, no recent", async () => {
    const res = await buildDashboard(
      { usage: usageStub(), index: indexStub(), rollup: null, now: NOW },
      { scope: { kind: "member", userId: "m9" }, window: "24h", grain: "hour", grainFallback: false },
    );
    expect(res.scope).toBe("member:m9");
    expect(res).not.toHaveProperty("perUser");
    expect(res).not.toHaveProperty("recent");
  });

  it("30d window: previous out of retention -> previous/deltaPct null", async () => {
    const res = await buildDashboard(
      { usage: usageStub(), index: indexStub(), rollup: null, now: NOW },
      { scope: { kind: "self", userId: "u1" }, window: "30d", grain: "day", grainFallback: false },
    );
    expect(res.kpi.spend.previous).toBeNull();
    expect(res.kpi.spend.deltaPct).toBeNull();
  });

  it("empty data -> available true, empty true", async () => {
    const empty = usageStub({
      queryTimeseries: async () => [],
      queryModelBreakdown: async () => [],
      queryKpiWithDelta: async () => ({
        current: { spend: 0, requests: 0, totalTokens: 0 },
        previous: { spend: 0, requests: 0, totalTokens: 0 },
      }),
    });
    const res = await buildDashboard(
      { usage: empty, index: indexStub(), rollup: null, now: NOW },
      { scope: { kind: "self", userId: "u1" }, window: "7d", grain: "day", grainFallback: false },
    );
    expect(res.available).toBe(true);
    expect(res.empty).toBe(true);
  });

  it("missing usage dep -> available false", async () => {
    const res = await buildDashboard(
      { usage: null, index: indexStub(), rollup: null, now: NOW },
      { scope: { kind: "self", userId: "u1" }, window: "7d", grain: "day", grainFallback: false },
    );
    expect(res.available).toBe(false);
    expect(res.empty).toBe(false);
  });

  it("global summary userCount reflects true total across pages", async () => {
    // Page 1: 200 regular users (no maxBudget)
    // Page 2: 50 more users; true total = 250
    const page1 = Array.from({ length: 200 }, (_, i) => ({
      userId: `u${i}`,
      role: "user" as const,
      maxBudget: undefined,
    }));
    const page2 = Array.from({ length: 50 }, (_, i) => ({
      userId: `v${i}`,
      role: "user" as const,
      maxBudget: undefined,
    }));
    let call = 0;
    const idx: IndexDOLike = {
      listTeams: async () => [{ id: "t1", alias: "a" }],
      listAllUsers: async () => {
        call += 1;
        if (call === 1) return { users: page1, cursor: "page2" };
        return { users: page2, cursor: undefined };
      },
    };
    const res = await buildDashboard(
      { usage: usageStub(), index: idx, rollup: null, now: NOW },
      { scope: { kind: "global" }, window: "7d", grain: "day", grainFallback: false },
    );
    // sampled is always false now (risk comes from rollup, not probes)
    expect(res.summary?.sampled).toBe(false);
    // userCount = true total (250)
    expect(res.summary?.userCount).toBe(250);
  });

  it("grainFallback:true is passed through to the response", async () => {
    const res = await buildDashboard(
      { usage: usageStub(), index: indexStub(), rollup: null, now: NOW },
      { scope: { kind: "self", userId: "u1" }, window: "24h", grain: "hour", grainFallback: true },
    );
    expect(res.grainFallback).toBe(true);
  });

  it("index null -> zeroed summary with passthrough totalSpend", async () => {
    const res = await buildDashboard(
      { usage: usageStub(), index: null, rollup: null, now: NOW },
      { scope: { kind: "global" }, window: "7d", grain: "day", grainFallback: false },
    );
    expect(res.summary).toEqual({
      userCount: 0,
      adminCount: 0,
      teamCount: 0,
      totalSpend: 5,
      totalBudget: 0,
      riskCount: 0,
      sampled: false,
    });
  });

  it("deltaPct null when previous is 0 but current > 0 (infinite growth → —)", async () => {
    const stub = usageStub({
      queryKpiWithDelta: async () => ({
        current: { spend: 5, requests: 3, totalTokens: 50 },
        previous: { spend: 0, requests: 0, totalTokens: 0 },
      }),
    });
    const res = await buildDashboard(
      { usage: stub, index: indexStub(), rollup: null, now: NOW },
      { scope: { kind: "self", userId: "u1" }, window: "7d", grain: "day", grainFallback: false },
    );
    expect(res.kpi.spend).toEqual({ current: 5, previous: 0, deltaPct: null });
  });
});

describe("buildSummary", () => {
  it("riskCount counts users whose rollup win spend > maxBudget", async () => {
    // u2 has maxBudget=1; win[7d].spend=5 → risk
    const rollup = rollupStub();
    const summary = await buildSummary({ usage: usageStub(), index: indexStub(), rollup, now: NOW }, 0, "7d");
    expect(summary.riskCount).toBe(1);
  });

  it("riskCount = 0 when rollup win spend <= maxBudget", async () => {
    const rollup = rollupStub([
      { userId: "u1", maxBudget: 10, win: { "24h": { spend: 0, requests: 0, totalTokens: 0 }, "48h": { spend: 0, requests: 0, totalTokens: 0 }, "7d": { spend: 2, requests: 1, totalTokens: 10 }, "30d": { spend: 2, requests: 1, totalTokens: 10 } } },
      { userId: "u2", maxBudget: 10, win: { "24h": { spend: 0, requests: 0, totalTokens: 0 }, "48h": { spend: 0, requests: 0, totalTokens: 0 }, "7d": { spend: 1, requests: 1, totalTokens: 10 }, "30d": { spend: 1, requests: 1, totalTokens: 10 } } },
    ]);
    const summary = await buildSummary({ usage: usageStub(), index: indexStub(), rollup, now: NOW }, 0, "7d");
    expect(summary.riskCount).toBe(0);
  });

  it("riskCount = 0 when rollup is null", async () => {
    const summary = await buildSummary({ usage: usageStub(), index: indexStub(), rollup: null, now: NOW }, 0, "7d");
    expect(summary.riskCount).toBe(0);
  });

  it("M2: userCount = true population across pages; sampled always false", async () => {
    // 250 users total (2 pages)
    const page1 = Array.from({ length: 200 }, (_, i) => ({
      userId: `b${i}`,
      role: "user" as const,
      maxBudget: 5,
    }));
    const page2 = Array.from({ length: 50 }, (_, i) => ({
      userId: `c${i}`,
      role: "user" as const,
      maxBudget: 5,
    }));
    let pageCall = 0;
    const idx: IndexDOLike = {
      listTeams: async () => [],
      listAllUsers: async () => {
        pageCall += 1;
        if (pageCall === 1) return { users: page1, cursor: "p2" };
        return { users: page2, cursor: undefined };
      },
    };
    const summary = await buildSummary({ usage: usageStub(), index: idx, rollup: null, now: NOW }, 0, "7d");
    // True population
    expect(summary.userCount).toBe(250);
    expect(summary.sampled).toBe(false);
  });
});

it("global perUser + riskCount derive from rollup, no usage fan-out", async () => {
  const usage = {
    queryTimeseries: async () => [], queryModelBreakdown: async () => [],
    queryKpiWithDelta: async () => ({ current: { spend: 0, requests: 0, totalTokens: 0 }, previous: { spend: 0, requests: 0, totalTokens: 0 } }),
  };
  const index = { listTeams: async () => [{ id: "t", alias: "T" }], listAllUsers: async () => ({ users: [{ userId: "a", role: "user" as const, maxBudget: 1 }], cursor: undefined }) };
  const rollup = { generatedAt: "x", users: [{ userId: "a", maxBudget: 1, win: { "24h": { spend: 0, requests: 0, totalTokens: 0 }, "48h": { spend: 0, requests: 0, totalTokens: 0 }, "7d": { spend: 0, requests: 0, totalTokens: 0 }, "30d": { spend: 9, requests: 3, totalTokens: 5 } } }] };
  const res = await buildDashboard({ usage, index, rollup, now: Date.now() }, { scope: { kind: "global" }, window: "30d", grain: "day", grainFallback: false });
  expect(res.perUser).toEqual([{ userId: "a", points: [{ startMs: expect.any(Number), spend: 9 }] }]);
  expect(res.summary?.riskCount).toBe(1);
});

describe("DashboardResponse contract (direct+cache)", () => {
  it("has no hourOfDay/recent keys and grain is constant 'day'", () => {
    const shape = DashboardResponseSchema.shape;
    expect("hourOfDay" in shape).toBe(false);
    expect("recent" in shape).toBe(false);
    const ok = DashboardResponseSchema.safeParse({
      available: true, empty: false, scope: "self", window: "30d",
      grain: "day", grainFallback: false, timezone: "Asia/Shanghai",
      kpi: { spend: { current: 1, previous: null, deltaPct: null },
             requests: { current: 1, previous: null, deltaPct: null },
             totalTokens: { current: 1, previous: null, deltaPct: null } },
      trend: [], models: [],
    });
    expect(ok.success).toBe(true);
  });
});
