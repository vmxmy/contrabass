import type { LiteLLMPortalEnv } from "../types";
import type { UsageDO } from "../durable/usage-do";
import type { SpendEvent, DailyRow } from "../durable/usage-schemas";
import { litellmFetch, firstString, numberLikeField, litellmDateTime } from "../litellm";
import { readJson, isRecord } from "../utils";

const PAGE_SIZE = 100;
const MAX_PAGES = 20;
const LOOKBACK_MS = 5 * 60 * 1000;
// Must stay == UsageDO.EVENT_RETENTION_MS (30d): backfill window matches event retention.
const BACKFILL_MS = 30 * 86400000;

export type IngestResult = { ingested: number; error: string | null };

function usageStub(env: LiteLLMPortalEnv): UsageDO | null {
  if (!env.USAGE_DO) return null;
  return env.USAGE_DO.get(env.USAGE_DO.idFromName("usage")) as unknown as UsageDO;
}

function parseEventDate(record: Record<string, unknown>): number | undefined {
  for (const key of ["startTime", "start_time", "timestamp", "created_at", "createdAt"]) {
    const v = record[key];
    if (typeof v === "number" && Number.isFinite(v)) {
      return v < 10_000_000_000 ? v * 1000 : v;
    }
    if (typeof v === "string" && v.trim().length > 0) {
      const norm = v.includes("T") ? v : v.replace(" ", "T");
      // Match timeseries.ts: bare YYYY-MM-DD → UTC midnight; otherwise append Z if no tz.
      const withTz = /(?:[zZ]|[+-]\d{2}:?\d{2})$/u.test(norm)
        ? norm
        : /^\d{4}-\d{2}-\d{2}$/u.test(norm)
          ? `${norm}T00:00:00.000Z`
          : `${norm}Z`;
      const t = Date.parse(withTz);
      if (!Number.isNaN(t)) return t;
    }
  }
  return undefined;
}

function toSpendEvent(record: Record<string, unknown>): SpendEvent | null {
  const tsMs = parseEventDate(record);
  if (tsMs === undefined) return null;
  // Synthetic fallback is lossy by design: two requests in the same ms+user+model dedupe to one (ON CONFLICT DO NOTHING). LiteLLM virtually always supplies request_id.
  const requestId =
    firstString(record, ["request_id", "requestId", "id", "log_id"]) ??
    `${tsMs}:${firstString(record, ["user_id", "userId"]) ?? ""}:${firstString(record, ["model", "model_name"]) ?? ""}`;
  const prompt = numberLikeField(record, "prompt_tokens") ?? numberLikeField(record, "promptTokens") ?? 0;
  const completion = numberLikeField(record, "completion_tokens") ?? numberLikeField(record, "completionTokens") ?? 0;
  const total =
    numberLikeField(record, "total_tokens") ?? numberLikeField(record, "totalTokens") ?? prompt + completion;
  return {
    requestId,
    tsMs,
    userId: firstString(record, ["user_id", "userId"]) ?? "",
    teamId: firstString(record, ["team_id", "teamId"]) ?? "",
    model: firstString(record, ["model", "model_name", "modelName", "model_id", "modelGroup", "model_group"]) ?? "",
    promptTokens: Math.max(0, Math.trunc(prompt)),
    completionTokens: Math.max(0, Math.trunc(completion)),
    totalTokens: Math.max(0, Math.trunc(total)),
    spend: Math.max(0, numberLikeField(record, "spend") ?? numberLikeField(record, "cost") ?? 0),
  };
}

function extractRows(body: unknown): Array<Record<string, unknown>> {
  if (!isRecord(body)) return Array.isArray(body) ? body.filter(isRecord) : [];
  for (const key of ["data", "results", "logs", "spend_logs"]) {
    const nested = body[key];
    if (Array.isArray(nested)) return nested.filter(isRecord);
  }
  return [];
}

export async function ingestSpendLogs(env: LiteLLMPortalEnv): Promise<IngestResult> {
  const stub = usageStub(env);
  if (stub === null) return { ingested: 0, error: "USAGE_DO binding not configured" };

  const now = Date.now();
  const cursor = await stub.getSyncCursor("spend_logs");
  const startMs = cursor === null ? now - BACKFILL_MS : cursor - LOOKBACK_MS;
  const start = new Date(startMs);
  const end = new Date(now);

  let ingested = 0;
  let maxTs = cursor ?? startMs;
  try {
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const params = new URLSearchParams({
        start_date: litellmDateTime(start),
        end_date: litellmDateTime(end),
        page: String(page),
        page_size: String(PAGE_SIZE),
        sort_by: "startTime",
        sort_order: "asc",
      });
      const response = await litellmFetch(env, `/spend/logs/v2?${params.toString()}`);
      const body = await readJson(response);
      const rows = extractRows(body);
      const events: SpendEvent[] = [];
      for (const row of rows) {
        const e = toSpendEvent(row);
        if (e !== null) {
          events.push(e);
          if (e.tsMs > maxTs) maxTs = e.tsMs;
        }
      }
      if (events.length > 0) {
        await stub.writeSpendEvents(events);
        ingested += events.length;
      }
      const totalPages = isRecord(body)
        ? (numberLikeField(body, "total_pages") ??
          numberLikeField(body, "totalPages") ??
          numberLikeField(body, "pages"))
        : undefined;
      if (totalPages !== undefined) {
        if (page >= totalPages) break;
      } else if (rows.length < PAGE_SIZE) {
        break;
      }
    }
    await stub.setSyncCursor("spend_logs", { cursorMs: maxTs, lastError: null });
    return { ingested, error: null };
  } catch (err) {
    const reason = err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
    await stub.setSyncCursor("spend_logs", { cursorMs: cursor ?? startMs, lastError: reason });
    return { ingested, error: reason };
  }
}

function dailyResults(body: unknown): Array<Record<string, unknown>> {
  if (!isRecord(body)) return [];
  for (const key of ["results", "data", "days"]) {
    const nested = body[key];
    if (Array.isArray(nested)) return nested.filter(isRecord);
  }
  return [];
}

export async function refreshDailyActivity(env: LiteLLMPortalEnv): Promise<IngestResult> {
  const stub = usageStub(env);
  if (stub === null) return { ingested: 0, error: "USAGE_DO binding not configured" };

  const now = new Date();
  const yesterday = new Date(now.getTime() - 86400000);
  const startDate = yesterday.toISOString().slice(0, 10);
  const endDate = now.toISOString().slice(0, 10);

  try {
    const params = new URLSearchParams({
      start_date: startDate,
      end_date: endDate,
      page: "1",
      page_size: "1000",
    });
    const response = await litellmFetch(env, `/user/daily/activity/aggregated?${params.toString()}`);
    const body = await readJson(response);
    const rows: DailyRow[] = [];
    for (const day of dailyResults(body)) {
      const date = firstString(day, ["date"]);
      if (date === undefined) continue;
      const metrics = isRecord(day.metrics) ? day.metrics : {};
      const metadata = isRecord(day.metadata) ? day.metadata : {};
      const breakdown = isRecord(day.breakdown) && isRecord(day.breakdown.models) ? day.breakdown.models : {};
      for (const [model, raw] of Object.entries(breakdown)) {
        if (!isRecord(raw)) continue;
        rows.push({
          date,
          userId: "__global__",
          model,
          spend: numberLikeField(raw, "spend") ?? 0,
          totalTokens: Math.trunc(numberLikeField(raw, "total_tokens") ?? 0),
          promptTokens: Math.trunc(numberLikeField(raw, "prompt_tokens") ?? 0),
          completionTokens: Math.trunc(numberLikeField(raw, "completion_tokens") ?? 0),
          requests: Math.trunc(numberLikeField(raw, "api_requests") ?? 0),
          successRequests: null,
          failedRequests: null,
        });
      }
      rows.push({
        date,
        userId: "__global__",
        model: "__all__",
        spend: numberLikeField(metrics, "spend") ?? 0,
        totalTokens: Math.trunc(numberLikeField(metrics, "total_tokens") ?? 0),
        promptTokens: Math.trunc(numberLikeField(metrics, "prompt_tokens") ?? 0),
        completionTokens: Math.trunc(numberLikeField(metrics, "completion_tokens") ?? 0),
        requests: Math.trunc(numberLikeField(metrics, "api_requests") ?? 0),
        successRequests:
          numberLikeField(metadata, "total_successful_requests") != null
            ? Math.trunc(numberLikeField(metadata, "total_successful_requests")!)
            : null,
        failedRequests:
          numberLikeField(metadata, "total_failed_requests") != null
            ? Math.trunc(numberLikeField(metadata, "total_failed_requests")!)
            : null,
      });
    }
    if (rows.length > 0) await stub.upsertDailyRows(rows);
    await stub.setSyncCursor("daily_activity", { cursorMs: now.getTime(), lastError: null });
    return { ingested: rows.length, error: null };
  } catch (err) {
    const reason = err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
    await stub.setSyncCursor("daily_activity", { cursorMs: 0, lastError: reason });
    return { ingested: 0, error: reason };
  }
}

export async function pruneUsageRetention(env: LiteLLMPortalEnv): Promise<{ ok: boolean }> {
  const stub = usageStub(env);
  if (stub === null) return { ok: false };
  await stub.pruneRetention(Date.now());
  return { ok: true };
}
