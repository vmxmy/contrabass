import {
  DASHBOARD_WINDOWS,
  WINDOW_SPEC,
  EVENT_RETENTION_MS,
  type DashboardWindow,
  type DashboardGrain,
  type DashboardScope,
  type UsageScope,
  type UsageSource,
  type UsageRollup,
  type IndexDOLike,
  type DashboardResponse,
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

type BuildDeps = { usage: UsageSource | null; index: IndexDOLike | null; rollup: UsageRollup | null; now: number };
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

export const SUMMARY_USER_CAP = 200;

export async function buildDashboard(deps: BuildDeps, opts: BuildOpts): Promise<DashboardResponse> {
  const scopeLabel =
    opts.scope.kind === "global" ? "global" : opts.scope.kind === "member" ? `member:${opts.scope.userId}` : "self";
  const base = {
    scope: scopeLabel,
    window: opts.window,
    grain: opts.grain,
    grainFallback: opts.grainFallback,
    timezone: "Asia/Shanghai" as const,
  };

  if (deps.usage === null) {
    return {
      ...base,
      available: false,
      empty: false,
      kpi: emptyKpi(),
      trend: [],
      models: [],
    };
  }

  const toMs = deps.now;
  const fromMs = toMs - WINDOW_SPEC[opts.window].lenMs;
  const prevToMs = fromMs;
  const prevFromMs = fromMs - WINDOW_SPEC[opts.window].lenMs;
  // NOTE: EVENT_RETENTION_MS here (dashboard-schemas.ts) must stay in lockstep
  // with the retention window used by the usage source. L2 nulls the 30d
  // `previous` deliberately (current=events vs previous=daily would be
  // apples-to-oranges); this is a stricter presentation policy than L1's own
  // data-availability source resolution, by design (L2 spec §3).
  const prevComparable = prevFromMs >= deps.now - EVENT_RETENTION_MS;
  const us = toUsageScope(opts.scope);

  const [trend, models, kpiRaw] = await Promise.all([
    deps.usage.queryTimeseries({ scope: us, grain: opts.grain, fromMs, toMs }),
    deps.usage.queryModelBreakdown({ scope: us, fromMs, toMs }),
    deps.usage.queryKpiWithDelta({
      scope: us,
      currentFromMs: fromMs,
      currentToMs: toMs,
      previousFromMs: prevFromMs,
      previousToMs: prevToMs,
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

  const empty =
    trend.length === 0 && models.length === 0 && kpiRaw.current.spend === 0 && kpiRaw.current.requests === 0;

  const result: DashboardResponse = {
    ...base,
    available: true,
    empty,
    kpi,
    trend,
    models,
  };

  if (opts.scope.kind === "global") {
    result.perUser = (deps.rollup?.users ?? [])
      .map((u) => ({ userId: u.userId, points: [{ startMs: fromMs, spend: u.win[opts.window]?.spend ?? 0 }] }))
      .filter((p) => p.points[0].spend > 0)
      .sort((a, b) => b.points[0].spend - a.points[0].spend)
      .slice(0, 8);
    result.summary = await buildSummary(deps, kpiRaw.current.spend, opts.window);
  }
  return result;
}

function emptyKpi() {
  const z = { current: 0, previous: null, deltaPct: null };
  return { spend: { ...z }, requests: { ...z }, totalTokens: { ...z } };
}
export async function buildSummary(
  deps: BuildDeps,
  totalSpend: number,
  window: DashboardWindow,
): Promise<NonNullable<DashboardResponse["summary"]>> {
  if (deps.index === null) {
    return { userCount: 0, adminCount: 0, teamCount: 0, totalSpend, totalBudget: 0, riskCount: 0, sampled: false };
  }
  const teams = await deps.index.listTeams();
  // Paginate the FULL user population to get accurate population stats.
  // adminCount, totalBudget, and totalUserCount are computed over ALL pages.
  let totalUserCount = 0;
  let adminCount = 0;
  let totalBudget = 0;
  let cursor: string | undefined;
  for (;;) {
    const page = await deps.index.listAllUsers({ limit: 200, cursor });
    for (const u of page.users) {
      totalUserCount += 1;
      if (u.role === "admin") adminCount += 1;
      totalBudget += u.maxBudget ?? 0;
    }
    cursor = page.cursor;
    if (cursor === undefined) break;
  }
  const sampled = false;
  let riskCount = 0;
  for (const u of deps.rollup?.users ?? []) {
    if (u.maxBudget > 0 && (u.win[window]?.spend ?? 0) > u.maxBudget) riskCount += 1;
  }
  return {
    userCount: totalUserCount,
    adminCount,
    teamCount: teams.length,
    totalSpend,
    totalBudget,
    riskCount,
    sampled,
  };
}
