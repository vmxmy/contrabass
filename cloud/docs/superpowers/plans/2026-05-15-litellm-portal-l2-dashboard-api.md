# LiteLLM Portal L2 Dashboard API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用聚合只读端点 `/api/usage/overview`(self)与 `/api/admin/usage/overview`(global / `?member=`)替代旧 timeseries 端点,数据全部来自 L1 `UsageDO` + `IndexDO`,请求路径不再读 LiteLLM。

**Architecture:** 纯函数 `buildDashboard(deps, opts)` 接收注入的 UsageDO/IndexDO stub,`Promise.all` 并行查询并按 scope 整形;Hono 两个 sub-app 调它;删除旧 `usageTimeseriesApp`/`adminUsageTimeseriesApp` 及其 LiteLLM 读取链。L2 通过本地 `UsageDOStub` 接口镜像 L1 方法签名,与 L1 实现解耦(同 `routes.ts:IndexDOAdminStub` 模式),L1/L2 可独立编译。

**Tech Stack:** TypeScript, Hono, Cloudflare Durable Objects, Zod, Vitest。

参考 spec: `docs/superpowers/specs/2026-05-15-litellm-portal-l2-dashboard-api-design.md`

---

## 关键既有模式(实现者必读)

- Hono 类型:`type HonoEnv = { Bindings: LiteLLMPortalEnv; Variables: { identity: PortalIdentity } }`(`routes.ts:70`)。
- sub-app 范式:`new Hono<HonoEnv>().use("/*", applyAuthMiddleware)[.use("/admin/*", applyAdminRateLimit).use("/admin/*", requireAdmin)].get(path, handler)`,再在底部 `.route("/api", app)` 链(`routes.ts:1305+`)。
- 身份:handler 内 `const identity = c.get("identity")`;`identity.litellmUserId` 是 LiteLLM userId。
- DO stub 取法:`env.INDEX_DO.get(env.INDEX_DO.idFromName("index")) as unknown as IndexDOAdminStub`(`routes.ts:196`)。L1 `UsageDO` 用 `idFromName("usage")`(见 L1 plan)。
- `IndexDOAdminStub`(`routes.ts:76-89`):`listTeams()` → `{id,alias}[]`;`listAllUsers({limit?,cursor?})` → `{users:[{userId,email,role,teamId,maxBudget?,createdAt}],cursor}`。
- 旧端点位置:`usageTimeseriesApp`(`routes.ts:839-850`)、`adminUsageTimeseriesApp`(`routes.ts:952-963`);imports 来自 `./timeseries`(`routes.ts:35`);mounts 在 `routes.ts:1314` 与 `1319`。
- `/api/dashboard` 已被 SSR portal 数据占用(`dashboardApp` `routes.ts:686`)——**新端点必须用 `/api/usage/overview` 与 `/api/admin/usage/overview`**(spec 内 `/api/dashboard` 命名据此修正,见 Task 9)。
- 路由测试范式:`routes-do-path.test.ts` —— `makeIndexDOStub`/`makeIndexDONamespace`、`makeFlagOnEnv`、`adminRequest(url,env)`、`await app.fetch(req, env)`、`afterEach(_clearRoleCacheForTests + vi.restoreAllMocks)`。
- L1 `UsageDO` 方法签名(来自 L1 plan,L2 仅按此签名调用):
  - `queryTimeseries({ scope, grain, fromMs, toMs })` → `{startMs,label,totalTokens,requests,spend}[]`
  - `queryModelBreakdown({ scope, fromMs, toMs })` → `{model,spend,totalTokens,requests}[]`
  - `queryHourOfDay({ scope, fromMs, toMs })` → `{hour,totalTokens,requests,spend}[24]`
  - `queryPerUserSeries({ grain, fromMs, toMs, topN })` → `{userId,points:[{startMs,spend}]}[]`
  - `queryRecentEvents({ userId, limit })` → `{tsMs,model,totalTokens,spend}[]`
  - `queryKpiWithDelta({ scope, currentFromMs, currentToMs, previousFromMs, previousToMs })` → `{current:{spend,requests,totalTokens},previous:{spend,requests,totalTokens}}`
  - `scope` = `{kind:"global"} | {kind:"user", userId:string}`

## 文件结构

- Create `src/litellm-portal/dashboard-schemas.ts` — window 目录、scope 类型、Zod 响应 schema、`UsageDOStub`/`IndexDOLike` 接口。
- Create `src/litellm-portal/dashboard.ts` — `parseDashboardRequest`、`toUsageScope`、`buildDashboard`(纯函数)。
- Create `src/litellm-portal/dashboard.test.ts` — 纯函数单测。
- Modify `src/litellm-portal/routes.ts` — 新增两个 sub-app + mount;删除旧 timeseries apps、mounts、`./timeseries` imports。
- Create `src/litellm-portal/usage-overview-routes.test.ts` — 路由集成测。
- Modify `docs/superpowers/specs/2026-05-15-litellm-portal-l2-dashboard-api-design.md` — 端点重命名修正。

---

### Task 1: dashboard-schemas.ts — 类型与窗口目录

**Files:**
- Create: `src/litellm-portal/dashboard-schemas.ts`

- [ ] **Step 1: 写文件**

```typescript
import { z } from "zod";

export const DASHBOARD_WINDOWS = ["24h", "48h", "7d", "30d"] as const;
export type DashboardWindow = (typeof DASHBOARD_WINDOWS)[number];

export type DashboardGrain = "hour" | "day";

/** window → 长度毫秒 + 自动粒度。Asia/Shanghai 由 L1 内部处理时区,
 *  L2 只算 epoch 区间。 */
export const WINDOW_SPEC: Record<DashboardWindow, { lenMs: number; autoGrain: DashboardGrain }> = {
  "24h": { lenMs: 24 * 3600_000, autoGrain: "hour" },
  "48h": { lenMs: 48 * 3600_000, autoGrain: "hour" },
  "7d": { lenMs: 7 * 86_400_000, autoGrain: "day" },
  "30d": { lenMs: 30 * 86_400_000, autoGrain: "day" },
};

/** events 保留窗口;previous 区间早于此则环比不可比。 */
export const EVENT_RETENTION_MS = 30 * 86_400_000;

export type DashboardScope =
  | { kind: "self"; userId: string }
  | { kind: "global" }
  | { kind: "member"; userId: string };

export type UsageScope = { kind: "global" } | { kind: "user"; userId: string };

const KpiMetric = z.object({
  current: z.number(),
  previous: z.number().nullable(),
  deltaPct: z.number().nullable(),
});

const TrendPoint = z.object({
  startMs: z.number(), label: z.string(),
  totalTokens: z.number(), requests: z.number(), spend: z.number(),
});
const ModelSlice = z.object({
  model: z.string(), spend: z.number(), totalTokens: z.number(), requests: z.number(),
});
const HourBucket = z.object({
  hour: z.number(), totalTokens: z.number(), requests: z.number(), spend: z.number(),
});
const RecentEvent = z.object({
  tsMs: z.number(), model: z.string(), totalTokens: z.number(), spend: z.number(),
});
const PerUser = z.object({
  userId: z.string(),
  points: z.array(z.object({ startMs: z.number(), spend: z.number() })),
});
const Summary = z.object({
  userCount: z.number(), adminCount: z.number(), teamCount: z.number(),
  totalSpend: z.number(), totalBudget: z.number(), riskCount: z.number(),
  sampled: z.boolean(),
});

export const DashboardResponseSchema = z.object({
  available: z.boolean(),
  empty: z.boolean(),
  scope: z.string(),
  window: z.enum(DASHBOARD_WINDOWS),
  grain: z.enum(["hour", "day"]),
  grainFallback: z.boolean(),
  timezone: z.literal("Asia/Shanghai"),
  kpi: z.object({ spend: KpiMetric, requests: KpiMetric, totalTokens: KpiMetric }),
  trend: z.array(TrendPoint),
  models: z.array(ModelSlice),
  hourOfDay: z.array(HourBucket),
  perUser: z.array(PerUser).optional(),
  summary: Summary.optional(),
  recent: z.array(RecentEvent).optional(),
}).strict();
export type DashboardResponse = z.infer<typeof DashboardResponseSchema>;

/** L1 UsageDO 方法子集(按 L1 plan 签名镜像,解耦编译)。 */
export type UsageDOStub = {
  queryTimeseries(o: { scope: UsageScope; grain: DashboardGrain; fromMs: number; toMs: number }):
    Promise<Array<{ startMs: number; label: string; totalTokens: number; requests: number; spend: number }>>;
  queryModelBreakdown(o: { scope: UsageScope; fromMs: number; toMs: number }):
    Promise<Array<{ model: string; spend: number; totalTokens: number; requests: number }>>;
  queryHourOfDay(o: { scope: UsageScope; fromMs: number; toMs: number }):
    Promise<Array<{ hour: number; totalTokens: number; requests: number; spend: number }>>;
  queryPerUserSeries(o: { grain: DashboardGrain; fromMs: number; toMs: number; topN: number }):
    Promise<Array<{ userId: string; points: Array<{ startMs: number; spend: number }> }>>;
  queryRecentEvents(o: { userId: string; limit: number }):
    Promise<Array<{ tsMs: number; model: string; totalTokens: number; spend: number }>>;
  queryKpiWithDelta(o: {
    scope: UsageScope; currentFromMs: number; currentToMs: number;
    previousFromMs: number; previousToMs: number;
  }): Promise<{
    current: { spend: number; requests: number; totalTokens: number };
    previous: { spend: number; requests: number; totalTokens: number };
  }>;
};

export type IndexDOLike = {
  listTeams(): Promise<Array<{ id: string; alias: string }>>;
  listAllUsers(opts?: { limit?: number; cursor?: string }): Promise<{
    users: Array<{ userId: string; role: "admin" | "user"; maxBudget?: number }>;
    cursor: string | undefined;
  }>;
};
```

- [ ] **Step 2: 类型检查**

Run: `cd cloud && bun run tsc --noEmit 2>&1 | grep -c 'error TS'`
Expected: `0`

- [ ] **Step 3: 提交**

```bash
git add cloud/src/litellm-portal/dashboard-schemas.ts
git commit -m "feat(litellm-portal): L2 dashboard schemas + L1 stub interfaces"
```

---

### Task 2: parseDashboardRequest + toUsageScope

**Files:**
- Create: `src/litellm-portal/dashboard.ts`
- Create: `src/litellm-portal/dashboard.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `src/litellm-portal/dashboard.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { parseDashboardRequest, toUsageScope } from "./dashboard";

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
```

- [ ] **Step 2: 运行确认失败**

Run: `cd cloud && bun run vitest run src/litellm-portal/dashboard.test.ts`
Expected: FAIL — `Cannot find module './dashboard'`

- [ ] **Step 3: 实现**

创建 `src/litellm-portal/dashboard.ts`:

```typescript
import {
  DASHBOARD_WINDOWS, WINDOW_SPEC, type DashboardWindow, type DashboardGrain,
  type DashboardScope, type UsageScope,
} from "./dashboard-schemas";

export type ParsedDashboardRequest =
  | { ok: true; window: DashboardWindow; grain: DashboardGrain; grainFallback: boolean }
  | { ok: false; body: { error: string; allowed: string[] } };

function isWindow(v: string): v is DashboardWindow {
  return (DASHBOARD_WINDOWS as readonly string[]).includes(v);
}

export function parseDashboardRequest(url: URL): ParsedDashboardRequest {
  const rawWindow = url.searchParams.get("window") ?? "30d";
  if (!isWindow(rawWindow)) {
    return { ok: false, body: { error: "unsupported_usage_window", allowed: [...DASHBOARD_WINDOWS] } };
  }
  const auto = WINDOW_SPEC[rawWindow].autoGrain;
  const rawGrain = url.searchParams.get("grain");
  if (rawGrain == null) {
    return { ok: true, window: rawWindow, grain: auto, grainFallback: false };
  }
  if (rawGrain === auto) {
    return { ok: true, window: rawWindow, grain: auto, grainFallback: false };
  }
  // Incompatible explicit grain → fall back to auto, flag it (non-blocking).
  return { ok: true, window: rawWindow, grain: auto, grainFallback: true };
}

export function toUsageScope(scope: DashboardScope): UsageScope {
  return scope.kind === "global" ? { kind: "global" } : { kind: "user", userId: scope.userId };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd cloud && bun run vitest run src/litellm-portal/dashboard.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: 提交**

```bash
git add cloud/src/litellm-portal/dashboard.ts cloud/src/litellm-portal/dashboard.test.ts
git commit -m "feat(litellm-portal): dashboard request parser + scope adapter"
```

---

### Task 3: buildDashboard — 装配与 scope 整形

**Files:**
- Modify: `src/litellm-portal/dashboard.ts`
- Modify: `src/litellm-portal/dashboard.test.ts`

- [ ] **Step 1: 写失败测试**

在 `dashboard.test.ts` 末尾追加:

```typescript
import { buildDashboard } from "./dashboard";
import type { UsageDOStub, IndexDOLike } from "./dashboard-schemas";

function usageStub(over: Partial<UsageDOStub> = {}): UsageDOStub {
  return {
    queryTimeseries: async () => [{ startMs: 1, label: "05-01", totalTokens: 10, requests: 2, spend: 1 }],
    queryModelBreakdown: async () => [{ model: "gpt", spend: 1, totalTokens: 10, requests: 2 }],
    queryHourOfDay: async () => Array.from({ length: 24 }, (_, h) => ({ hour: h, totalTokens: 0, requests: 0, spend: 0 })),
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
    listTeams: async () => [{ id: "t1", alias: "a" }, { id: "t2", alias: "b" }],
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
      userCount: 2, adminCount: 1, teamCount: 2,
      totalSpend: 5, totalBudget: 11, riskCount: 1, sampled: false,
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

  it("global summary sampled:true when user list exceeds the 200 cap", async () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      userId: `u${i}`, role: "user" as const, maxBudget: undefined,
    }));
    const idx: IndexDOLike = {
      listTeams: async () => [{ id: "t1", alias: "a" }],
      // First page returns 200 users WITH a cursor → cap hit → sampled:true.
      listAllUsers: async () => ({ users: many, cursor: "next" }),
    };
    const res = await buildDashboard(
      { usage: usageStub(), index: idx, now: NOW },
      { scope: { kind: "global" }, window: "7d", grain: "day", grainFallback: false },
    );
    expect(res.summary?.sampled).toBe(true);
    expect(res.summary?.userCount).toBe(200);
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
      userCount: 0, adminCount: 0, teamCount: 0,
      totalSpend: 5, totalBudget: 0, riskCount: 0, sampled: false,
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
```

- [ ] **Step 2: 运行确认失败**

Run: `cd cloud && bun run vitest run src/litellm-portal/dashboard.test.ts`
Expected: FAIL — `buildDashboard is not exported`

- [ ] **Step 3: 实现 buildDashboard**

在 `dashboard.ts` 末尾追加(并补 import):

将 `dashboard.ts` 顶部 import 行改为:

```typescript
import {
  DASHBOARD_WINDOWS, WINDOW_SPEC, EVENT_RETENTION_MS,
  type DashboardWindow, type DashboardGrain, type DashboardScope, type UsageScope,
  type UsageDOStub, type IndexDOLike, type DashboardResponse,
} from "./dashboard-schemas";
```

末尾追加:

```typescript
type BuildDeps = { usage: UsageDOStub | null; index: IndexDOLike | null; now: number };
type BuildOpts = {
  scope: DashboardScope;
  window: DashboardWindow;
  grain: DashboardGrain;
  grainFallback: boolean;
};

function deltaPct(current: number, previous: number | null): number | null {
  if (previous === null) return null;
  if (previous > 0) return Math.round(((current - previous) / previous) * 100);
  return current > 0 ? null : 0;
}

const SUMMARY_USER_CAP = 200;

export async function buildDashboard(
  deps: BuildDeps,
  opts: BuildOpts,
): Promise<DashboardResponse> {
  const scopeLabel =
    opts.scope.kind === "global" ? "global"
      : opts.scope.kind === "member" ? `member:${opts.scope.userId}`
        : "self";
  const base = {
    scope: scopeLabel,
    window: opts.window,
    grain: opts.grain,
    grainFallback: opts.grainFallback,
    timezone: "Asia/Shanghai" as const,
  };

  if (deps.usage === null) {
    return {
      ...base, available: false, empty: false,
      kpi: emptyKpi(), trend: [], models: [], hourOfDay: emptyHours(),
    };
  }

  const toMs = deps.now;
  const fromMs = toMs - WINDOW_SPEC[opts.window].lenMs;
  const prevToMs = fromMs;
  const prevFromMs = fromMs - WINDOW_SPEC[opts.window].lenMs;
  // NOTE: EVENT_RETENTION_MS here (dashboard-schemas.ts) must stay in lockstep
  // with UsageDO.EVENT_RETENTION_MS (durable/usage-do.ts). L2 nulls the 30d
  // `previous` deliberately (current=events vs previous=daily would be
  // apples-to-oranges); this is a stricter presentation policy than L1's own
  // data-availability source resolution, by design (L2 spec §3).
  const prevComparable = prevFromMs >= deps.now - EVENT_RETENTION_MS;
  const us = toUsageScope(opts.scope);

  const [trend, models, hourOfDay, kpiRaw] = await Promise.all([
    deps.usage.queryTimeseries({ scope: us, grain: opts.grain, fromMs, toMs }),
    deps.usage.queryModelBreakdown({ scope: us, fromMs, toMs }),
    deps.usage.queryHourOfDay({ scope: us, fromMs, toMs }),
    deps.usage.queryKpiWithDelta({
      scope: us, currentFromMs: fromMs, currentToMs: toMs,
      previousFromMs: prevFromMs, previousToMs: prevToMs,
    }),
  ]);

  const mkMetric = (cur: number, prev: number) => ({
    current: cur,
    previous: prevComparable ? prev : null,
    deltaPct: deltaPct(cur, prevComparable ? prev : null),
  });
  const kpi = {
    spend: mkMetric(kpiRaw.current.spend, kpiRaw.previous.spend),
    requests: mkMetric(kpiRaw.current.requests, kpiRaw.previous.requests),
    totalTokens: mkMetric(kpiRaw.current.totalTokens, kpiRaw.previous.totalTokens),
  };

  const empty = trend.length === 0 && models.length === 0
    && kpiRaw.current.spend === 0 && kpiRaw.current.requests === 0;

  const result: DashboardResponse = {
    ...base, available: true, empty,
    kpi, trend, models, hourOfDay,
  };

  if (opts.scope.kind === "global") {
    const [perUser, summary] = await Promise.all([
      deps.usage.queryPerUserSeries({ grain: opts.grain, fromMs, toMs, topN: 8 }),
      buildSummary(deps, kpiRaw.current.spend),
    ]);
    result.perUser = perUser;
    result.summary = summary;
  } else {
    result.recent = await deps.usage.queryRecentEvents({ userId: opts.scope.userId, limit: 20 });
  }
  return result;
}

function emptyKpi() {
  const z = { current: 0, previous: null, deltaPct: null };
  return { spend: { ...z }, requests: { ...z }, totalTokens: { ...z } };
}
function emptyHours() {
  return Array.from({ length: 24 }, (_, hour) => ({ hour, totalTokens: 0, requests: 0, spend: 0 }));
}

async function buildSummary(
  deps: BuildDeps,
  totalSpend: number,
): Promise<NonNullable<DashboardResponse["summary"]>> {
  if (deps.index === null) {
    return { userCount: 0, adminCount: 0, teamCount: 0, totalSpend, totalBudget: 0, riskCount: 0, sampled: false };
  }
  const teams = await deps.index.listTeams();
  const users: Array<{ userId: string; role: "admin" | "user"; maxBudget?: number }> = [];
  let cursor: string | undefined;
  let sampled = false;
  for (;;) {
    const page = await deps.index.listAllUsers({ limit: 200, cursor });
    users.push(...page.users);
    cursor = page.cursor;
    if (cursor === undefined) break;
    if (users.length >= SUMMARY_USER_CAP) { sampled = true; break; }
  }
  const adminCount = users.filter((u) => u.role === "admin").length;
  const totalBudget = users.reduce((s, u) => s + (u.maxBudget ?? 0), 0);
  // Risk = users whose retained-events spend exceeds their maxBudget. The
  // per-user KPI probe is an N-query fan-out, so run it with bounded
  // concurrency (NOT a serial await-in-loop) to keep the admin request
  // latency bounded even at SUMMARY_USER_CAP users.
  const usage = deps.usage;
  const budgeted = usage === null
    ? []
    : users.filter((u): u is typeof u & { maxBudget: number } =>
        u.maxBudget != null && u.maxBudget > 0);
  const RISK_CONCURRENCY = 10;
  let riskCount = 0;
  for (let i = 0; i < budgeted.length; i += RISK_CONCURRENCY) {
    const chunk = budgeted.slice(i, i + RISK_CONCURRENCY);
    const spends = await Promise.all(
      chunk.map(async (u) => {
        const k = await usage!.queryKpiWithDelta({
          scope: { kind: "user", userId: u.userId },
          currentFromMs: 0, currentToMs: deps.now,
          previousFromMs: 0, previousToMs: 0,
        });
        return k.current.spend;
      }),
    );
    spends.forEach((s, j) => {
      if (s > chunk[j].maxBudget) riskCount += 1;
    });
  }
  return {
    userCount: users.length,
    adminCount,
    teamCount: teams.length,
    totalSpend,
    totalBudget,
    riskCount,
    sampled,
  };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd cloud && bun run vitest run src/litellm-portal/dashboard.test.ts`
Expected: PASS (11 tests)

- [ ] **Step 5: 类型检查 + 提交**

Run: `cd cloud && bun run tsc --noEmit 2>&1 | grep -c 'error TS'`
Expected: `0`

```bash
git add cloud/src/litellm-portal/dashboard.ts cloud/src/litellm-portal/dashboard.test.ts
git commit -m "feat(litellm-portal): buildDashboard assembler with DO-backed summary"
```

---

### Task 4: routes.ts — 新增 overview sub-app,删除旧 timeseries

**Files:**
- Modify: `src/litellm-portal/routes.ts:35`(import)
- Modify: `src/litellm-portal/routes.ts:839-850`(删 usageTimeseriesApp)
- Modify: `src/litellm-portal/routes.ts:952-963`(删 adminUsageTimeseriesApp)
- Modify: `src/litellm-portal/routes.ts:1314,1319`(删 mounts)
- Modify: `src/litellm-portal/routes.ts`(新增两 sub-app + mounts)

- [ ] **Step 1: 删除旧 timeseries import**

将 `routes.ts:35`:

```typescript
import { parseUsageTimeseriesRequest, readGlobalUsageTimeseries, readUsageTimeseries } from "./timeseries";
```

删除整行。新增 import(放在该处):

```typescript
import { parseDashboardRequest, toUsageScope, buildDashboard } from "./dashboard";
import type { UsageDOStub, IndexDOLike } from "./dashboard-schemas";
```

- [ ] **Step 2: 删除 `usageTimeseriesApp` 与 `adminUsageTimeseriesApp`**

删除 `routes.ts` 中整个 `const usageTimeseriesApp = new Hono<HonoEnv>()...;`(约 839-850 行,`.get("/usage/timeseries", ...)` 块)与整个 `const adminUsageTimeseriesApp = new Hono<HonoEnv>()...;`(约 952-963 行,`.get("/admin/usage/timeseries", ...)` 块)。

- [ ] **Step 3: 新增两个 overview sub-app**

在 `adminAuditApp` 定义之后(原 `adminUsageTimeseriesApp` 位置)插入:

```typescript
function usageDOStub(env: LiteLLMPortalEnv): UsageDOStub | null {
  if (!env.USAGE_DO) return null;
  return env.USAGE_DO.get(env.USAGE_DO.idFromName("usage")) as unknown as UsageDOStub;
}
function indexDOLike(env: LiteLLMPortalEnv): IndexDOLike | null {
  if (!env.INDEX_DO) return null;
  return env.INDEX_DO.get(env.INDEX_DO.idFromName("index")) as unknown as IndexDOLike;
}

const usageOverviewApp = new Hono<HonoEnv>()
  .use("/*", applyAuthMiddleware)
  .get("/usage/overview", async (c) => {
    const parsed = parseDashboardRequest(new URL(c.req.url));
    if (!parsed.ok) return c.json(parsed.body, 400);
    const identity = c.get("identity");
    const res = await buildDashboard(
      { usage: usageDOStub(c.env), index: indexDOLike(c.env), now: Date.now() },
      { scope: { kind: "self", userId: identity.litellmUserId },
        window: parsed.window, grain: parsed.grain, grainFallback: parsed.grainFallback },
    );
    return c.json(res);
  });

const adminUsageOverviewApp = new Hono<HonoEnv>()
  .use("/*", applyAuthMiddleware)
  .use("/admin/*", applyAdminRateLimit)
  .use("/admin/*", requireAdmin)
  .get("/admin/usage/overview", async (c) => {
    const url = new URL(c.req.url);
    const parsed = parseDashboardRequest(url);
    if (!parsed.ok) return c.json(parsed.body, 400);
    const member = url.searchParams.get("member");
    const scope = member != null && member.length > 0
      ? { kind: "member" as const, userId: member }
      : { kind: "global" as const };
    const res = await buildDashboard(
      { usage: usageDOStub(c.env), index: indexDOLike(c.env), now: Date.now() },
      { scope, window: parsed.window, grain: parsed.grain, grainFallback: parsed.grainFallback },
    );
    return c.json(res);
  });
```

- [ ] **Step 4: 调整 mounts**

在 `routes.ts` mount 链(约 1305-1325)中:
- 删除 `.route("/api", usageTimeseriesApp)` 与 `.route("/api", adminUsageTimeseriesApp)` 两行。
- 在 `.route("/api", usageApp)` 之后新增 `.route("/api", usageOverviewApp)`。
- 在 `.route("/api", adminAuditApp)` 之后新增 `.route("/api", adminUsageOverviewApp)`。

- [ ] **Step 5: 类型检查**

Run: `cd cloud && bun run tsc --noEmit 2>&1 | grep -c 'error TS'`
Expected: `0`(若 `./timeseries` 仍被别处引用导致报错,见 Task 5 清理;此处应为 0,因为仅 routes.ts 引用了被删的三个符号)

- [ ] **Step 6: 提交**

```bash
git add cloud/src/litellm-portal/routes.ts
git commit -m "feat(litellm-portal): add usage overview endpoints, remove timeseries routes"
```

---

### Task 5: 清理 timeseries.ts 的 LiteLLM 读取链

**Files:**
- Modify/Delete: `src/litellm-portal/timeseries.ts`
- Check: `src/litellm-portal/usage.ts`

- [ ] **Step 1: 确认 timeseries 引用面**

Run:
```bash
cd cloud && rg -n "from \"./timeseries\"|from \"\\.\\./timeseries\"|readUsageTimeseries|readGlobalUsageTimeseries|parseUsageTimeseriesRequest" src --glob '!**/*.test.ts'
```
Expected: 仅剩 `timeseries.ts` 自身(routes.ts 已在 Task 4 移除引用)。若有其它生产文件引用,逐一改为不依赖 LiteLLM 读取(本任务范围仅删 dead 链,不重构)。

- [ ] **Step 2: 删除仅服务旧端点的 LiteLLM 读取函数**

删除 `timeseries.ts` 中 `readUsageTimeseries`、`readGlobalUsageTimeseries`、`readSpendLogsTimeseriesInternal`、`readGlobalSpendLogsTimeseries`、`readSpendLogsTimeseries`、`readDailyActivityTimeseries`、`parseUsageTimeseriesRequest` 及其私有辅助;若文件清空后无任何导出被其它生产代码使用,删除整个 `timeseries.ts` 与其测试 `timeseries.test.ts`(若存在)。被 `usage.ts`/别处复用的纯函数(如时区 `usageDateParts` 等)若仍被引用,迁移到 `dashboard.ts` 或保留最小文件,不做无关重构。

- [ ] **Step 3: 确认 usage.ts 不再走 LiteLLM 供旧端点**

Run:
```bash
cd cloud && rg -n "litellmFetch" src/litellm-portal --glob '!**/sync/**' --glob '!**/*.test.ts'
```
Expected: 输出中**无请求路径文件**(routes.ts / dashboard.ts / timeseries.ts / usage.ts)再调用 `litellmFetch` 服务用量端点。`sync/` 不在范围(允许)。`resolveLiteLLMUser` 等身份/keys 既有逻辑不属本 spec,保持不动。

> 注:若 `usage.ts` 的 `readUserDailyActivity` 仍被 `loadDashboard`(SSR `/api/dashboard`)使用,**保持不动**——那是既有 SSR 路径,不在 L2 范围;L2 只移除"旧 timeseries 端点"专属的 LiteLLM 读取链。

- [ ] **Step 4: 类型检查 + 全量测试**

Run:
```bash
cd cloud && bun run tsc --noEmit 2>&1 | grep -c 'error TS'
bun run vitest run src/litellm-portal/dashboard.test.ts
```
Expected: tsc `0`;dashboard 测试 PASS

- [ ] **Step 5: 提交**

```bash
git add -A cloud/src/litellm-portal
git commit -m "refactor(litellm-portal): remove dead LiteLLM timeseries read path"
```

---

### Task 6: 路由集成测试

**Files:**
- Create: `src/litellm-portal/usage-overview-routes.test.ts`

- [ ] **Step 1: 写测试**

创建 `src/litellm-portal/usage-overview-routes.test.ts`(镜像 `routes-do-path.test.ts` 范式):

```typescript
import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "./routes";
import { issueSession, SESSION_COOKIE_NAME } from "./auth/session";
import { _clearRoleCacheForTests } from "./roles";
import type { LiteLLMPortalEnv } from "./types";

const ADMIN_EMAIL = "admin@gz-zhiyun.com";
const USER_EMAIL = "bob@gz-zhiyun.com";
const SESSION_SECRET = "test-secret-32bytes-paddedXXXXXX";

const USERS = [
  { userId: ADMIN_EMAIL, email: ADMIN_EMAIL, role: "admin" as const, teamId: "t1", createdAt: new Date().toISOString() },
  { userId: USER_EMAIL, email: USER_EMAIL, role: "user" as const, teamId: "t1", createdAt: new Date().toISOString() },
];

function emptyArrays() {
  return {
    queryTimeseries: vi.fn().mockResolvedValue([]),
    queryModelBreakdown: vi.fn().mockResolvedValue([]),
    queryHourOfDay: vi.fn().mockResolvedValue(Array.from({ length: 24 }, (_, h) => ({ hour: h, totalTokens: 0, requests: 0, spend: 0 }))),
    queryPerUserSeries: vi.fn().mockResolvedValue([]),
    queryRecentEvents: vi.fn().mockResolvedValue([]),
    queryKpiWithDelta: vi.fn().mockResolvedValue({
      current: { spend: 0, requests: 0, totalTokens: 0 },
      previous: { spend: 0, requests: 0, totalTokens: 0 },
    }),
  };
}

function makeEnv(): LiteLLMPortalEnv {
  const indexStub = {
    listTeams: vi.fn().mockResolvedValue([{ id: "t1", alias: "a" }]),
    listAllUsers: vi.fn().mockResolvedValue({ users: USERS, cursor: undefined }),
    getUserByEmail: vi.fn(async (e: string) => USERS.find((u) => u.email === e) ?? null),
    getUserById: vi.fn(async (i: string) => USERS.find((u) => u.userId === i) ?? null),
  };
  return {
    PORTAL_SESSION_SECRET: SESSION_SECRET,
    PORTAL_ALLOWED_EMAIL_DOMAINS: "gz-zhiyun.com",
    LITELLM_BASE_URL: "https://litellm.test",
    LITELLM_MASTER_KEY: "k",
    INDEX_DO: { idFromName: vi.fn().mockReturnValue({}), get: vi.fn().mockReturnValue(indexStub) } as unknown as DurableObjectNamespace,
    USAGE_DO: { idFromName: vi.fn().mockReturnValue({}), get: vi.fn().mockReturnValue(emptyArrays()) } as unknown as DurableObjectNamespace,
  } as unknown as LiteLLMPortalEnv;
}

async function cookie(env: LiteLLMPortalEnv, email: string): Promise<string> {
  return `${SESSION_COOKIE_NAME}=${await issueSession(env, { email, userId: email })}`;
}

afterEach(() => { _clearRoleCacheForTests(); vi.restoreAllMocks(); });

describe("usage overview endpoints", () => {
  it("GET /api/usage/overview requires auth (401 without cookie)", async () => {
    const env = makeEnv();
    const res = await app.fetch(new Request("https://x/api/usage/overview"), env);
    expect(res.status).toBe(401);
  });

  it("self overview returns available + self scope, no perUser", async () => {
    const env = makeEnv();
    const req = new Request("https://x/api/usage/overview?window=7d", {
      headers: { Cookie: await cookie(env, USER_EMAIL) },
    });
    const res = await app.fetch(req, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scope).toBe("self");
    expect(body.available).toBe(true);
    expect(body).not.toHaveProperty("perUser");
  });

  it("invalid window -> 400", async () => {
    const env = makeEnv();
    const req = new Request("https://x/api/usage/overview?window=90d", {
      headers: { Cookie: await cookie(env, USER_EMAIL) },
    });
    const res = await app.fetch(req, env);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("unsupported_usage_window");
  });

  it("non-admin gets 403 on /api/admin/usage/overview", async () => {
    const env = makeEnv();
    const req = new Request("https://x/api/admin/usage/overview", {
      headers: { Cookie: await cookie(env, USER_EMAIL) },
    });
    const res = await app.fetch(req, env);
    expect(res.status).toBe(403);
  });

  it("admin global overview has perUser + summary, no recent", async () => {
    const env = makeEnv();
    const req = new Request("https://x/api/admin/usage/overview?window=7d", {
      headers: { Cookie: await cookie(env, ADMIN_EMAIL) },
    });
    const res = await app.fetch(req, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scope).toBe("global");
    expect(body).toHaveProperty("perUser");
    expect(body).toHaveProperty("summary");
    expect(body).not.toHaveProperty("recent");
  });

  it("old timeseries endpoints are gone (404)", async () => {
    const env = makeEnv();
    const c = await cookie(env, ADMIN_EMAIL);
    const a = await app.fetch(new Request("https://x/api/usage/timeseries", { headers: { Cookie: c } }), env);
    const b = await app.fetch(new Request("https://x/api/admin/usage/timeseries", { headers: { Cookie: c } }), env);
    expect(a.status).toBe(404);
    expect(b.status).toBe(404);
  });
});
```

- [ ] **Step 2: 运行确认通过**

Run: `cd cloud && bun run vitest run src/litellm-portal/usage-overview-routes.test.ts`
Expected: PASS (6 tests)

> 若 401/403 与预期不符:确认 `resolveIdentity` 在 INDEX_DO 存在时走 `getUserByEmail`(DO 路径),与 `routes-do-path.test.ts` 一致;按需补 `getUserByEmail` mock 返回对应角色。

- [ ] **Step 3: 提交**

```bash
git add cloud/src/litellm-portal/usage-overview-routes.test.ts
git commit -m "test(litellm-portal): usage overview route integration tests"
```

---

### Task 7: 同步 L2 spec 端点重命名 + 全量验证

**Files:**
- Modify: `docs/superpowers/specs/2026-05-15-litellm-portal-l2-dashboard-api-design.md`

- [ ] **Step 1: 修正 spec 端点命名**

在 spec 中将 `/api/dashboard` → `/api/usage/overview`、`/api/admin/dashboard` → `/api/admin/usage/overview`(§1 表格、§3、§5、§7、验收标准)。在 §1 末尾追加一句:

```
> 命名说明:`/api/dashboard` 已被既有 SSR portal 数据端点占用,故聚合用量端点采用 `/api/usage/overview` 与 `/api/admin/usage/overview`(替代被删除的 `/api/usage/timeseries`、`/api/admin/usage/timeseries`)。
```

- [ ] **Step 2: 回归 + 全量验证**

Run:
```bash
cd cloud && bun run vitest run src/litellm-portal/dashboard.test.ts src/litellm-portal/usage-overview-routes.test.ts
bun run vitest run src/litellm-portal
bun run tsc --noEmit 2>&1 | grep -c 'error TS'
bunx wrangler deploy --dry-run --config wrangler.litellm-portal.toml 2>&1 | grep -iE "error|10061|10064" | head -5
```
Expected: 新测试全 PASS;`src/litellm-portal` 既有套件保持绿(注意:依赖旧 timeseries 端点的既有测试若存在会失败 —— 这些测试应一并删除/改写为 overview,属预期清理,在本步处理);tsc `0`;dry-run 无 `error`。

- [ ] **Step 3: 处理因删旧端点而失败的既有测试**

Run: `cd cloud && rg -ln "usage/timeseries|parseUsageTimeseriesRequest|readUsageTimeseries" src/litellm-portal --glob '**/*.test.ts'`
对每个命中文件:删除或改写针对旧 timeseries 端点的用例(它们测试的契约已按 spec §7 刻意废弃)。重跑 `bun run vitest run src/litellm-portal` 至全绿。

- [ ] **Step 4: 提交**

```bash
git add -A cloud/docs/superpowers/specs cloud/src/litellm-portal
git commit -m "docs(litellm-portal): rename L2 endpoints to /api/usage/overview; finalize L2"
```

---

## Self-Review

**Spec coverage:**
- §1 端点与契约 → Task 4(两 sub-app)、Task 7(spec 重命名);守卫沿用 `applyAuthMiddleware`/`requireAdmin`。
- §2 window 目录 + L1 调用契约 + scope 适配 → Task 1(WINDOW_SPEC)、Task 2(parseDashboardRequest/toUsageScope)、Task 3(按 L1 签名调用 + previous 区间)。
- §3 响应形状 discriminated union(省略键)→ Task 1(`.optional()`)、Task 3(scope 条件赋值)、测试 `not.toHaveProperty`。
- §3 KPI delta 30d=null → Task 3(`prevComparable`)、test "30d window"。
- §4 DO-backed summary(不调 adminSummary/LiteLLM)→ Task 3(`buildSummary` 用 IndexDOLike + UsageDO,sampled cap)。
- §5 路由/鉴权接线 + `dashboard.ts` 纯函数 → Task 3/4。
- §6 错误/空数据(available vs empty,400,member 不 404,缺 binding)→ Task 2(400)、Task 3(available/empty/usage=null)、Task 6(401/403/400/404)。
- §7 删旧端点 + 精确 404 点 + 清理 LiteLLM 链 → Task 4/5,Task 6 断言 404,Task 7 step3 清理依赖旧端点的既有测试。
- §8 测试策略 → Task 3(纯函数)、Task 6(路由集成),表驱动 + vitest。
- 验收 1-5 → Task 6 + Task 7。

**偏差记录:** spec 原命名 `/api/dashboard` 与既有 SSR 端点冲突,计划改用 `/api/usage/overview` + `/api/admin/usage/overview`,并在 Task 7 同步修订 spec(已在 spec 修订版"经 Codex review 已纳入的修订"外追加命名说明)。功能/契约不变,仅路径名。

**Placeholder scan:** 无 TBD/TODO;每个改码步骤含完整代码与可运行命令。Task 5/7 的清理步骤给出精确 `rg` 命令与判定标准,非占位。

**Type consistency:** `UsageDOStub`/`IndexDOLike`/`DashboardScope`/`UsageScope`/`DashboardResponse`(Task 1)在 Task 3/4 一致引用;`buildDashboard(deps,opts)` 签名 Task 3 定义、Task 4 调用一致;`parseDashboardRequest` 返回 `{ok,window,grain,grainFallback}|{ok:false,body}` Task 2 定义、Task 4 使用一致;`queryKpiWithDelta` 参数名(`currentFromMs/currentToMs/previousFromMs/previousToMs`)与 L1 plan 签名一致;`USAGE_DO`/`INDEX_DO` 经 `idFromName("usage")`/`idFromName("index")` 取 stub,与既有 `routes.ts:196` 模式一致。
