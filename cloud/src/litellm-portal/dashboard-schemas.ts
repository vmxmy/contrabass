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

export type DashboardScope = { kind: "self"; userId: string } | { kind: "global" } | { kind: "member"; userId: string };

export type UsageScope = { kind: "global" } | { kind: "user"; userId: string };

const KpiMetric = z.object({
  current: z.number(),
  previous: z.number().nullable(),
  deltaPct: z.number().nullable(),
});

const TrendPoint = z.object({
  startMs: z.number(),
  label: z.string(),
  totalTokens: z.number(),
  requests: z.number(),
  spend: z.number(),
});
const ModelSlice = z.object({
  model: z.string(),
  spend: z.number(),
  totalTokens: z.number(),
  requests: z.number(),
});
const PerUser = z.object({
  userId: z.string(),
  points: z.array(z.object({ startMs: z.number(), spend: z.number() })),
});
const Summary = z.object({
  userCount: z.number(),
  adminCount: z.number(),
  teamCount: z.number(),
  totalSpend: z.number(),
  totalBudget: z.number(),
  riskCount: z.number(),
  sampled: z.boolean(),
});

export const DashboardResponseSchema = z
  .object({
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
    perUser: z.array(PerUser).optional(),
    summary: Summary.optional(),
  })
  .strict();
export type DashboardResponse = z.infer<typeof DashboardResponseSchema>;

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

/** Per-tenant rollup written by the /30 cron, read by the admin path. */
export type UsageRollup = {
  generatedAt: string;
  users: Array<{
    userId: string;
    maxBudget: number;
    win: Record<DashboardWindow, { spend: number; requests: number; totalTokens: number }>;
  }>;
};

export type IndexDOLike = {
  listTeams(): Promise<Array<{ id: string; alias: string }>>;
  listAllUsers(opts?: { limit?: number; cursor?: string }): Promise<{
    users: Array<{ userId: string; role: "admin" | "user"; maxBudget?: number }>;
    cursor: string | undefined;
  }>;
};
