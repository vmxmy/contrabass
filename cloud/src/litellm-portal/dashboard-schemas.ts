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
const HourBucket = z.object({
  hour: z.number(),
  totalTokens: z.number(),
  requests: z.number(),
  spend: z.number(),
});
const RecentEvent = z.object({
  tsMs: z.number(),
  model: z.string(),
  totalTokens: z.number(),
  spend: z.number(),
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
    hourOfDay: z.array(HourBucket),
    perUser: z.array(PerUser).optional(),
    summary: Summary.optional(),
    recent: z.array(RecentEvent).optional(),
  })
  .strict();
export type DashboardResponse = z.infer<typeof DashboardResponseSchema>;

/** L1 UsageDO 方法子集(镜像当前真实签名,解耦编译)。 */
export type UsageDOStub = {
  queryTimeseries(o: {
    scope: UsageScope;
    grain: DashboardGrain;
    fromMs: number;
    toMs: number;
  }): Promise<Array<{ startMs: number; label: string; totalTokens: number; requests: number; spend: number }>>;
  queryModelBreakdown(o: {
    scope: UsageScope;
    fromMs: number;
    toMs: number;
  }): Promise<Array<{ model: string; spend: number; totalTokens: number; requests: number }>>;
  queryHourOfDay(o: {
    scope: UsageScope;
    fromMs: number;
    toMs: number;
  }): Promise<Array<{ hour: number; totalTokens: number; requests: number; spend: number }>>;
  queryPerUserSeries(o: {
    grain: DashboardGrain;
    fromMs: number;
    toMs: number;
    topN: number;
  }): Promise<Array<{ userId: string; points: Array<{ startMs: number; spend: number }> }>>;
  queryRecentEvents(o: {
    userId: string;
    limit: number;
  }): Promise<Array<{ tsMs: number; model: string; totalTokens: number; spend: number }>>;
  queryKpiWithDelta(o: {
    scope: UsageScope;
    currentFromMs: number;
    currentToMs: number;
    previousFromMs: number;
    previousToMs: number;
    eventsOnly?: boolean;
    nowMs?: number;
  }): Promise<{
    current: { spend: number; requests: number; totalTokens: number; source: "events" | "daily" | "split" };
    previous: { spend: number; requests: number; totalTokens: number; source: "events" | "daily" | "split" };
  }>;
};

export type IndexDOLike = {
  listTeams(): Promise<Array<{ id: string; alias: string }>>;
  listAllUsers(opts?: { limit?: number; cursor?: string }): Promise<{
    users: Array<{ userId: string; role: "admin" | "user"; maxBudget?: number }>;
    cursor: string | undefined;
  }>;
};
