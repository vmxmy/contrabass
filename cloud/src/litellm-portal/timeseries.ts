import type { JsonValue, LiteLLMModelUsage, LiteLLMPortalEnv, UsageBucket, UsageGrain, UsageTimeseries, UsageTotals, UsageWindowOption } from "./types";
import { isRecord, roundCurrency, sumNumbers } from "./utils";
import { extractRecords, firstString, litellmDateTime, litellmFetch, numberLikeField } from "./litellm";
import { readJson } from "./utils";
import { readUserDailyActivityRange } from "./usage";

export const USAGE_TIMEZONE = "Asia/Shanghai";
const USAGE_TIMEZONE_OFFSET_MINUTES = 8 * 60;
const USAGE_TIMEZONE_OFFSET_MS = USAGE_TIMEZONE_OFFSET_MINUTES * 60 * 1000;
const USAGE_TIMEZONE_OFFSET_SUFFIX = "+08:00";
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
export const SPEND_LOGS_PAGE_SIZE = 100;
export const SPEND_LOGS_MAX_PAGES = 10;
export const USAGE_GRAINS = ["minute", "hour", "day", "month"] as const;
export const USAGE_WINDOWS: Record<UsageGrain, UsageWindowOption[]> = {
  minute: [
    { key: "1h", label: "近 1 小时", hours: 1 },
    { key: "6h", label: "近 6 小时", hours: 6 },
    { key: "24h", label: "近 24 小时", hours: 24 },
  ],
  hour: [
    { key: "24h", label: "近 24 小时", hours: 24 },
    { key: "48h", label: "近 48 小时", hours: 48 },
    { key: "7d", label: "近 7 天", days: 7 },
  ],
  day: [
    { key: "7d", label: "近 7 天", days: 7 },
    { key: "30d", label: "近 30 天", days: 30 },
    { key: "90d", label: "近 90 天", days: 90 },
  ],
  month: [
    { key: "6mo", label: "近 6 个月", months: 6 },
    { key: "12mo", label: "近 12 个月", months: 12 },
  ],
};
export const DEFAULT_USAGE_WINDOWS: Record<UsageGrain, string> = {
  minute: "6h",
  hour: "48h",
  day: "30d",
  month: "12mo",
};

export function parseUsageTimeseriesRequest(
  url: URL,
): { ok: true; grain: UsageGrain; window: UsageWindowOption } | { ok: false; body: Record<string, JsonValue> } {
  const rawGrain = url.searchParams.get("grain") ?? "day";
  if (!isUsageGrain(rawGrain)) {
    return {
      ok: false,
      body: {
        error: "unsupported_usage_grain",
        allowedGrains: [...USAGE_GRAINS],
      },
    };
  }

  const rawWindow = url.searchParams.get("window") ?? DEFAULT_USAGE_WINDOWS[rawGrain];
  const window = USAGE_WINDOWS[rawGrain].find((option) => option.key === rawWindow);
  if (window === undefined) {
    return {
      ok: false,
      body: {
        error: "unsupported_usage_window",
        allowedWindows: USAGE_WINDOWS[rawGrain].map((option) => option.key),
      },
    };
  }

  return { ok: true, grain: rawGrain, window };
}

export async function readUsageTimeseries(
  env: LiteLLMPortalEnv,
  userId: string,
  grain: UsageGrain,
  window: UsageWindowOption,
): Promise<Record<string, JsonValue>> {
  const timeseries = grain === "minute" || grain === "hour"
    ? await readSpendLogsTimeseries(env, userId, grain, window)
    : await readDailyActivityTimeseries(env, userId, grain, window);
  return {
    ...timeseries,
    totals: publicUsageTotals(timeseries.totals),
    buckets: timeseries.buckets.map(publicUsageBucket),
    topModels: timeseries.topModels.map(publicUsageModel),
  };
}

async function readSpendLogsTimeseries(
  env: LiteLLMPortalEnv,
  userId: string,
  grain: "minute" | "hour",
  window: UsageWindowOption,
): Promise<UsageTimeseries> {
  const now = new Date();
  const end = new Date(now.getTime());
  const start = alignBucketStart(new Date(end.getTime() - windowToMilliseconds(window)), grain);
  const bucketMap = createBucketMap(grain, start, end);
  const modelTotals = new Map<string, { spend: number; totalTokens: number; requests: number }>();
  let limited = false;

  for (let page = 1; page <= SPEND_LOGS_MAX_PAGES; page += 1) {
    const params = new URLSearchParams({
      user_id: userId,
      start_date: litellmDateTime(start),
      end_date: litellmDateTime(end),
      page: String(page),
      page_size: String(SPEND_LOGS_PAGE_SIZE),
      sort_by: "startTime",
      sort_order: "asc",
    });
    const response = await litellmFetch(env, `/spend/logs/v2?${params.toString()}`);
    const body = await readJson(response);
    const records = extractSpendLogRecords(body);

    for (const record of records) {
      const startedAt = spendLogDateField(record, ["startTime", "start_time", "timestamp", "created_at", "createdAt"]);
      if (startedAt === undefined || startedAt < start || startedAt > end) {
        continue;
      }
      const bucket = bucketMap.get(alignBucketStart(startedAt, grain).toISOString());
      if (bucket !== undefined) {
        addSpendLogRecordToBucket(bucket, record);
        addSpendLogRecordToModelTotals(modelTotals, record);
      }
    }

    const totalPages = isRecord(body)
      ? numberLikeField(body, "total_pages") ?? numberLikeField(body, "totalPages") ?? numberLikeField(body, "pages")
      : undefined;
    if (totalPages !== undefined) {
      if (page >= totalPages) {
        break;
      }
      if (page === SPEND_LOGS_MAX_PAGES && totalPages > SPEND_LOGS_MAX_PAGES) {
        limited = true;
      }
      continue;
    }
    if (records.length < SPEND_LOGS_PAGE_SIZE) {
      break;
    }
    if (page === SPEND_LOGS_MAX_PAGES) {
      limited = true;
    }
  }

  const buckets = finalizeUsageBuckets([...bucketMap.values()]);
  return {
    available: true,
    grain,
    window: window.key,
    windowLabel: window.label,
    start: formatUsageDateTime(start),
    end: formatUsageDateTime(end),
    source: "spend_logs_v2",
    timezone: USAGE_TIMEZONE,
    limited,
    maxPages: SPEND_LOGS_MAX_PAGES,
    buckets,
    totals: usageTotals(buckets),
    topModels: topModelsFromTotals(modelTotals),
  };
}

async function readDailyActivityTimeseries(
  env: LiteLLMPortalEnv,
  userId: string,
  grain: "day" | "month",
  window: UsageWindowOption,
): Promise<UsageTimeseries> {
  const range = dailyWindowRange(grain, window, new Date());
  const bucketMap = createBucketMap(
    grain,
    parseDateOnly(range.startDate),
    parseDateOnly(range.endDate),
  );
  const activity = await readUserDailyActivityRange(env, userId, range.startDate, range.endDate, range.pageSize);

  for (const day of activity.days) {
    const dayStart = parseDateOnly(day.date);
    const bucket = bucketMap.get(alignBucketStart(dayStart, grain).toISOString());
    if (bucket !== undefined) {
      addUsageToBucket(bucket, {
        totalTokens: day.totalTokens,
        promptTokens: day.promptTokens,
        completionTokens: day.completionTokens,
        requests: day.requests,
        spend: day.spend,
      });
    }
  }

  const buckets = finalizeUsageBuckets([...bucketMap.values()]);
  return {
    available: activity.available,
    grain,
    window: window.key,
    windowLabel: window.label,
    start: formatUsageDateTime(parseDateOnly(range.startDate)),
    end: formatUsageDateTime(new Date(parseDateOnly(range.endDate).getTime() + DAY_MS - 1)),
    source: "user_daily_activity",
    timezone: USAGE_TIMEZONE,
    limited: false,
    maxPages: null,
    buckets,
    totals: usageTotals(buckets),
    topModels: activity.topModels,
  };
}

function windowToMilliseconds(window: UsageWindowOption): number {
  if (window.hours !== undefined) return window.hours * HOUR_MS;
  if (window.days !== undefined) return window.days * DAY_MS;
  return (window.months ?? 1) * 31 * DAY_MS;
}

function dailyWindowRange(
  grain: "day" | "month",
  window: UsageWindowOption,
  now: Date,
): { startDate: string; endDate: string; pageSize: number } {
  const today = startOfUsageDay(now);
  const endDate = usageDateOnly(today);
  if (grain === "month") {
    const monthCount = window.months ?? 12;
    const todayParts = usageDateParts(today);
    const start = fromUsageDateParts(todayParts.year, todayParts.month - monthCount + 1, 1);
    return {
      startDate: usageDateOnly(start),
      endDate,
      pageSize: daysBetween(start, today) + 1,
    };
  }

  const dayCount = window.days ?? 30;
  const start = addUsageDays(today, -(dayCount - 1));
  return {
    startDate: usageDateOnly(start),
    endDate,
    pageSize: dayCount,
  };
}

function createBucketMap(grain: UsageGrain, start: Date, end: Date): Map<string, UsageBucket> {
  const buckets = new Map<string, UsageBucket>();
  let cursor = alignBucketStart(start, grain);
  const last = alignBucketStart(end, grain);
  while (cursor <= last) {
    const next = addGrain(cursor, grain);
    const key = cursor.toISOString();
    buckets.set(key, {
      start: formatUsageDateTime(cursor),
      end: formatUsageDateTime(next),
      label: bucketLabel(cursor, grain),
      totalTokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      requests: 0,
      spend: 0,
    });
    cursor = next;
  }
  return buckets;
}

function alignBucketStart(date: Date, grain: UsageGrain): Date {
  const parts = usageDateParts(date);
  if (grain === "month") {
    return fromUsageDateParts(parts.year, parts.month, 1);
  }
  if (grain === "day") {
    return startOfUsageDay(date);
  }
  if (grain === "hour") {
    return fromUsageDateParts(parts.year, parts.month, parts.day, parts.hour);
  }
  return fromUsageDateParts(parts.year, parts.month, parts.day, parts.hour, parts.minute);
}

function addGrain(date: Date, grain: UsageGrain): Date {
  const parts = usageDateParts(date);
  if (grain === "minute") {
    return fromUsageDateParts(parts.year, parts.month, parts.day, parts.hour, parts.minute + 1);
  }
  if (grain === "hour") {
    return fromUsageDateParts(parts.year, parts.month, parts.day, parts.hour + 1);
  }
  if (grain === "day") {
    return fromUsageDateParts(parts.year, parts.month, parts.day + 1);
  }
  return fromUsageDateParts(parts.year, parts.month + 1, 1);
}

function addUsageToBucket(bucket: UsageBucket, usage: UsageTotals): void {
  bucket.totalTokens += usage.totalTokens;
  bucket.promptTokens += usage.promptTokens;
  bucket.completionTokens += usage.completionTokens;
  bucket.requests += usage.requests;
  bucket.spend += usage.spend;
}

function addSpendLogRecordToBucket(bucket: UsageBucket, record: Record<string, unknown>): void {
  const promptTokens = numberLikeField(record, "prompt_tokens") ?? numberLikeField(record, "promptTokens") ?? 0;
  const completionTokens = numberLikeField(record, "completion_tokens") ?? numberLikeField(record, "completionTokens") ?? 0;
  const totalTokens = numberLikeField(record, "total_tokens")
    ?? numberLikeField(record, "totalTokens")
    ?? promptTokens + completionTokens;
  addUsageToBucket(bucket, {
    totalTokens,
    promptTokens,
    completionTokens,
    requests: numberLikeField(record, "api_requests") ?? numberLikeField(record, "request_count") ?? 1,
    spend: numberLikeField(record, "spend") ?? numberLikeField(record, "cost") ?? 0,
  });
}

function addSpendLogRecordToModelTotals(
  totals: Map<string, { spend: number; totalTokens: number; requests: number }>,
  record: Record<string, unknown>,
): void {
  const model = firstString(record, ["model", "model_name", "modelName", "model_id", "modelGroup", "model_group"]);
  if (model === undefined) {
    return;
  }
  const promptTokens = numberLikeField(record, "prompt_tokens") ?? numberLikeField(record, "promptTokens") ?? 0;
  const completionTokens = numberLikeField(record, "completion_tokens") ?? numberLikeField(record, "completionTokens") ?? 0;
  const totalTokens = numberLikeField(record, "total_tokens")
    ?? numberLikeField(record, "totalTokens")
    ?? promptTokens + completionTokens;
  const current = totals.get(model) ?? { spend: 0, totalTokens: 0, requests: 0 };
  current.spend += numberLikeField(record, "spend") ?? numberLikeField(record, "cost") ?? 0;
  current.totalTokens += totalTokens;
  current.requests += numberLikeField(record, "api_requests") ?? numberLikeField(record, "request_count") ?? 1;
  totals.set(model, current);
}

function finalizeUsageBuckets(buckets: UsageBucket[]): UsageBucket[] {
  return buckets.map((bucket) => ({
    ...bucket,
    spend: roundCurrency(bucket.spend),
  }));
}

function usageTotals(buckets: UsageBucket[]): UsageTotals {
  return {
    totalTokens: sumNumbers(buckets.map((bucket) => bucket.totalTokens)),
    promptTokens: sumNumbers(buckets.map((bucket) => bucket.promptTokens)),
    completionTokens: sumNumbers(buckets.map((bucket) => bucket.completionTokens)),
    requests: sumNumbers(buckets.map((bucket) => bucket.requests)),
    spend: roundCurrency(sumNumbers(buckets.map((bucket) => bucket.spend))),
  };
}

function publicUsageBucket(bucket: UsageBucket): Record<string, JsonValue> {
  return {
    start: bucket.start,
    end: bucket.end,
    label: bucket.label,
    totalTokens: bucket.totalTokens,
    promptTokens: bucket.promptTokens,
    completionTokens: bucket.completionTokens,
    requests: bucket.requests,
    spend: bucket.spend,
  };
}

function publicUsageTotals(totals: UsageTotals): Record<string, JsonValue> {
  return {
    totalTokens: totals.totalTokens,
    promptTokens: totals.promptTokens,
    completionTokens: totals.completionTokens,
    requests: totals.requests,
    spend: totals.spend,
  };
}

function publicUsageModel(model: LiteLLMModelUsage): Record<string, JsonValue> {
  return {
    model: model.model,
    spend: model.spend,
    totalTokens: model.totalTokens,
    requests: model.requests,
  };
}

function topModelsFromTotals(totals: Map<string, { spend: number; totalTokens: number; requests: number }>): LiteLLMModelUsage[] {
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

function extractSpendLogRecords(value: unknown): Array<Record<string, unknown>> {
  if (!isRecord(value)) {
    return Array.isArray(value) ? value.filter(isRecord) : [];
  }
  for (const key of ["data", "results", "logs", "spend_logs"]) {
    const nested = value[key];
    if (Array.isArray(nested)) {
      return nested.filter(isRecord);
    }
  }
  return [];
}

function bucketLabel(date: Date, grain: UsageGrain): string {
  const parts = usageDateParts(date);
  const monthDay = `${pad(parts.month + 1)}-${pad(parts.day)}`;
  if (grain === "minute") return `${pad(parts.hour)}:${pad(parts.minute)}`;
  if (grain === "hour") return `${monthDay} ${pad(parts.hour)}:00`;
  if (grain === "day") return monthDay;
  return `${parts.year}-${pad(parts.month + 1)}`;
}

function parseDateOnly(value: string): Date {
  const [year, month, day] = value.split("-").map((part) => Number(part));
  return fromUsageDateParts(year, month - 1, day);
}

function spendLogDateField(record: Record<string, unknown>, keys: string[]): Date | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      const date = new Date(value < 10_000_000_000 ? value * 1000 : value);
      if (!Number.isNaN(date.getTime())) {
        return date;
      }
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const date = parseLiteLLMUtcDateTime(value);
      if (date !== undefined) {
        return date;
      }
    }
  }
  return undefined;
}

function parseLiteLLMUtcDateTime(value: string): Date | undefined {
  const trimmed = value.trim();
  const withTimeSeparator = trimmed.includes("T") ? trimmed : trimmed.replace(" ", "T");
  const hasTimezone = /(?:[zZ]|[+-]\d{2}:?\d{2})$/u.test(withTimeSeparator);
  const normalized = hasTimezone
    ? withTimeSeparator
    : /^\d{4}-\d{2}-\d{2}$/u.test(withTimeSeparator)
      ? `${withTimeSeparator}T00:00:00.000Z`
      : `${withTimeSeparator}Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function formatUsageDateTime(date: Date): string {
  const parts = usageDateParts(date);
  return `${parts.year}-${pad(parts.month + 1)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}.${pad(parts.millisecond, 3)}${USAGE_TIMEZONE_OFFSET_SUFFIX}`;
}

function usageDateOnly(date: Date): string {
  const parts = usageDateParts(date);
  return `${parts.year}-${pad(parts.month + 1)}-${pad(parts.day)}`;
}

function usageDateParts(date: Date): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
} {
  const usageClock = new Date(date.getTime() + USAGE_TIMEZONE_OFFSET_MS);
  return {
    year: usageClock.getUTCFullYear(),
    month: usageClock.getUTCMonth(),
    day: usageClock.getUTCDate(),
    hour: usageClock.getUTCHours(),
    minute: usageClock.getUTCMinutes(),
    second: usageClock.getUTCSeconds(),
    millisecond: usageClock.getUTCMilliseconds(),
  };
}

function fromUsageDateParts(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  millisecond = 0,
): Date {
  return new Date(Date.UTC(year, month, day, hour, minute, second, millisecond) - USAGE_TIMEZONE_OFFSET_MS);
}

function startOfUsageDay(date: Date): Date {
  const parts = usageDateParts(date);
  return fromUsageDateParts(parts.year, parts.month, parts.day);
}

function addUsageDays(date: Date, days: number): Date {
  const parts = usageDateParts(date);
  return fromUsageDateParts(parts.year, parts.month, parts.day + days);
}

function daysBetween(start: Date, end: Date): number {
  return Math.floor((startOfUsageDay(end).getTime() - startOfUsageDay(start).getTime()) / DAY_MS);
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, "0");
}

function isUsageGrain(value: string): value is UsageGrain {
  return (USAGE_GRAINS as readonly string[]).includes(value);
}
