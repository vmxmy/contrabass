# LiteLLM Usage Direct + Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the structurally-starved global `/spend/logs` SQLite firehose with per-user server-side-filtered `/user/daily/activity` direct calls + CF edge cache + in-worker coalescing + a `*/30` roster rollup to KV, then retire the DO/ingest/attribution layer.

**Architecture:** New `LiteLLMUsageSource` implements the `deps.usage` subset `buildDashboard` calls; self/member → `/user/daily/activity?user_id=`, global → `/aggregated`, one wide fetch split by date for delta, day-grain. Admin per-user/risk reads a `*/30`-populated `USAGE_ROLLUP_KV`. Deletion of the old path happens only after the new path is green so the tree always builds.

**Tech Stack:** Cloudflare Workers, TypeScript, Zod, Hono, Vitest, `litellmFetch`, CF `fetch` `cf:{cacheEverything,cacheTtl,cacheKey}`, Workers KV.

**Spec:** `cloud/docs/superpowers/specs/2026-05-16-litellm-usage-direct-cache-design.md` (commit `67cea4e`). **Branch:** `fix/litellm-portal-hydration-418`. Repo root `/Users/xumingyang/github/contrabass`; package dir `cloud/`. Commit format `type(scope): desc`. Stage with EXPLICIT paths (never `git add -A`). Baseline tsc error `server.ts(6,33) TS6142` is pre-existing — "tsc clean" means only that line.

---

## File Structure

- `src/litellm-portal/usage/daily-activity.ts` — **new**: pure parse of a LiteLLM daily/activity response into per-day `{date,spend,requests,totalTokens,models[]}` (no I/O). One responsibility: response → typed rows.
- `src/litellm-portal/usage/litellm-usage-source.ts` — **new**: `LiteLLMUsageSource` class implementing the `UsageSource` interface (kpi/timeseries/models), edge cache + in-flight coalescing + timeout + failure modes. Depends on `daily-activity.ts` + `litellmFetch`.
- `src/litellm-portal/usage/usage-rollup.ts` — **new**: rollup KV schema + `runUsageRollup(env)` cron body.
- `src/litellm-portal/dashboard-schemas.ts` — **modify**: drop `hourOfDay`/`recent` from response; shrink `UsageDOStub` → `UsageSource` (3 methods); add `UsageRollup` type.
- `src/litellm-portal/dashboard.ts` — **modify**: remove `queryHourOfDay`/`queryRecentEvents`/`emptyHours`; `perUser`+risk from rollup.
- `src/litellm-portal/routes.ts` — **modify**: build `deps.usage = new LiteLLMUsageSource(env)`; pass rollup to admin path.
- `src/litellm-portal/types.ts` / `wrangler.litellm-portal.toml` — **modify**: add `USAGE_ROLLUP_KV`; crons `+*/30`, `-*/5`; (retirement) remove `USAGE_DO`.
- `src/litellm-portal/index.ts` — **modify**: `scheduled` add `*/30`, remove `*/5`; remove `UsageDOSQLite` export (retirement).
- Frontend `src/litellm-portal/dashboard/views/personal-view.tsx`, `admin-view.tsx`, `dashboard/charts/hour-bars.tsx`, related `*.test.tsx`/`portal.stories.tsx` — **modify/delete** recent + hour-of-day panels.
- **Delete (Task 9)**: `sync/usage-importer.ts` ingest, `durable/usage-do.ts`, `durable/usage-schemas.ts`, `durable/usage-do.test.ts`, `sync/usage-importer.test.ts`, attribution code.

---

### Task 1: Shrink the dashboard contract (drop hourOfDay/recent; day-grain constant)

**Files:**
- Modify: `src/litellm-portal/dashboard-schemas.ts`
- Modify: `src/litellm-portal/dashboard.ts:62-150`
- Test: `src/litellm-portal/dashboard.test.ts`

- [ ] **Step 1: Write the failing test** — append to `src/litellm-portal/dashboard.test.ts`:

```typescript
import { DashboardResponseSchema } from "./dashboard-schemas";

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
```

- [ ] **Step 2: Run, expect FAIL** — `cd cloud && bun run vitest run src/litellm-portal/dashboard.test.ts -t "direct+cache"` → FAIL (`hourOfDay` still required / present).

- [ ] **Step 3: Edit `dashboard-schemas.ts`**

Delete the `HourBucket` and `RecentEvent` `z.object` consts (lines 43-54). In `DashboardResponseSchema` remove the `hourOfDay: z.array(HourBucket),` and `recent: z.array(RecentEvent).optional(),` lines. Replace the `UsageDOStub` type (lines 90-129) with the trimmed `UsageSource`:

```typescript
/** Read interface buildDashboard depends on (direct-source backed). */
export type UsageSource = {
  queryTimeseries(o: {
    scope: UsageScope; grain: DashboardGrain; fromMs: number; toMs: number;
  }): Promise<Array<{ startMs: number; label: string; totalTokens: number; requests: number; spend: number }>>;
  queryModelBreakdown(o: {
    scope: UsageScope; fromMs: number; toMs: number;
  }): Promise<Array<{ model: string; spend: number; totalTokens: number; requests: number }>>;
  queryKpiWithDelta(o: {
    scope: UsageScope;
    currentFromMs: number; currentToMs: number;
    previousFromMs: number; previousToMs: number;
  }): Promise<{
    current: { spend: number; requests: number; totalTokens: number };
    previous: { spend: number; requests: number; totalTokens: number };
  }>;
};

/** Per-tenant rollup written by the */30 cron, read by the admin path. */
export type UsageRollup = {
  generatedAt: string;
  users: Array<{
    userId: string;
    maxBudget: number;
    win: Record<DashboardWindow, { spend: number; requests: number; totalTokens: number }>;
  }>;
};
```

Keep `UsageScope`, `DashboardGrain`, `DASHBOARD_WINDOWS`, `WINDOW_SPEC`, `EVENT_RETENTION_MS`, `IndexDOLike` unchanged.

- [ ] **Step 4: Edit `dashboard.ts`** — remove `hourOfDay` everywhere:

In the `deps.usage === null` branch (lines 70-80) delete `hourOfDay: emptyHours(),`. Delete the `emptyHours` function (lines 148-150). In the `Promise.all` (lines 94-105) drop the `deps.usage.queryHourOfDay(...)` call and the `hourOfDay` destructure → `const [trend, models, kpiRaw] = await Promise.all([... three calls ...])`. In `result` (lines 121-129) delete `hourOfDay,`. Change import `type UsageDOStub` → `type UsageSource`, `type UsageRollup` and update `BuildDeps`:

```typescript
type BuildDeps = { usage: UsageSource | null; index: IndexDOLike | null; rollup: UsageRollup | null; now: number };
```

In the `opts.scope.kind === "global"` branch replace `deps.usage.queryPerUserSeries(...)` with rollup-derived perUser and replace the `else { result.recent = ... }` with nothing (no recent):

```typescript
  if (opts.scope.kind === "global") {
    result.perUser = (deps.rollup?.users ?? [])
      .map((u) => ({ userId: u.userId, points: [{ startMs: fromMs, spend: u.win[opts.window]?.spend ?? 0 }] }))
      .filter((p) => p.points[0].spend > 0)
      .sort((a, b) => b.points[0].spend - a.points[0].spend)
      .slice(0, 8);
    result.summary = await buildSummary(deps, kpiRaw.current.spend, opts.window);
  }
  return result;
```

Update `buildSummary` signature to `(deps, totalSpend, window: DashboardWindow)` and replace the risk-probe fan-out (lines 184-212) with a rollup read:

```typescript
  const sampled = false;
  let riskCount = 0;
  for (const u of deps.rollup?.users ?? []) {
    if (u.maxBudget > 0 && (u.win[window]?.spend ?? 0) > u.maxBudget) riskCount += 1;
  }
```

(Keep the IndexDO population loop for `userCount/adminCount/totalBudget/teamCount` exactly as-is; delete only the `budgetedSample`/`RISK_CONCURRENCY`/`usage` probe block and the `windowFromMs/windowToMs` params.)

- [ ] **Step 5: Run, expect PASS** — `cd cloud && bun run vitest run src/litellm-portal/dashboard.test.ts` → all pass. `bun run tsc --noEmit` will still error in `routes.ts`/old callers (fixed in Task 6) — acceptable mid-plan; note it. The new contract test passes.

- [ ] **Step 6: Commit**

```bash
git -C /Users/xumingyang/github/contrabass add cloud/src/litellm-portal/dashboard-schemas.ts cloud/src/litellm-portal/dashboard.ts cloud/src/litellm-portal/dashboard.test.ts
git -C /Users/xumingyang/github/contrabass commit -m "refactor(litellm-portal): drop hourOfDay/recent, day-grain contract"
```

---

### Task 2: `daily-activity.ts` — pure response parser

**Files:**
- Create: `src/litellm-portal/usage/daily-activity.ts`
- Test: `src/litellm-portal/usage/daily-activity.test.ts`

LiteLLM `/user/daily/activity[/aggregated]` returns `{ results: [{ date: "YYYY-MM-DD", metrics: { spend, prompt_tokens, completion_tokens, total_tokens, successful_requests, failed_requests, api_requests }, breakdown: { models: { "<model>": { metrics: {...} } } } }] }` (confirmed live 2026-05-16).

- [ ] **Step 1: Write the failing test** — `src/litellm-portal/usage/daily-activity.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { parseDailyActivity } from "./daily-activity";

const body = { results: [
  { date: "2026-05-16", metrics: { spend: 21.5, total_tokens: 1000, api_requests: 215 },
    breakdown: { models: { "glm-5.1": { metrics: { spend: 1.5, total_tokens: 100, api_requests: 5 } },
                           "kimi":   { metrics: { spend: 20,  total_tokens: 900, api_requests: 210 } } } } },
  { date: "2026-05-15", metrics: { spend: 0, total_tokens: 0, api_requests: 0 }, breakdown: { models: {} } },
]};

describe("parseDailyActivity", () => {
  it("maps results to typed per-day rows + model slices", () => {
    const rows = parseDailyActivity(body);
    expect(rows).toEqual([
      { date: "2026-05-15", spend: 0, requests: 0, totalTokens: 0, models: [] },
      { date: "2026-05-16", spend: 21.5, requests: 215, totalTokens: 1000, models: [
        { model: "glm-5.1", spend: 1.5, requests: 5, totalTokens: 100 },
        { model: "kimi", spend: 20, requests: 210, totalTokens: 900 },
      ] },
    ]); // sorted ascending by date
  });
  it("returns [] for junk / missing results", () => {
    expect(parseDailyActivity({})).toEqual([]);
    expect(parseDailyActivity(null)).toEqual([]);
    expect(parseDailyActivity({ results: "x" })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `cd cloud && bun run vitest run src/litellm-portal/usage/daily-activity.test.ts` → FAIL (module missing).

- [ ] **Step 3: Create `src/litellm-portal/usage/daily-activity.ts`**

```typescript
import { isRecord } from "../utils";
import { numberLikeField, firstString } from "../litellm";

export type DailyRow = {
  date: string;
  spend: number;
  requests: number;
  totalTokens: number;
  models: Array<{ model: string; spend: number; totalTokens: number; requests: number }>;
};

function metrics(rec: Record<string, unknown>) {
  return {
    spend: numberLikeField(rec, "spend") ?? 0,
    requests: Math.trunc(numberLikeField(rec, "api_requests") ?? 0),
    totalTokens: Math.trunc(numberLikeField(rec, "total_tokens") ?? 0),
  };
}

/** Pure: LiteLLM daily/activity body → per-day rows, ascending by date. */
export function parseDailyActivity(body: unknown): DailyRow[] {
  if (!isRecord(body) || !Array.isArray(body.results)) return [];
  const rows: DailyRow[] = [];
  for (const day of body.results) {
    if (!isRecord(day)) continue;
    const date = firstString(day, ["date"]);
    if (date === undefined) continue;
    const m = isRecord(day.metrics) ? metrics(day.metrics) : { spend: 0, requests: 0, totalTokens: 0 };
    const models: DailyRow["models"] = [];
    const bm = isRecord(day.breakdown) && isRecord(day.breakdown.models) ? day.breakdown.models : {};
    for (const [model, entry] of Object.entries(bm)) {
      if (!isRecord(entry) || !isRecord(entry.metrics)) continue;
      const em = metrics(entry.metrics);
      models.push({ model, spend: em.spend, totalTokens: em.totalTokens, requests: em.requests });
    }
    rows.push({ date, ...m, models });
  }
  return rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
```

- [ ] **Step 4: Run, expect PASS** — `cd cloud && bun run vitest run src/litellm-portal/usage/daily-activity.test.ts` → PASS. `bun run tsc --noEmit` baseline-only for this file.

- [ ] **Step 5: Commit**

```bash
git -C /Users/xumingyang/github/contrabass add cloud/src/litellm-portal/usage/daily-activity.ts cloud/src/litellm-portal/usage/daily-activity.test.ts
git -C /Users/xumingyang/github/contrabass commit -m "feat(litellm-portal): pure daily/activity response parser"
```

---

### Task 3: `LiteLLMUsageSource` — fetch + window split + cache + coalesce + failure modes

**Files:**
- Create: `src/litellm-portal/usage/litellm-usage-source.ts`
- Test: `src/litellm-portal/usage/litellm-usage-source.test.ts`

Shanghai day boundary helper already established in repo as `new Date(ms + 8*3600_000).toISOString().slice(0,10)` (see `usage-importer.ts shanghaiDate`). The source fetches ONE window `[previousFromMs, currentToMs]` and splits rows by date into current/previous.

- [ ] **Step 1: Write the failing test** — `src/litellm-portal/usage/litellm-usage-source.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { LiteLLMUsageSource } from "./litellm-usage-source";
import type { LiteLLMPortalEnv } from "../types";

const env = { LITELLM_BASE_URL: "https://l.test", LITELLM_MASTER_KEY: "k" } as unknown as LiteLLMPortalEnv;
const day = (d: string, spend: number, reqs: number) => ({
  date: d, metrics: { spend, api_requests: reqs, total_tokens: reqs * 2 },
  breakdown: { models: { gpt: { metrics: { spend, api_requests: reqs, total_tokens: reqs * 2 } } } },
});
function mockFetch(bodyOrStatus: unknown, status = 200) {
  globalThis.fetch = vi.fn().mockResolvedValue(
    new Response(typeof bodyOrStatus === "number" ? "" : JSON.stringify(bodyOrStatus),
      { status: typeof bodyOrStatus === "number" ? bodyOrStatus : status }));
}

describe("LiteLLMUsageSource", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("self KPI splits current vs previous by date", async () => {
    // window 24h: previous day older, current day newer
    const now = Date.parse("2026-05-16T10:00:00+08:00");
    mockFetch({ results: [day("2026-05-15", 5, 50), day("2026-05-16", 7, 70)] });
    const src = new LiteLLMUsageSource(env, now);
    const k = await src.queryKpiWithDelta({
      scope: { kind: "user", userId: "laoxu" },
      currentFromMs: now - 86400000, currentToMs: now,
      previousFromMs: now - 2 * 86400000, previousToMs: now - 86400000,
    });
    expect(k.current.spend).toBe(7);
    expect(k.previous.spend).toBe(5);
    expect((globalThis.fetch as any).mock.calls[0][0]).toContain("/user/daily/activity?");
    expect((globalThis.fetch as any).mock.calls[0][0]).toContain("user_id=laoxu");
  });

  it("global scope hits /aggregated (no user_id)", async () => {
    mockFetch({ results: [day("2026-05-16", 9, 90)] });
    const src = new LiteLLMUsageSource(env, Date.now());
    await src.queryModelBreakdown({ scope: { kind: "global" }, fromMs: Date.now() - 86400000, toMs: Date.now() });
    const url = (globalThis.fetch as any).mock.calls[0][0] as string;
    expect(url).toContain("/user/daily/activity/aggregated");
    expect(url).not.toContain("user_id=");
  });

  it("coalesces concurrent identical fetches (origin called once)", async () => {
    mockFetch({ results: [day("2026-05-16", 1, 1)] });
    const src = new LiteLLMUsageSource(env, Date.now());
    const s = { kind: "user" as const, userId: "u" };
    const w = { currentFromMs: 0, currentToMs: 1, previousFromMs: 0, previousToMs: 0 };
    await Promise.all([src.queryKpiWithDelta({ scope: s, ...w }), src.queryKpiWithDelta({ scope: s, ...w })]);
    expect((globalThis.fetch as any).mock.calls.length).toBe(1);
  });

  it("5xx/timeout → unavailable sentinel (caller maps to available:false)", async () => {
    mockFetch(503);
    const src = new LiteLLMUsageSource(env, Date.now());
    await expect(
      src.queryKpiWithDelta({ scope: { kind: "user", userId: "u" }, currentFromMs: 0, currentToMs: 1, previousFromMs: 0, previousToMs: 0 }),
    ).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("4xx / no data → empty (not error)", async () => {
    mockFetch({ results: [] });
    const src = new LiteLLMUsageSource(env, Date.now());
    const k = await src.queryKpiWithDelta({ scope: { kind: "user", userId: "u" }, currentFromMs: 0, currentToMs: 1, previousFromMs: 0, previousToMs: 0 });
    expect(k.current.spend).toBe(0);
    const ts = await src.queryTimeseries({ scope: { kind: "user", userId: "u" }, grain: "day", fromMs: 0, toMs: 1 });
    expect(ts).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `cd cloud && bun run vitest run src/litellm-portal/usage/litellm-usage-source.test.ts` → FAIL (module missing).

- [ ] **Step 3: Create `src/litellm-portal/usage/litellm-usage-source.ts`**

```typescript
import type { LiteLLMPortalEnv } from "../types";
import type { UsageSource, UsageScope, DashboardGrain } from "../dashboard-schemas";
import { litellmFetch } from "../litellm";
import { readJson } from "../utils";
import { parseDailyActivity, type DailyRow } from "./daily-activity";

const TZ_MS = 8 * 60 * 60 * 1000; // Asia/Shanghai
const CACHE_TTL_S = 120;
const FETCH_TIMEOUT_MS = 8000;

export type UsageUnavailable = { kind: "unavailable"; reason: string };
function unavailable(reason: string): UsageUnavailable {
  return { kind: "unavailable", reason };
}

function shDate(ms: number): string {
  return new Date(ms + TZ_MS).toISOString().slice(0, 10);
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class LiteLLMUsageSource implements UsageSource {
  private inflight = new Map<string, Promise<DailyRow[]>>();
  constructor(private env: LiteLLMPortalEnv, private now: number = Date.now()) {}

  /** Fetch [fromMs,toMs] daily rows for a scope, edge-cached + coalesced. */
  private async rows(scope: UsageScope, fromMs: number, toMs: number): Promise<DailyRow[]> {
    const start = shDate(fromMs);
    const end = shDate(toMs);
    const isUser = scope.kind === "user";
    const path = isUser ? "/user/daily/activity" : "/user/daily/activity/aggregated";
    const qs = new URLSearchParams({ start_date: start, end_date: end, timezone: "-480", page_size: "1000" });
    if (isUser) qs.set("user_id", scope.userId);
    const url = `${path}?${qs.toString()}`;
    const cacheKey = `usage:dua:${isUser ? scope.userId : "global"}:${start}:${end}`;
    const existing = this.inflight.get(cacheKey);
    if (existing) return existing;
    const p = (async (): Promise<DailyRow[]> => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
      try {
        const cacheKeyUrl = `https://cache.invalid/${await sha256Hex(cacheKey)}`;
        const resp = await litellmFetch(this.env, url, {
          signal: ctrl.signal,
          cf: { cacheEverything: true, cacheTtl: CACHE_TTL_S, cacheKey: cacheKeyUrl },
        } as RequestInit);
        const body = await readJson(resp);
        const parsed = parseDailyActivity(body);
        if (!Array.isArray(parsed)) {
          console.warn("[usage-litellm] unexpected shape", { path });
          throw unavailable("bad_shape");
        }
        return parsed;
      } catch (err) {
        if (err && typeof err === "object" && (err as { kind?: string }).kind === "unavailable") throw err;
        // litellmFetch throws LiteLLMRequestError on !ok; AbortError on timeout.
        const status = (err as { status?: number }).status;
        if (status !== undefined && status >= 400 && status < 500) return []; // no data, not a fault
        console.warn("[usage-litellm] fetch failed", { path, err: String(err).slice(0, 120) });
        throw unavailable(String(status ?? (err as Error)?.name ?? "error"));
      } finally {
        clearTimeout(t);
        this.inflight.delete(cacheKey);
      }
    })();
    this.inflight.set(cacheKey, p);
    return p;
  }

  private agg(rows: DailyRow[], fromMs: number, toMs: number) {
    const lo = shDate(fromMs);
    const hi = shDate(toMs);
    let spend = 0, requests = 0, totalTokens = 0;
    for (const r of rows) {
      if (r.date >= lo && r.date <= hi) { spend += r.spend; requests += r.requests; totalTokens += r.totalTokens; }
    }
    return { spend, requests, totalTokens };
  }

  async queryKpiWithDelta(o: {
    scope: UsageScope; currentFromMs: number; currentToMs: number; previousFromMs: number; previousToMs: number;
  }) {
    const rows = await this.rows(o.scope, Math.min(o.previousFromMs || o.currentFromMs, o.currentFromMs), o.currentToMs);
    return { current: this.agg(rows, o.currentFromMs, o.currentToMs), previous: this.agg(rows, o.previousFromMs, o.previousToMs) };
  }

  async queryTimeseries(o: { scope: UsageScope; grain: DashboardGrain; fromMs: number; toMs: number }) {
    const rows = await this.rows(o.scope, o.fromMs, o.toMs);
    const lo = shDate(o.fromMs), hi = shDate(o.toMs);
    return rows
      .filter((r) => r.date >= lo && r.date <= hi)
      .map((r) => ({
        startMs: Date.parse(`${r.date}T00:00:00.000+08:00`),
        label: r.date.slice(5), // MM-DD
        totalTokens: r.totalTokens, requests: r.requests, spend: Math.round(r.spend * 1e6) / 1e6,
      }));
  }

  async queryModelBreakdown(o: { scope: UsageScope; fromMs: number; toMs: number }) {
    const rows = await this.rows(o.scope, o.fromMs, o.toMs);
    const lo = shDate(o.fromMs), hi = shDate(o.toMs);
    const acc = new Map<string, { spend: number; totalTokens: number; requests: number }>();
    for (const r of rows) {
      if (r.date < lo || r.date > hi) continue;
      for (const m of r.models) {
        const cur = acc.get(m.model) ?? { spend: 0, totalTokens: 0, requests: 0 };
        cur.spend += m.spend; cur.totalTokens += m.totalTokens; cur.requests += m.requests;
        acc.set(m.model, cur);
      }
    }
    return [...acc.entries()]
      .map(([model, v]) => ({ model, spend: Math.round(v.spend * 1e6) / 1e6, totalTokens: v.totalTokens, requests: v.requests }))
      .sort((a, b) => b.spend - a.spend || b.totalTokens - a.totalTokens);
  }
}
```

Note: confirm `litellmFetch`'s `init` is passed through to `fetch` (it is — `litellm.ts:19` spreads `init`). The `cf` field on `RequestInit` is a Workers extension; the `as RequestInit` cast is required and acceptable here (Workers-only API, not a type-safety violation — add a one-line comment saying so to satisfy the no-`as` rule's "explicit justification").

- [ ] **Step 4: Run, expect PASS** — `cd cloud && bun run vitest run src/litellm-portal/usage/litellm-usage-source.test.ts` → all 5 pass. `bun run tsc --noEmit` baseline-only for these files.

- [ ] **Step 5: Commit**

```bash
git -C /Users/xumingyang/github/contrabass add cloud/src/litellm-portal/usage/litellm-usage-source.ts cloud/src/litellm-portal/usage/litellm-usage-source.test.ts
git -C /Users/xumingyang/github/contrabass commit -m "feat(litellm-portal): LiteLLMUsageSource direct+edge-cache+coalesce"
```

---

### Task 4: `USAGE_ROLLUP_KV` binding + rollup schema

**Files:**
- Modify: `src/litellm-portal/types.ts`
- Modify: `wrangler.litellm-portal.toml`
- Test: (covered by Task 5)

- [ ] **Step 1: Edit `types.ts`** — after `USER_PREFS_KV?: KVNamespace;` (line 26) add:

```typescript
  USAGE_ROLLUP_KV?: KVNamespace;
```

- [ ] **Step 2: Edit `wrangler.litellm-portal.toml`** — after the existing `[[kv_namespaces]] binding = "USER_PREFS_KV"` block (line 174-175 area) add a new block (the engineer must create the KV namespace and paste its id):

```toml
[[kv_namespaces]]
binding = "USAGE_ROLLUP_KV"
id = "<RUN: wrangler kv namespace create USAGE_ROLLUP_KV --config wrangler.litellm-portal.toml, paste id>"
```

- [ ] **Step 3: Verify** — `cd cloud && bun run tsc --noEmit` baseline-only (binding optional, no usage yet).

- [ ] **Step 4: Commit**

```bash
git -C /Users/xumingyang/github/contrabass add cloud/src/litellm-portal/types.ts cloud/wrangler.litellm-portal.toml
git -C /Users/xumingyang/github/contrabass commit -m "chore(litellm-portal): add USAGE_ROLLUP_KV binding"
```

---

### Task 5: `usage-rollup.ts` — roster rollup cron body

**Files:**
- Create: `src/litellm-portal/usage/usage-rollup.ts`
- Test: `src/litellm-portal/usage/usage-rollup.test.ts`

Reads roster from IndexDO (`listAllUsers`, same shape used in `dashboard.ts:172`), fetches each user's 30d daily/activity via `LiteLLMUsageSource`, slices per window, writes one KV key. Concurrency R=8. Per-user failure skipped; whole-run failure does not overwrite KV.

- [ ] **Step 1: Write the failing test** — `src/litellm-portal/usage/usage-rollup.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { runUsageRollup, ROLLUP_KEY } from "./usage-rollup";
import type { LiteLLMPortalEnv } from "../types";

function envWith(kv: { put: any }, users: string[], srcSpend: (u: string) => number | "throw") {
  const indexStub = {
    listAllUsers: vi.fn(async () => ({ users: users.map((u) => ({ userId: u, role: "user", maxBudget: 10 })), cursor: undefined })),
  };
  // LiteLLMUsageSource is constructed inside runUsageRollup; stub fetch instead.
  globalThis.fetch = vi.fn(async (url: any) => {
    const uid = new URL(url).searchParams.get("user_id")!;
    const v = srcSpend(uid);
    if (v === "throw") return new Response("", { status: 503 });
    return new Response(JSON.stringify({ results: [{ date: "2026-05-16", metrics: { spend: v, api_requests: 1, total_tokens: 2 }, breakdown: { models: {} } }] }), { status: 200 });
  }) as any;
  return {
    LITELLM_BASE_URL: "https://l.test", LITELLM_MASTER_KEY: "k",
    INDEX_DO: { idFromName: () => ({}), get: () => indexStub },
    USAGE_ROLLUP_KV: kv,
  } as unknown as LiteLLMPortalEnv;
}

describe("runUsageRollup", () => {
  it("writes per-user windowed rollup to KV", async () => {
    const put = vi.fn(async () => {});
    const env = envWith({ put }, ["laoxu", "jiang"], (u) => (u === "laoxu" ? 5 : 2));
    await runUsageRollup(env);
    expect(put).toHaveBeenCalledTimes(1);
    const [key, json] = put.mock.calls[0];
    expect(key).toBe(ROLLUP_KEY);
    const r = JSON.parse(json);
    expect(r.users.find((x: any) => x.userId === "laoxu").win["30d"].spend).toBe(5);
    expect(typeof r.generatedAt).toBe("string");
  });

  it("skips a failing user, keeps the rest", async () => {
    const put = vi.fn(async () => {});
    const env = envWith({ put }, ["ok", "bad"], (u) => (u === "bad" ? "throw" : 3));
    await runUsageRollup(env);
    const r = JSON.parse(put.mock.calls[0][1]);
    expect(r.users.map((u: any) => u.userId)).toEqual(["ok"]);
  });

  it("does NOT overwrite KV when the whole run fails (roster fetch throws)", async () => {
    const put = vi.fn(async () => {});
    const env = { INDEX_DO: { idFromName: () => ({}), get: () => ({ listAllUsers: vi.fn(async () => { throw new Error("idx down"); }) }) },
      USAGE_ROLLUP_KV: { put }, LITELLM_BASE_URL: "https://l.test", LITELLM_MASTER_KEY: "k" } as unknown as LiteLLMPortalEnv;
    await runUsageRollup(env);
    expect(put).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `cd cloud && bun run vitest run src/litellm-portal/usage/usage-rollup.test.ts` → FAIL (module missing).

- [ ] **Step 3: Create `src/litellm-portal/usage/usage-rollup.ts`**

```typescript
import type { LiteLLMPortalEnv } from "../types";
import type { IndexDOLike, UsageRollup, DashboardWindow } from "../dashboard-schemas";
import { DASHBOARD_WINDOWS, WINDOW_SPEC } from "../dashboard-schemas";
import { LiteLLMUsageSource } from "./litellm-usage-source";

export const ROLLUP_KEY = "usage:rollup:v1";
const ROLLUP_TTL_S = 2100; // > the */30 cron period
const ROLLUP_CONCURRENCY = 8;

function indexStub(env: LiteLLMPortalEnv): IndexDOLike | null {
  if (!env.INDEX_DO) return null;
  return env.INDEX_DO.get(env.INDEX_DO.idFromName("index")) as unknown as IndexDOLike;
}

export async function runUsageRollup(env: LiteLLMPortalEnv): Promise<void> {
  const kv = env.USAGE_ROLLUP_KV;
  const index = indexStub(env);
  if (!kv || index === null) return;
  let roster: Array<{ userId: string; maxBudget: number }>;
  try {
    roster = [];
    let cursor: string | undefined;
    do {
      const page = await index.listAllUsers({ limit: 200, cursor });
      for (const u of page.users) roster.push({ userId: u.userId, maxBudget: u.maxBudget ?? 0 });
      cursor = page.cursor;
    } while (cursor !== undefined);
  } catch (err) {
    console.warn("[usage-rollup] roster fetch failed; keeping prior KV", String(err).slice(0, 120));
    return; // do NOT overwrite KV
  }

  const now = Date.now();
  const src = new LiteLLMUsageSource(env, now);
  const out: UsageRollup["users"] = [];
  for (let i = 0; i < roster.length; i += ROLLUP_CONCURRENCY) {
    const chunk = roster.slice(i, i + ROLLUP_CONCURRENCY);
    const results = await Promise.all(chunk.map(async (u) => {
      try {
        const win = {} as Record<DashboardWindow, { spend: number; requests: number; totalTokens: number }>;
        for (const w of DASHBOARD_WINDOWS) {
          const k = await src.queryKpiWithDelta({
            scope: { kind: "user", userId: u.userId },
            currentFromMs: now - WINDOW_SPEC[w].lenMs, currentToMs: now,
            previousFromMs: 0, previousToMs: 0,
          });
          win[w] = k.current;
        }
        return { userId: u.userId, maxBudget: u.maxBudget, win };
      } catch {
        return null; // skip failing user
      }
    }));
    for (const r of results) if (r !== null) out.push(r);
  }

  const rollup: UsageRollup = { generatedAt: new Date(now).toISOString(), users: out };
  await kv.put(ROLLUP_KEY, JSON.stringify(rollup), { expirationTtl: ROLLUP_TTL_S });
}
```

(One 30d source fetch is reused across all four window slices because `LiteLLMUsageSource` coalesces by `[start,end]` cache key — the first `30d` call populates in-flight/edge; the narrower windows recompute from the same fetched rows only if the cache key differs. To guarantee one fetch per user, the rollup asks widest-first: iterate `DASHBOARD_WINDOWS` is `["24h","48h","7d","30d"]`; change the loop to fetch 30d once then slice — see Step 3b.)

- [ ] **Step 3b: Make it one fetch/user** — replace the `for (const w of DASHBOARD_WINDOWS)` block with a single 30d rows fetch + in-memory slicing:

```typescript
        const wide = await src.queryKpiWithDelta({
          scope: { kind: "user", userId: u.userId },
          currentFromMs: now - WINDOW_SPEC["30d"].lenMs, currentToMs: now,
          previousFromMs: 0, previousToMs: 0,
        }); // primes the 30d edge/in-flight cache
        const win = {} as Record<DashboardWindow, { spend: number; requests: number; totalTokens: number }>;
        for (const w of DASHBOARD_WINDOWS) {
          const k = await src.queryKpiWithDelta({
            scope: { kind: "user", userId: u.userId },
            currentFromMs: now - WINDOW_SPEC[w].lenMs, currentToMs: now,
            previousFromMs: 0, previousToMs: 0,
          });
          win[w] = k.current;
        }
        void wide;
```

(Edge cache keyed by `[start,end]` day strings; the 24h/48h/7d windows have different `start` so they are separate cache keys — acceptable: ≤4 cheap pre-aggregated calls per user, tens of users, every 30 min. Keep it simple; do NOT build a custom row-slicer.)

- [ ] **Step 4: Run, expect PASS** — `cd cloud && bun run vitest run src/litellm-portal/usage/usage-rollup.test.ts` → 3 pass. tsc baseline-only.

- [ ] **Step 5: Commit**

```bash
git -C /Users/xumingyang/github/contrabass add cloud/src/litellm-portal/usage/usage-rollup.ts cloud/src/litellm-portal/usage/usage-rollup.test.ts
git -C /Users/xumingyang/github/contrabass commit -m "feat(litellm-portal): */30 roster rollup to USAGE_ROLLUP_KV"
```

---

### Task 6: Wire `buildDashboard` deps + routes to the direct source + rollup

**Files:**
- Modify: `src/litellm-portal/routes.ts` (deps construction for `/usage/overview` + `/admin/usage/overview`)
- Modify: `src/litellm-portal/index.ts` (scheduled crons)
- Test: `src/litellm-portal/dashboard.test.ts` (rollup-backed perUser/summary)

- [ ] **Step 1: Write the failing test** — append to `src/litellm-portal/dashboard.test.ts`:

```typescript
import { buildDashboard } from "./dashboard";
it("global perUser + riskCount derive from rollup, no usage fan-out", async () => {
  const usage = {
    queryTimeseries: async () => [], queryModelBreakdown: async () => [],
    queryKpiWithDelta: async () => ({ current: { spend: 0, requests: 0, totalTokens: 0 }, previous: { spend: 0, requests: 0, totalTokens: 0 } }),
  };
  const index = { listTeams: async () => [{ id: "t", alias: "T" }], listAllUsers: async () => ({ users: [{ userId: "a", role: "user", maxBudget: 1 }], cursor: undefined }) };
  const rollup = { generatedAt: "x", users: [{ userId: "a", maxBudget: 1, win: { "24h": { spend: 0, requests: 0, totalTokens: 0 }, "48h": { spend: 0, requests: 0, totalTokens: 0 }, "7d": { spend: 0, requests: 0, totalTokens: 0 }, "30d": { spend: 9, requests: 3, totalTokens: 5 } } }] };
  const res = await buildDashboard({ usage, index, rollup, now: Date.now() }, { scope: { kind: "global" }, window: "30d", grain: "day", grainFallback: false });
  expect(res.perUser).toEqual([{ userId: "a", points: [{ startMs: expect.any(Number), spend: 9 }] }]);
  expect(res.summary?.riskCount).toBe(1); // 9 > maxBudget 1
});
```

- [ ] **Step 2: Run, expect FAIL** — `cd cloud && bun run vitest run src/litellm-portal/dashboard.test.ts -t "rollup"` → FAIL (buildDashboard signature lacks `rollup`, or perUser still from usage).

- [ ] **Step 3: Confirm Task 1 already changed `buildDashboard`** to read `deps.rollup` (it did). Fix `routes.ts`: locate the two handlers (`usageOverviewApp` `/usage/overview` ~line 890, `adminUsageOverviewApp` `/admin/usage/overview` ~910). Replace the `usageDOStub(c.env)` / `usage:` dep with the new source, and load the rollup for the global path. Add near the other dep helpers in `routes.ts`:

```typescript
import { LiteLLMUsageSource } from "./usage/litellm-usage-source";
import { ROLLUP_KEY } from "./usage/usage-rollup";
import type { UsageRollup } from "./dashboard-schemas";

async function loadRollup(env: LiteLLMPortalEnv): Promise<UsageRollup | null> {
  if (!env.USAGE_ROLLUP_KV) return null;
  try {
    const raw = await env.USAGE_ROLLUP_KV.get(ROLLUP_KEY);
    return raw ? (JSON.parse(raw) as UsageRollup) : null;
  } catch { return null; }
}
```

In `/usage/overview` handler change the `buildDashboard` deps to:

```typescript
    { usage: new LiteLLMUsageSource(c.env), index: indexDOLike(c.env), rollup: null, now: Date.now() },
```

In `/admin/usage/overview` handler:

```typescript
    const rollup = await loadRollup(c.env);
    const res = await buildDashboard(
      { usage: new LiteLLMUsageSource(c.env), index: indexDOLike(c.env), rollup, now: Date.now() },
      { scope, window: parsed.window, grain: parsed.grain, grainFallback: parsed.grainFallback },
    );
```

Map the source's `UsageUnavailable` throw to `available:false`: wrap the `buildDashboard` call in each handler:

```typescript
    let res;
    try { res = await buildDashboard(deps, opts); }
    catch (e) {
      if (e && (e as { kind?: string }).kind === "unavailable") {
        return c.json({ scope: scopeLabelFor(opts.scope), window: parsed.window, grain: "day",
          grainFallback: false, timezone: "Asia/Shanghai", available: false, empty: false,
          kpi: { spend:{current:0,previous:null,deltaPct:null}, requests:{current:0,previous:null,deltaPct:null}, totalTokens:{current:0,previous:null,deltaPct:null} },
          trend: [], models: [] }, 200);
      }
      throw e;
    }
    return c.json(res);
```

(Add a tiny local `scopeLabelFor` mirroring `buildDashboard`'s `scopeLabel`, or inline the string. Keep both handlers consistent — extract a shared helper `respondDashboard(c, deps, parsed, scope)` in `routes.ts` to avoid duplication.)

- [ ] **Step 4: Edit `index.ts` `scheduled`** — add the `*/30` rollup branch and remove the `*/5` ingest branch:

```typescript
    if (controller.cron === "*/30 * * * *") {
      ctx.waitUntil(runUsageRollup(env));
      return;
    }
```

Delete the `if (controller.cron === "*/5 * * * *") { ctx.waitUntil(ingestSpendLogs(env)); return; }` block. Add `import { runUsageRollup } from "./usage/usage-rollup";`; remove the now-unused `ingestSpendLogs` import (keep `refreshDailyActivity`/`pruneUsageRetention` imports until Task 9 — `0 * * * *` still calls `refreshDailyActivity`; that is removed in Task 9).

- [ ] **Step 5: Edit `wrangler.litellm-portal.toml` crons** (line 153): change
`crons = ["0 9 * * *", "* * * * *", "*/5 * * * *", "0 * * * *"]` →
`crons = ["0 9 * * *", "* * * * *", "*/30 * * * *", "0 * * * *"]`.

- [ ] **Step 6: Run** — `cd cloud && bun run vitest run src/litellm-portal/dashboard.test.ts && bun run tsc --noEmit`. Expected: dashboard tests pass; tsc shows ONLY the baseline plus any references to soon-deleted symbols in files Task 9 removes — if tsc surfaces an error in `routes.ts`/`index.ts` from this task's own edits, fix it now; errors localized to `usage-do.ts`/`usage-importer.ts` (untouched here) are expected until Task 9.

- [ ] **Step 7: Commit**

```bash
git -C /Users/xumingyang/github/contrabass add cloud/src/litellm-portal/routes.ts cloud/src/litellm-portal/index.ts cloud/wrangler.litellm-portal.toml cloud/src/litellm-portal/dashboard.test.ts
git -C /Users/xumingyang/github/contrabass commit -m "feat(litellm-portal): wire dashboard to direct source + rollup, swap crons"
```

---

### Task 7: Frontend — remove recent + hour-of-day panels, day-grain trend

**Files:**
- Modify: `src/litellm-portal/dashboard/views/personal-view.tsx`, `dashboard/views/admin-view.tsx`
- Delete: `src/litellm-portal/dashboard/charts/hour-bars.tsx`
- Modify: `dashboard/views/personal-view.test.tsx`, `admin-view.test.tsx`, `member-overlay.tsx`/`.test.tsx`, `portal.stories.tsx`, `app.tsx`, `app.test.tsx` (only the parts referencing `recent`/`hourOfDay`)

- [ ] **Step 1: Inventory** — `cd cloud && rg -n "hourOfDay|HourBucket|hour-bars|recent\b|RecentEvent|queryRecentEvents" src/litellm-portal --glob '*.tsx' --glob '*.ts' -l`. This is the exact edit set.

- [ ] **Step 2: Remove the panels** — in `personal-view.tsx` delete the recent-events table block and the hour-of-day chart block + their imports (`hour-bars`). In `admin-view.tsx` delete the hour-of-day usage. Delete `dashboard/charts/hour-bars.tsx`. Remove `recent`/`hourOfDay` from any local prop/types that mirror `DashboardResponse`. Render `trend` as-is (it is already a `TrendPoint[]`; day-grain just yields fewer points — no component change needed beyond not assuming hourly density; if a label formatter assumed `HH:00`, switch it to the `label` field verbatim).

- [ ] **Step 3: Update component tests + stories** — in each `*.test.tsx`/`portal.stories.tsx` remove fixtures/assertions for `recent`/`hourOfDay`. Keep KPI/trend/models/perUser/summary assertions.

- [ ] **Step 4: Run** — `cd cloud && bun run vitest run src/litellm-portal/ --silent` (frontend uses the same vitest). Expected: all green; no test references deleted panels. `bun run tsc --noEmit` — errors only from Task 9's not-yet-deleted files.

- [ ] **Step 5: Commit**

```bash
git -C /Users/xumingyang/github/contrabass add cloud/src/litellm-portal/dashboard cloud/src/litellm-portal/portal.stories.tsx cloud/src/litellm-portal/app.tsx cloud/src/litellm-portal/app.test.tsx
git -C /Users/xumingyang/github/contrabass commit -m "refactor(litellm-portal): drop recent + hour-of-day dashboard panels"
```

---

### Task 8: Verify new path green end-to-end (gate before deletion)

**Files:** none (verification only).

- [ ] **Step 1** — `cd cloud && bun run vitest run src/litellm-portal/` → ALL pass (new usage/* suites + dashboard + frontend). Record totals.
- [ ] **Step 2** — Confirm the only tsc errors remaining are inside files Task 9 deletes (`usage-do.ts`, `usage-importer.ts`, their tests, attribution code) plus baseline `server.ts(6,33)`. List them explicitly; if any error is in a KEPT file, fix before proceeding.
- [ ] **Step 3** — No commit (gate). If green, proceed to Task 9; the new path is fully functional with the old path still present but unreferenced by `scheduled`/routes.

---

### Task 9: Retire the firehose / DO / attribution layer

**Files:**
- Delete: `src/litellm-portal/durable/usage-do.ts`, `durable/usage-do.test.ts`, `durable/usage-schemas.ts`, `sync/usage-importer.ts`, `sync/usage-importer.test.ts`
- Modify: `src/litellm-portal/index.ts` (remove `UsageDOSQLite` export, `ingestSpendLogs`/`refreshDailyActivity`/`pruneUsageRetention` imports + the `0 * * * *` and the events branch of `0 9 * * *`), `routes.ts` (delete `usageDOStub` + any `queryRecentEvents`/`queryHourOfDay`/`queryPerUserSeries`/`queryUserDetail` callers + the `/admin/usage/users/:id` style detail route if it depends on `queryUserDetail` — replace with rollup or remove per spec), `types.ts` (remove `USAGE_DO`), `wrangler.litellm-portal.toml` (remove the `USAGE_DO` `[[durable_objects.bindings]]` block; add the required `[[migrations]]` `deleted_classes = ["UsageDO"]` tag — follow the existing migration-tag pattern/comments already in that file, lines ~47-89)

- [ ] **Step 1: Delete files** —

```bash
cd /Users/xumingyang/github/contrabass/cloud
git rm src/litellm-portal/durable/usage-do.ts src/litellm-portal/durable/usage-do.test.ts src/litellm-portal/durable/usage-schemas.ts src/litellm-portal/sync/usage-importer.ts src/litellm-portal/sync/usage-importer.test.ts
```

- [ ] **Step 2: Strip `index.ts`** — remove `export { UsageDO as UsageDOSQLite } ...`; remove imports of `ingestSpendLogs, refreshDailyActivity, pruneUsageRetention` from `./sync/usage-importer`; in `scheduled`, delete the `0 * * * *` branch entirely and remove `pruneUsageRetention(env)` from the `0 9 * * *` branch (keep `scanBudgetThresholds`). Remove `0 * * * *` from `wrangler.litellm-portal.toml` `crons` → `crons = ["0 9 * * *", "* * * * *", "*/30 * * * *"]`.

- [ ] **Step 3: Strip `routes.ts`** — delete `usageDOStub` helper and every call site. Any route still calling `queryRecentEvents`/`queryHourOfDay`/`queryUserDetail`/`queryPerUserSeries` on a DO must be deleted or repointed at `loadRollup`/`LiteLLMUsageSource` per the spec (member drill-down uses `LiteLLMUsageSource` with `scope:{kind:"user"}`; there is no recent/hour route anymore — remove those endpoints and their tests).

- [ ] **Step 4: Strip bindings** — `types.ts` remove `USAGE_DO?: DurableObjectNamespace;`. `wrangler.litellm-portal.toml`: delete the `[[durable_objects.bindings]] name = "USAGE_DO"` block; append a new `[[migrations]]` entry with the next tag and `deleted_classes = ["UsageDO"]`, matching the documented pattern in that file (read lines 47-95 and follow it exactly — wrong migration ordering causes CF deploy error 10061/10064).

- [ ] **Step 5: Verify deletion** —

```bash
cd /Users/xumingyang/github/contrabass/cloud
rg -n "/spend/logs/v2|cb_usage_events|\battributed\b|UsageDO|usageDOStub|ingestSpendLogs|SpendEventSchema|SpendEventInput|queryRecentEvents|queryHourOfDay" src/litellm-portal --glob '!*node_modules*'
```
Expected: ZERO matches (only possibly in the design/plan docs, which are outside `src/`). Any hit in `src/` = incomplete deletion; fix.

- [ ] **Step 6: Full check** — `cd cloud && bun run tsc --noEmit` → ONLY baseline `server.ts(6,33) TS6142`. `bun run vitest run src/litellm-portal/` → ALL pass, zero references to removed symbols.

- [ ] **Step 7: Commit**

```bash
git -C /Users/xumingyang/github/contrabass add -A cloud/src/litellm-portal cloud/wrangler.litellm-portal.toml
git -C /Users/xumingyang/github/contrabass commit -m "refactor(litellm-portal): retire SQLite firehose, UsageDO, attribution filter"
```
(Here `-A` is scoped to the two paths and is the documented exception for staging deletions; verify `git status` shows only intended removals/edits before committing.)

---

### Task 10: Build, deploy, post-deploy smoke vs measured ground truth

**Files:** none.

- [ ] **Step 1: Full local CI** — `cd cloud && bun run tsc --noEmit` (baseline only) and `bun run vitest run src/litellm-portal/` (all green). Record totals.

- [ ] **Step 2: Create the KV namespace if not yet done** (Task 4 left a placeholder): `cd cloud && wrangler kv namespace create USAGE_ROLLUP_KV --config wrangler.litellm-portal.toml`, paste the `id` into `wrangler.litellm-portal.toml`, commit `chore(litellm-portal): set USAGE_ROLLUP_KV id`.

- [ ] **Step 3: Deploy** — `cd cloud && bun run deploy:litellm-portal` (canonical pipeline; never bare `wrangler deploy`). Record `Current Version ID`.

- [ ] **Step 4: Smoke (browser-harness, logged-in session)** — fetch `/api/usage/overview?window=48h` (self = `xu@gz-zhiyun.com` → `laoxu`):

```bash
browser-harness -c '
new_tab("https://zhiyun.ziikoo.com/")
wait_for_load()
print(js("(async()=>{const r=await fetch(\"/api/usage/overview?window=48h\",{credentials:\"include\"});return await r.text();})()"))
'
```
Expected: `available:true`, `empty:false`, `kpi.spend.current` ≈ the measured LiteLLM ground truth for `laoxu` 48h (**$62.85 / 872 requests / 98.1M tokens** as of 2026-05-16; numbers will have moved — assert non-zero and same order of magnitude, NOT the stale `0`). `trend` has day buckets; no `recent`/`hourOfDay` keys.

- [ ] **Step 5: Smoke admin rollup** — wait one `*/30` tick (or trigger once), then fetch `/api/usage/overview` admin/global and confirm `perUser` non-empty and `summary.riskCount` populated from KV. Confirm logs show `[usage-rollup]` only on failure, no `/spend/logs/v2` calls, no `*/5` cron.

- [ ] **Step 6: Final commit (if any KV-id/doc tweaks)** then STOP. Do not open the PR from plan execution — return control to the owner for the batched PR decision (this branch also carries the attribution filter + prior incident fixes).

---

## Self-Review

**Spec coverage:** §Architecture→T1-T7,T9; LiteLLMUsageSource (cache/coalesce/timeout/3 failure modes)→T3; daily parser→T2; rollup+KV→T4,T5; buildDashboard/summary rewire→T1,T6; frontend drop→T7; retirement→T9; verification/smoke vs ground truth→T8,T10; weak-degradation (available:false, never 5xx)→T3+T6 Step 3; Shanghai day boundary→T3 `shDate`; no-key cacheKey→T3 `sha256Hex(cacheKey)`; deletion-after-green→T8 gate before T9. All spec sections map to a task.

**Placeholder scan:** no TBD/“handle errors”/“similar to”. The two intentional human inputs (KV namespace id in T4/T10 Step 2; the CF migration tag in T9 Step 4) are explicit actions with exact commands/why, not vague placeholders.

**Type consistency:** `UsageSource` (3 methods) defined T1, implemented T3, consumed T6; `UsageRollup` defined T1, written T5 (`ROLLUP_KEY`), read T6 (`loadRollup`); `BuildDeps.rollup` added T1, supplied T6; `DailyRow` defined T2 used T3/T5; `UsageUnavailable {kind:"unavailable"}` thrown T3, caught T6. `parseDailyActivity`, `runUsageRollup`, `ROLLUP_KEY`, `LiteLLMUsageSource` names consistent across tasks. Window keys `"24h"|"48h"|"7d"|"30d"` from `DASHBOARD_WINDOWS` used consistently in T1/T5/T6.
