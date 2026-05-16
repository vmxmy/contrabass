// L3 client-side mirror of the L2 response contract (src/litellm-portal/dashboard-schemas.ts).
// Deliberately a separate file: the L3 frontend island bundle must not import server-side
// L2 code. Plain z.object() (not .strict()) is intentional — this is a CONSUMER schema, so
// unknown/forward-compatible fields from L2 are stripped, never thrown on. Keep field shapes
// in sync with the L2 schema; additive L2 changes are backward-safe here by design.
import { z } from "zod";

export const DASHBOARD_WINDOWS = ["24h", "48h", "7d", "30d"] as const;
export type DashboardWindow = (typeof DASHBOARD_WINDOWS)[number];

const Kpi = z.object({
  current: z.number(),
  previous: z.number().nullable(),
  deltaPct: z.number().nullable(),
});

export const DashboardResponseSchema = z.object({
  available: z.boolean(),
  empty: z.boolean(),
  scope: z.string(),
  window: z.enum(DASHBOARD_WINDOWS),
  grain: z.enum(["hour", "day"]),
  grainFallback: z.boolean(),
  timezone: z.literal("Asia/Shanghai"),
  kpi: z.object({ spend: Kpi, requests: Kpi, totalTokens: Kpi }),
  trend: z.array(z.object({
    startMs: z.number(), label: z.string(),
    totalTokens: z.number(), requests: z.number(), spend: z.number(),
  })),
  models: z.array(z.object({
    model: z.string(), spend: z.number(), totalTokens: z.number(), requests: z.number(),
  })),
  hourOfDay: z.array(z.object({
    hour: z.number(), totalTokens: z.number(), requests: z.number(), spend: z.number(),
  })),
  perUser: z.array(z.object({
    userId: z.string(),
    points: z.array(z.object({ startMs: z.number(), spend: z.number() })),
  })).optional(),
  summary: z.object({
    userCount: z.number(), adminCount: z.number(), teamCount: z.number(),
    totalSpend: z.number(), totalBudget: z.number(), riskCount: z.number(),
    sampled: z.boolean(),
  }).optional(),
  recent: z.array(z.object({
    tsMs: z.number(), model: z.string(), totalTokens: z.number(), spend: z.number(),
  })).optional(),
});
export type DashboardResponse = z.infer<typeof DashboardResponseSchema>;
