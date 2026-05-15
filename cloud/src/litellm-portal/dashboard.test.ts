import { describe, it, expect } from "vitest";
import { parseDashboardRequest, toUsageScope, buildDashboard, buildSummary } from "./dashboard";
import type { UsageDOStub, IndexDOLike } from "./dashboard-schemas";

function usageStub(over: Partial<UsageDOStub> = {}): UsageDOStub {
  return {
    queryTimeseries: async () => [{ startMs: 1, label: "05-01", totalTokens: 10, requests: 2, spend: 1 }],
    queryModelBreakdown: async () => [{ model: "gpt", spend: 1, totalTokens: 10, requests: 2 }],
    queryHourOfDay: async () =>
      Array.from({ length: 24 }, (_, h) => ({ hour: h, totalTokens: 0, requests: 0, spend: 0 })),
    queryPerUserSeries: async () => [{ userId: "u1", points: [{ startMs: 1, spend: 1 }] }],
    queryRecentEvents: async () => [{ tsMs: 1, model: "gpt", totalTokens: 10, spend: 1 }],
    queryKpiWithDelta: async () => ({
      current: { spend: 5, requests: 3, totalTokens: 50, source: "events" as const },
      previous: { spend: 4, requests: 2, totalTokens: 40, source: "events" as const },
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
  it("self scope omits perUser/summary, includes recent", async () => {
    const res = await buildDashboard(
      { usage: usageStub(), index: indexStub(), now: NOW },
      { scope: { kind: "self", userId: "u1" }, window: "7d", grain: "day", grainFallback: false },
    );
    expect(res.scope).toBe("self");
    expect(res).not.toHaveProperty("perUser");
    expect(res).not.toHaveProperty("summary");
    expect(res.recent).toHaveLength(1);
    expect(res.kpi.spend).toEqual({ current: 5, previous: 4, deltaPct: 25 });
    expect(res.available).toBe(true);
    expect(res.empty).toBe(false);
  });

  it("global scope omits recent, includes perUser + DO-backed summary", async () => {
    const res = await buildDashboard(
      { usage: usageStub(), index: indexStub(), now: NOW },
      { scope: { kind: "global" }, window: "7d", grain: "day", grainFallback: false },
    );
    expect(res.scope).toBe("global");
    expect(res).not.toHaveProperty("recent");
    expect(res.perUser).toHaveLength(1);
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

  it("member scope shaped like self with member:<id> label", async () => {
    const res = await buildDashboard(
      { usage: usageStub(), index: indexStub(), now: NOW },
      { scope: { kind: "member", userId: "m9" }, window: "24h", grain: "hour", grainFallback: false },
    );
    expect(res.scope).toBe("member:m9");
    expect(res).not.toHaveProperty("perUser");
    expect(res.recent).toBeDefined();
  });

  it("30d window: previous out of retention -> previous/deltaPct null", async () => {
    const res = await buildDashboard(
      { usage: usageStub(), index: indexStub(), now: NOW },
      { scope: { kind: "self", userId: "u1" }, window: "30d", grain: "day", grainFallback: false },
    );
    expect(res.kpi.spend.previous).toBeNull();
    expect(res.kpi.spend.deltaPct).toBeNull();
  });

  it("empty data -> available true, empty true", async () => {
    const empty = usageStub({
      queryTimeseries: async () => [],
      queryModelBreakdown: async () => [],
      queryRecentEvents: async () => [],
      queryKpiWithDelta: async () => ({
        current: { spend: 0, requests: 0, totalTokens: 0, source: "events" as const },
        previous: { spend: 0, requests: 0, totalTokens: 0, source: "events" as const },
      }),
    });
    const res = await buildDashboard(
      { usage: empty, index: indexStub(), now: NOW },
      { scope: { kind: "self", userId: "u1" }, window: "7d", grain: "day", grainFallback: false },
    );
    expect(res.available).toBe(true);
    expect(res.empty).toBe(true);
  });

  it("missing usage dep -> available false", async () => {
    const res = await buildDashboard(
      { usage: null, index: indexStub(), now: NOW },
      { scope: { kind: "self", userId: "u1" }, window: "7d", grain: "day", grainFallback: false },
    );
    expect(res.available).toBe(false);
    expect(res.empty).toBe(false);
  });

  it("global summary sampled:true when user list exceeds the 200 cap; userCount reflects true total", async () => {
    // Page 1: 200 regular users (no maxBudget → not budgeted, no risk probes)
    // Page 2: 50 more users; cursor undefined → end of list; true total = 250
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
      { usage: usageStub(), index: idx, now: NOW },
      { scope: { kind: "global" }, window: "7d", grain: "day", grainFallback: false },
    );
    expect(res.summary?.sampled).toBe(true);
    // userCount = true total (250), not the cap (200)
    expect(res.summary?.userCount).toBe(250);
  });

  it("grainFallback:true is passed through to the response", async () => {
    const res = await buildDashboard(
      { usage: usageStub(), index: indexStub(), now: NOW },
      { scope: { kind: "self", userId: "u1" }, window: "24h", grain: "hour", grainFallback: true },
    );
    expect(res.grainFallback).toBe(true);
  });

  it("index null -> zeroed summary with passthrough totalSpend", async () => {
    const res = await buildDashboard(
      { usage: usageStub(), index: null, now: NOW },
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
        current: { spend: 5, requests: 3, totalTokens: 50, source: "events" as const },
        previous: { spend: 0, requests: 0, totalTokens: 0, source: "events" as const },
      }),
    });
    const res = await buildDashboard(
      { usage: stub, index: indexStub(), now: NOW },
      { scope: { kind: "self", userId: "u1" }, window: "7d", grain: "day", grainFallback: false },
    );
    expect(res.kpi.spend).toEqual({ current: 5, previous: 0, deltaPct: null });
  });
});

describe("buildSummary", () => {
  const FROM_MS = NOW - 7 * 86_400_000;
  const TO_MS = NOW;

  it("riskCount counts users whose IN-WINDOW spend > maxBudget", async () => {
    // u2 has maxBudget=1; queryKpiWithDelta returns spend=5 → risk
    const usage = usageStub();
    const idx = indexStub();
    const summary = await buildSummary({ usage, index: idx, now: NOW }, 0, FROM_MS, TO_MS);
    expect(summary.riskCount).toBe(1);
  });

  it("riskCount = 0 when in-window spend <= maxBudget (even if all-time spend > maxBudget)", async () => {
    // queryKpiWithDelta returns spend=0 for in-window; maxBudget=1 → not at risk
    const usage = usageStub({
      queryKpiWithDelta: async (o) => {
        // Only return spend for the global scope (used by buildDashboard caller);
        // for per-user probes inside buildSummary return 0 spend in window
        if (o.scope.kind === "user") {
          return {
            current: { spend: 0, requests: 0, totalTokens: 0, source: "events" as const },
            previous: { spend: 0, requests: 0, totalTokens: 0, source: "events" as const },
          };
        }
        return {
          current: { spend: 5, requests: 3, totalTokens: 50, source: "events" as const },
          previous: { spend: 4, requests: 2, totalTokens: 40, source: "events" as const },
        };
      },
    });
    const idx = indexStub();
    const summary = await buildSummary({ usage, index: idx, now: NOW }, 0, FROM_MS, TO_MS);
    expect(summary.riskCount).toBe(0);
  });

  it("buildSummary passes window fromMs/toMs to per-user KPI probes", async () => {
    const calls: Array<{ currentFromMs: number; currentToMs: number }> = [];
    const usage = usageStub({
      queryKpiWithDelta: async (o) => {
        if (o.scope.kind === "user") {
          calls.push({ currentFromMs: o.currentFromMs, currentToMs: o.currentToMs });
        }
        return {
          current: { spend: 0, requests: 0, totalTokens: 0, source: "events" as const },
          previous: { spend: 0, requests: 0, totalTokens: 0, source: "events" as const },
        };
      },
    });
    await buildSummary({ usage, index: indexStub(), now: NOW }, 0, FROM_MS, TO_MS);
    // Both budgeted users (u1 maxBudget=10, u2 maxBudget=1) should be probed with window bounds
    expect(calls.length).toBe(2);
    for (const c of calls) {
      expect(c.currentFromMs).toBe(FROM_MS);
      expect(c.currentToMs).toBe(TO_MS);
    }
  });

  it("M2: userCount = true population; risk probes bounded to SUMMARY_USER_CAP budgeted users", async () => {
    // 250 users total (2 pages): all have maxBudget=5 → budgeted
    // Only SUMMARY_USER_CAP (200) should be risk-probed; userCount must be 250
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
    const probedUserIds: string[] = [];
    const usage = usageStub({
      queryKpiWithDelta: async (o) => {
        if (o.scope.kind === "user") probedUserIds.push(o.scope.userId);
        return {
          current: { spend: 0, requests: 0, totalTokens: 0, source: "events" as const },
          previous: { spend: 0, requests: 0, totalTokens: 0, source: "events" as const },
        };
      },
    });
    const summary = await buildSummary({ usage, index: idx, now: NOW }, 0, FROM_MS, TO_MS);
    // True population
    expect(summary.userCount).toBe(250);
    expect(summary.sampled).toBe(true);
    // Risk probes bounded — at most SUMMARY_USER_CAP probed
    expect(probedUserIds.length).toBeLessThanOrEqual(200);
  });
});
