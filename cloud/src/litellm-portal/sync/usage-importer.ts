import type { LiteLLMPortalEnv } from "../types";
import type { UsageDO } from "../durable/usage-do";
import type { SpendEventInput, DailyRow } from "../durable/usage-schemas";
import { litellmFetch, firstString, numberLikeField, litellmDateTime } from "../litellm";
import { readJson, isRecord } from "../utils";

const PAGE_SIZE = 100;
const MAX_PAGES = 20;
const LOOKBACK_MS = 5 * 60 * 1000;
// Must stay == UsageDO.EVENT_RETENTION_MS (30d): backfill window matches event retention.
const BACKFILL_MS = 30 * 86400000;

// Sentinel version for the one-time user_id/team_id mapping migration.
// Increment this to force a re-backfill of the 30d spend_logs window.
// v3: metadata-as-JSON-string fix — re-pull 30d so `""`-userId rows that were
// caused by `metadata` arriving as a serialized string get corrected in place.
const SPEND_LOGS_MAPPING_VERSION = 3;
const SPEND_LOGS_MAPPING_SOURCE = "spend_logs_userid_mapping_v";

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

/**
 * Return `record.metadata` as a record. LiteLLM `/spend/logs/v2` serializes the
 * `SpendLogs.metadata` JSONB column as a JSON-encoded *string* for most key-auth
 * traffic, but older/other shapes pass it as an object. Tolerate both; return
 * undefined for anything else (including unparseable strings).
 */
function metadataRecord(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const meta = record.metadata;
  if (isRecord(meta)) return meta;
  if (typeof meta === "string" && meta.trim().length > 0) {
    try {
      const parsed: unknown = JSON.parse(meta);
      return isRecord(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Safely read a trimmed non-empty string value from `record.metadata[key]`,
 * tolerating `metadata` being either an object or a JSON-encoded string.
 */
function metadataString(record: Record<string, unknown>, key: string): string | undefined {
  const meta = metadataRecord(record);
  if (meta === undefined) return undefined;
  const v = meta[key];
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

/**
 * Resolve the per-request user id from a LiteLLM /spend/logs/v2 record.
 * Primary: metadata.user_api_key_user_id (canonical LiteLLM field).
 * Fallback: top-level user, user_id, userId, end_user (legacy/other shapes).
 */
function resolveUserId(record: Record<string, unknown>): string {
  return (
    metadataString(record, "user_api_key_user_id") ??
    firstString(record, ["user", "user_id", "userId", "end_user"]) ??
    ""
  );
}

/**
 * Resolve the per-request team id from a LiteLLM /spend/logs/v2 record.
 * Primary: metadata.user_api_key_team_id (canonical LiteLLM field).
 * Fallback: top-level team_id, teamId (legacy/other shapes).
 */
function resolveTeamId(record: Record<string, unknown>): string {
  return (
    metadataString(record, "user_api_key_team_id") ??
    firstString(record, ["team_id", "teamId"]) ??
    ""
  );
}

function toSpendEvent(record: Record<string, unknown>): SpendEventInput | null {
  const tsMs = parseEventDate(record);
  if (tsMs === undefined) return null;
  const userId = resolveUserId(record);
  // Synthetic fallback is lossy by design: two requests in the same ms+user+model dedupe to one (ON CONFLICT DO UPDATE). LiteLLM virtually always supplies request_id.
  const requestId =
    firstString(record, ["request_id", "requestId", "id", "log_id"]) ??
    `${tsMs}:${userId}:${firstString(record, ["model", "model_name"]) ?? ""}`;
  const prompt = numberLikeField(record, "prompt_tokens") ?? numberLikeField(record, "promptTokens") ?? 0;
  const completion = numberLikeField(record, "completion_tokens") ?? numberLikeField(record, "completionTokens") ?? 0;
  const total =
    numberLikeField(record, "total_tokens") ?? numberLikeField(record, "totalTokens") ?? prompt + completion;
  return {
    requestId,
    tsMs,
    userId,
    teamId: resolveTeamId(record),
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

  // One-time migration: if the user_id mapping version sentinel is absent or stale,
  // reset the spend_logs cursor so the next pull re-backfills the full 30d window.
  // The DO-UPDATE upsert in writeSpendEvents corrects existing rows in place.
  // Runs exactly once per DO instance (idempotent: sentinel written atomically).
  const mappingVersion = await stub.getSyncCursor(SPEND_LOGS_MAPPING_SOURCE);
  if (mappingVersion === null || mappingVersion < SPEND_LOGS_MAPPING_VERSION) {
    await stub.resetSpendLogsCursorForMappingMigration(SPEND_LOGS_MAPPING_VERSION);
  }

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
      const events: SpendEventInput[] = [];
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

// LiteLLM daily-activity is requested with timezone=-480 so LiteLLM buckets
// each `date` by Asia/Shanghai (UTC+8). cb_usage_daily.date is therefore a
// true Shanghai business date — matches queryKpiWithDelta's shDate() bounds.
const DAILY_TZ_OFFSET_MINUTES = "-480";
const DAILY_BACKFILL_DAYS = 365;
const DAILY_REFRESH_DAYS = 3; // trailing window each tick to absorb late data
const DAILY_MAX_PAGES = 60;
const DAILY_TZ_MS = 8 * 60 * 60 * 1000;

function shanghaiDate(ms: number): string {
  return new Date(ms + DAILY_TZ_MS).toISOString().slice(0, 10);
}

/** SpendMetrics → DailyRow numeric fields (shared by per-model + __all__). */
function metricsToRow(date: string, model: string, m: Record<string, unknown>): DailyRow {
  const succ = numberLikeField(m, "successful_requests");
  const fail = numberLikeField(m, "failed_requests");
  return {
    date,
    userId: "__global__",
    model,
    spend: numberLikeField(m, "spend") ?? 0,
    totalTokens: Math.trunc(numberLikeField(m, "total_tokens") ?? 0),
    promptTokens: Math.trunc(numberLikeField(m, "prompt_tokens") ?? 0),
    completionTokens: Math.trunc(numberLikeField(m, "completion_tokens") ?? 0),
    requests: Math.trunc(numberLikeField(m, "api_requests") ?? 0),
    successRequests: succ != null ? Math.trunc(succ) : null,
    failedRequests: fail != null ? Math.trunc(fail) : null,
  };
}

export async function refreshDailyActivity(env: LiteLLMPortalEnv): Promise<IngestResult> {
  const stub = usageStub(env);
  if (stub === null) return { ingested: 0, error: "USAGE_DO binding not configured" };

  // Cursor presence = "365d backfill already done". null → backfill 365d;
  // otherwise just refresh a short trailing window each tick.
  const priorCursor = await stub.getSyncCursor("daily_activity");
  const now = Date.now();
  const spanDays = priorCursor === null ? DAILY_BACKFILL_DAYS : DAILY_REFRESH_DAYS;
  const startDate = shanghaiDate(now - spanDays * 86400000);
  const endDate = shanghaiDate(now);

  let ingested = 0;
  try {
    for (let page = 1; page <= DAILY_MAX_PAGES; page += 1) {
      const params = new URLSearchParams({
        start_date: startDate,
        end_date: endDate,
        timezone: DAILY_TZ_OFFSET_MINUTES,
        page: String(page),
        page_size: "1000",
      });
      const response = await litellmFetch(env, `/user/daily/activity/aggregated?${params.toString()}`);
      const body = await readJson(response);
      const rows: DailyRow[] = [];
      for (const day of dailyResults(body)) {
        const date = firstString(day, ["date"]);
        if (date === undefined) continue;
        const dayMetrics = isRecord(day.metrics) ? day.metrics : {};
        const breakdown = isRecord(day.breakdown) ? day.breakdown : {};
        const models = isRecord(breakdown.models)
          ? breakdown.models
          : isRecord(breakdown.model_groups)
            ? breakdown.model_groups
            : {};
        for (const [model, entry] of Object.entries(models)) {
          if (!isRecord(entry)) continue;
          const em = isRecord(entry.metrics) ? entry.metrics : {};
          rows.push(metricsToRow(date, model, em));
        }
        // Synthetic per-day total row (model='__all__') from day.metrics —
        // SpendMetrics carries per-day successful_requests/failed_requests.
        rows.push(metricsToRow(date, "__all__", dayMetrics));
      }
      if (rows.length > 0) {
        await stub.upsertDailyRows(rows);
        ingested += rows.length;
      }
      // DailySpendMetadata on the response carries pagination.
      const meta = isRecord(body) && isRecord(body.metadata) ? body.metadata : {};
      const totalPages = numberLikeField(meta, "total_pages");
      const hasMore = meta.has_more === true;
      if (totalPages !== undefined) {
        if (page >= totalPages) break;
      } else if (!hasMore) {
        break;
      }
    }
    await stub.setSyncCursor("daily_activity", { cursorMs: now, lastError: null });
    return { ingested, error: null };
  } catch (err) {
    const reason = err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
    // Only record the cursor/error if a prior cursor exists. If priorCursor is
    // null (365d backfill never completed), DON'T write one — a non-null value
    // would falsely flag "backfill done" and the 365d backfill would be skipped
    // forever. Leaving it null makes the next tick retry the full backfill.
    if (priorCursor !== null) {
      await stub.setSyncCursor("daily_activity", { cursorMs: priorCursor, lastError: reason });
    }
    return { ingested, error: reason };
  }
}

export async function pruneUsageRetention(env: LiteLLMPortalEnv): Promise<{ ok: boolean }> {
  const stub = usageStub(env);
  if (stub === null) return { ok: false };
  await stub.pruneRetention(Date.now());
  return { ok: true };
}
