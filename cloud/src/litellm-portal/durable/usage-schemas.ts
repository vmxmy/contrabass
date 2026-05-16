import { z } from "zod";

/** One ingested spend-log row (raw request grain). */
export const SpendEventSchema = z
  .object({
    requestId: z.string().min(1),
    tsMs: z.number().int().nonnegative(),
    userId: z.string(),
    teamId: z.string(),
    model: z.string(),
    promptTokens: z.number().int().nonnegative(),
    completionTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    spend: z.number().nonnegative(),
  })
  .strict();
export type SpendEvent = z.infer<typeof SpendEventSchema>;

/** One daily-activity rollup row. userId is "__global__" for aggregated source. */
export const DailyRowSchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    userId: z.string(),
    model: z.string(),
    spend: z.number().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    promptTokens: z.number().int().nonnegative(),
    completionTokens: z.number().int().nonnegative(),
    requests: z.number().int().nonnegative(),
    successRequests: z.number().int().nonnegative().nullable(),
    failedRequests: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type DailyRow = z.infer<typeof DailyRowSchema>;

export const UsageSyncSourceSchema = z.enum(["spend_logs", "daily_activity"]);
export type UsageSyncSource = z.infer<typeof UsageSyncSourceSchema>;

export type UsageScope = { kind: "global" } | { kind: "user"; userId: string };

export type UsageWindowSpec = { fromMs: number; toMs: number };

export type TimeseriesBucket = {
  startMs: number;
  label: string;
  totalTokens: number;
  requests: number;
  spend: number;
};

export type ModelSlice = { model: string; spend: number; totalTokens: number; requests: number };
export type HourBucket = { hour: number; totalTokens: number; requests: number; spend: number };
export type RecentEvent = { tsMs: number; model: string; totalTokens: number; spend: number };
export type PerUserSeries = { userId: string; points: Array<{ startMs: number; spend: number }> };
export type UserDetail = {
  spend: number;
  requests: number;
  totalTokens: number;
  models: ModelSlice[];
  hours: HourBucket[];
};
export type KpiWithDelta = {
  current: { spend: number; requests: number; totalTokens: number };
  previous: { spend: number; requests: number; totalTokens: number };
};
