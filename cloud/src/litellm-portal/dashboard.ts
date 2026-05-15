import {
  DASHBOARD_WINDOWS,
  WINDOW_SPEC,
  EVENT_RETENTION_MS,
  type DashboardWindow,
  type DashboardGrain,
  type DashboardScope,
  type UsageScope,
  type UsageDOStub,
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
      hourOfDay: emptyHours(),
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
    hourOfDay,
  };

  if (opts.scope.kind === "global") {
    const [perUser, summary] = await Promise.all([
      deps.usage.queryPerUserSeries({ grain: opts.grain, fromMs, toMs, topN: 8 }),
      buildSummary(deps, kpiRaw.current.spend, fromMs, toMs),
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

export async function buildSummary(
  deps: BuildDeps,
  totalSpend: number,
  windowFromMs: number,
  windowToMs: number,
): Promise<NonNullable<DashboardResponse["summary"]>> {
  if (deps.index === null) {
    return { userCount: 0, adminCount: 0, teamCount: 0, totalSpend, totalBudget: 0, riskCount: 0, sampled: false };
  }
  const teams = await deps.index.listTeams();
  // Paginate the FULL user population to get accurate population stats.
  // adminCount, totalBudget, and totalUserCount are computed over ALL pages.
  // The per-user risk probe fan-out is separately bounded to SUMMARY_USER_CAP
  // budgeted users — plain IndexDO SQL pages are cheap; the KPI probes are not.
  let totalUserCount = 0;
  let adminCount = 0;
  let totalBudget = 0;
  const budgetedSample: Array<{ userId: string; maxBudget: number }> = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await deps.index.listAllUsers({ limit: 200, cursor });
    for (const u of page.users) {
      totalUserCount += 1;
      if (u.role === "admin") adminCount += 1;
      totalBudget += u.maxBudget ?? 0;
      if (u.maxBudget != null && u.maxBudget > 0 && budgetedSample.length < SUMMARY_USER_CAP) {
        budgetedSample.push({ userId: u.userId, maxBudget: u.maxBudget });
      }
    }
    cursor = page.cursor;
    if (cursor === undefined) break;
  }
  // sampled = true means risk probes cover only a sample of budgeted users
  const sampled = totalUserCount > SUMMARY_USER_CAP;
  // Risk = users whose IN-WINDOW spend exceeds their maxBudget. The
  // per-user KPI probe is an N-query fan-out, so run it with bounded
  // concurrency (NOT a serial await-in-loop) to keep the admin request
  // latency bounded even at SUMMARY_USER_CAP users.
  const usage = deps.usage;
  const budgeted = usage === null ? [] : budgetedSample;
  const RISK_CONCURRENCY = 10;
  let riskCount = 0;
  for (let i = 0; i < budgeted.length; i += RISK_CONCURRENCY) {
    const chunk = budgeted.slice(i, i + RISK_CONCURRENCY);
    const spends = await Promise.all(
      chunk.map(async (u) => {
        const k = await usage!.queryKpiWithDelta({
          scope: { kind: "user", userId: u.userId },
          currentFromMs: windowFromMs,
          currentToMs: windowToMs,
          // previous range intentionally empty — only current.spend is consumed here
          previousFromMs: 0,
          previousToMs: 0,
        });
        return k.current.spend;
      }),
    );
    spends.forEach((s, j) => {
      if (s > chunk[j].maxBudget) riskCount += 1;
    });
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
