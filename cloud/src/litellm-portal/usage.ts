import type { LiteLLMUsageAnalytics, LiteLLMModelUsage, LiteLLMPortalEnv } from "./types";
import { dateOnly, isRecord, readJson, roundCurrency, sumNumbers } from "./utils";
import { firstString, litellmFetch, numberField } from "./litellm";

export const LITELLM_DAILY_ACTIVITY_TIMEZONE_OFFSET_MINUTES = "-480";

export async function readUserDailyActivity(env: LiteLLMPortalEnv, userId: string): Promise<LiteLLMUsageAnalytics> {
  const endDate = dateOnly(new Date());
  const startDate = dateOnly(new Date(Date.now() - 29 * 24 * 60 * 60 * 1000));
  return readUserDailyActivityRange(env, userId, startDate, endDate, 30);
}

export async function readUserDailyActivityRange(
  env: LiteLLMPortalEnv,
  userId: string,
  startDate: string,
  endDate: string,
  pageSize: number,
): Promise<LiteLLMUsageAnalytics> {
  const baseParams = {
    user_id: userId,
    start_date: startDate,
    end_date: endDate,
    timezone: LITELLM_DAILY_ACTIVITY_TIMEZONE_OFFSET_MINUTES,
  };
  const aggregatedParams = new URLSearchParams(baseParams);
  const paginatedParams = new URLSearchParams({
    ...baseParams,
    page_size: String(Math.min(Math.max(pageSize, 1), 1000)),
  });

  try {
    const response = await litellmFetch(env, `/user/daily/activity/aggregated?${aggregatedParams.toString()}`);
    const body = await readJson(response);
    return normalizeDailyActivity(body, startDate, endDate);
  } catch {
    try {
      const response = await litellmFetch(env, `/user/daily/activity?${paginatedParams.toString()}`);
      const body = await readJson(response);
      return normalizeDailyActivity(body, startDate, endDate);
    } catch {
      return emptyDailyActivity(startDate, endDate);
    }
  }
}

function normalizeDailyActivity(body: unknown, startDate: string, endDate: string): LiteLLMUsageAnalytics {
  if (!isRecord(body)) {
    return emptyDailyActivity(startDate, endDate);
  }

  const records = Array.isArray(body.results) ? body.results.filter(isRecord) : [];
  const days = records.map((record) => {
    const metrics = isRecord(record.metrics) ? record.metrics : {};
    return {
      date: firstString(record, ["date"]) ?? "",
      spend: roundCurrency(numberField(metrics, "spend") ?? 0),
      totalTokens: numberField(metrics, "total_tokens") ?? numberField(metrics, "totalTokens") ?? 0,
      promptTokens: numberField(metrics, "prompt_tokens") ?? numberField(metrics, "promptTokens") ?? 0,
      completionTokens: numberField(metrics, "completion_tokens") ?? numberField(metrics, "completionTokens") ?? 0,
      requests: numberField(metrics, "api_requests") ?? numberField(metrics, "apiRequests") ?? 0,
    };
  }).filter((day) => day.date.length > 0);

  const metadata = isRecord(body.metadata) ? body.metadata : {};
  const topModels = topModelsFromDailyRecords(records);

  return {
    available: true,
    startDate,
    endDate,
    totalSpend: roundCurrency(numberField(metadata, "total_spend") ?? sumNumbers(days.map((day) => day.spend))),
    totalTokens: numberField(metadata, "total_tokens") ?? sumNumbers(days.map((day) => day.totalTokens)),
    requestCount: numberField(metadata, "total_api_requests") ?? sumNumbers(days.map((day) => day.requests)),
    successfulRequests: numberField(metadata, "total_successful_requests") ?? 0,
    failedRequests: numberField(metadata, "total_failed_requests") ?? 0,
    days,
    topModels,
  };
}

function topModelsFromDailyRecords(records: Array<Record<string, unknown>>): LiteLLMModelUsage[] {
  const totals = new Map<string, { spend: number; totalTokens: number; requests: number }>();
  for (const record of records) {
    const breakdown = isRecord(record.breakdown) ? record.breakdown : {};
    const models = dailyModelBreakdown(breakdown);
    for (const [model, value] of Object.entries(models)) {
      if (!isRecord(value)) continue;
      const metrics = isRecord(value.metrics) ? value.metrics : {};
      const current = totals.get(model) ?? { spend: 0, totalTokens: 0, requests: 0 };
      current.spend += numberField(metrics, "spend") ?? 0;
      current.totalTokens += numberField(metrics, "total_tokens") ?? numberField(metrics, "totalTokens") ?? 0;
      current.requests += numberField(metrics, "api_requests") ?? numberField(metrics, "apiRequests") ?? 0;
      totals.set(model, current);
    }
  }

  return [...totals.entries()]
    .map(([model, value]) => ({
      model,
      spend: roundCurrency(value.spend),
      totalTokens: value.totalTokens,
      requests: value.requests,
    }))
    .sort((left, right) => right.spend - left.spend || right.totalTokens - left.totalTokens)
    .slice(0, 6);
}

function dailyModelBreakdown(breakdown: Record<string, unknown>): Record<string, unknown> {
  const models = isRecord(breakdown.models) ? breakdown.models : {};
  if (Object.keys(models).length > 0) {
    return models;
  }
  return isRecord(breakdown.model_groups) ? breakdown.model_groups : {};
}

function emptyDailyActivity(startDate: string, endDate: string): LiteLLMUsageAnalytics {
  return {
    available: false,
    startDate,
    endDate,
    totalSpend: 0,
    totalTokens: 0,
    requestCount: 0,
    successfulRequests: 0,
    failedRequests: 0,
    days: [],
    topModels: [],
  };
}
