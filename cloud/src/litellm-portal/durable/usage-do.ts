import { DurableObject } from "cloudflare:workers";
import type { LiteLLMPortalEnv } from "../types";
import { SpendEventSchema, type SpendEvent, DailyRowSchema, type DailyRow } from "./usage-schemas";

type SqlRow = Record<string, SqlStorageValue>;
type SqlCapableStorage = DurableObjectStorage & { sql?: SqlStorage };

function firstRow<T extends SqlRow>(cursor: SqlStorageCursor<T>): T | undefined {
  return cursor.toArray()[0];
}

export class UsageDO extends DurableObject<LiteLLMPortalEnv> {
  private sqlReady: Promise<SqlStorage | null> | null = null;

  private async sql(): Promise<SqlStorage | null> {
    if (this.sqlReady === null) {
      this.sqlReady = this.initializeSql();
    }
    return this.sqlReady;
  }

  private async initializeSql(): Promise<SqlStorage | null> {
    const sql = (this.ctx.storage as SqlCapableStorage).sql;
    if (sql == null || typeof sql.exec !== "function") return null;

    sql.exec(`
      CREATE TABLE IF NOT EXISTS cb_usage_events (
        request_id TEXT PRIMARY KEY,
        ts_ms INTEGER NOT NULL,
        user_id TEXT NOT NULL DEFAULT '',
        team_id TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        spend REAL NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS cb_usage_events_ts_idx ON cb_usage_events (ts_ms);
      CREATE INDEX IF NOT EXISTS cb_usage_events_user_ts_idx ON cb_usage_events (user_id, ts_ms);
      CREATE INDEX IF NOT EXISTS cb_usage_events_model_ts_idx ON cb_usage_events (model, ts_ms);
      CREATE TABLE IF NOT EXISTS cb_usage_daily (
        date TEXT NOT NULL,
        user_id TEXT NOT NULL,
        model TEXT NOT NULL,
        spend REAL NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        requests INTEGER NOT NULL DEFAULT 0,
        success_requests INTEGER,
        failed_requests INTEGER,
        PRIMARY KEY (date, user_id, model)
      );
      CREATE INDEX IF NOT EXISTS cb_usage_daily_date_idx ON cb_usage_daily (date);
      CREATE INDEX IF NOT EXISTS cb_usage_daily_user_date_idx ON cb_usage_daily (user_id, date);
      CREATE TABLE IF NOT EXISTS cb_usage_sync_state (
        source TEXT PRIMARY KEY,
        cursor_ms INTEGER,
        last_run_iso TEXT,
        last_error TEXT
      );
    `);
    return sql;
  }

  async writeSpendEvents(events: SpendEvent[]): Promise<void> {
    const sql = await this.sql();
    if (sql === null) return;
    for (const raw of events) {
      const e = SpendEventSchema.parse(raw);
      sql.exec(
        `INSERT INTO cb_usage_events
           (request_id, ts_ms, user_id, team_id, model, prompt_tokens, completion_tokens, total_tokens, spend)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(request_id) DO NOTHING`,
        e.requestId,
        e.tsMs,
        e.userId,
        e.teamId,
        e.model,
        e.promptTokens,
        e.completionTokens,
        e.totalTokens,
        e.spend,
      );
    }
  }

  async queryRecentEvents(opts: {
    userId: string;
    limit: number;
  }): Promise<Array<{ tsMs: number; model: string; totalTokens: number; spend: number }>> {
    const sql = await this.sql();
    if (sql === null) return [];
    const rows = sql
      .exec<SqlRow>(
        `SELECT ts_ms, model, total_tokens, spend
         FROM cb_usage_events
        WHERE user_id = ?
        ORDER BY ts_ms DESC
        LIMIT ?`,
        opts.userId,
        opts.limit,
      )
      .toArray();
    return rows.map((r) => ({
      tsMs: Number(r.ts_ms),
      model: String(r.model),
      totalTokens: Number(r.total_tokens),
      spend: Number(r.spend),
    }));
  }

  async getSyncCursor(source: string): Promise<number | null> {
    const sql = await this.sql();
    if (sql === null) return null;
    const row = firstRow(
      sql.exec<{ cursor_ms: number | null }>("SELECT cursor_ms FROM cb_usage_sync_state WHERE source = ?", source),
    );
    return row?.cursor_ms == null ? null : Number(row.cursor_ms);
  }

  async setSyncCursor(source: string, opts: { cursorMs: number; lastError: string | null }): Promise<void> {
    const sql = await this.sql();
    if (sql === null) return;
    sql.exec(
      `INSERT INTO cb_usage_sync_state (source, cursor_ms, last_run_iso, last_error)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(source) DO UPDATE SET
         cursor_ms = excluded.cursor_ms,
         last_run_iso = excluded.last_run_iso,
         last_error = excluded.last_error`,
      source,
      opts.cursorMs,
      new Date().toISOString(),
      opts.lastError,
    );
  }

  private static readonly EVENT_RETENTION_MS = 30 * 86400000;

  async upsertDailyRows(rows: DailyRow[]): Promise<void> {
    const sql = await this.sql();
    if (sql === null) return;
    for (const raw of rows) {
      const d = DailyRowSchema.parse(raw);
      sql.exec(
        `INSERT INTO cb_usage_daily
           (date, user_id, model, spend, total_tokens, prompt_tokens,
            completion_tokens, requests, success_requests, failed_requests)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(date, user_id, model) DO UPDATE SET
           spend = excluded.spend,
           total_tokens = excluded.total_tokens,
           prompt_tokens = excluded.prompt_tokens,
           completion_tokens = excluded.completion_tokens,
           requests = excluded.requests,
           success_requests = excluded.success_requests,
           failed_requests = excluded.failed_requests`,
        d.date,
        d.userId,
        d.model,
        d.spend,
        d.totalTokens,
        d.promptTokens,
        d.completionTokens,
        d.requests,
        d.successRequests,
        d.failedRequests,
      );
    }
  }

  async pruneRetention(nowMs: number): Promise<void> {
    const sql = await this.sql();
    if (sql === null) return;
    sql.exec("DELETE FROM cb_usage_events WHERE ts_ms < ?", nowMs - UsageDO.EVENT_RETENTION_MS);
    const cutoffDate = new Date(nowMs - 365 * 86400000 + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
    sql.exec("DELETE FROM cb_usage_daily WHERE date < ?", cutoffDate);
  }

  async countDailyRows(): Promise<number> {
    const sql = await this.sql();
    if (sql === null) return 0;
    const row = firstRow(sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM cb_usage_daily"));
    return row?.n ?? 0;
  }

  async queryKpiWithDelta(opts: {
    scope: { kind: "global" } | { kind: "user"; userId: string };
    currentFromMs: number;
    currentToMs: number;
    previousFromMs: number;
    previousToMs: number;
  }): Promise<{
    current: { spend: number; requests: number; totalTokens: number };
    previous: { spend: number; requests: number; totalTokens: number };
  }> {
    const sql = await this.sql();
    const zero = { spend: 0, requests: 0, totalTokens: 0 };
    if (sql === null) return { current: { ...zero }, previous: { ...zero } };
    const userId = opts.scope.kind === "user" ? opts.scope.userId : null;
    // cb_usage_daily.date stores Asia/Shanghai (UTC+8) business dates, so the
    // daily-fallback window must derive its YYYY-MM-DD bounds in that TZ, not UTC.
    const SHANGHAI_TZ_MS = 8 * 60 * 60 * 1000;
    const shDate = (ms: number) => new Date(ms + SHANGHAI_TZ_MS).toISOString().slice(0, 10);
    const agg = (fromMs: number, toMs: number) => {
      const where = userId === null ? "" : " AND user_id = ?";
      const args: SqlStorageValue[] = userId === null ? [fromMs, toMs] : [fromMs, toMs, userId];
      const row = firstRow(
        sql.exec<SqlRow>(
          `SELECT COALESCE(SUM(spend),0) AS s,
                COALESCE(SUM(total_tokens),0) AS t,
                COUNT(*) AS r
           FROM cb_usage_events
          WHERE ts_ms >= ? AND ts_ms < ?${where}`,
          ...args,
        ),
      );
      return {
        spend: Number(row?.s ?? 0),
        totalTokens: Number(row?.t ?? 0),
        requests: Number(row?.r ?? 0),
      };
    };
    const current = agg(opts.currentFromMs, opts.currentToMs);
    // previous is intentionally event-only (no daily fallback); callers comparing current-vs-previous must treat the delta as approximate when current fell back to daily aggregates.
    const previous = agg(opts.previousFromMs, opts.previousToMs);
    if (current.requests === 0 && current.spend === 0) {
      const dRow = firstRow(
        sql.exec<SqlRow>(
          `SELECT COALESCE(SUM(spend),0) AS s, COALESCE(SUM(total_tokens),0) AS t,
                COALESCE(SUM(requests),0) AS r
           FROM cb_usage_daily
          WHERE date >= ? AND date < ?${userId === null ? "" : " AND user_id = ?"}`,
          ...(userId === null
            ? [shDate(opts.currentFromMs), shDate(opts.currentToMs)]
            : [shDate(opts.currentFromMs), shDate(opts.currentToMs), userId]),
        ),
      );
      if (dRow) {
        current.spend = Number(dRow.s);
        current.totalTokens = Number(dRow.t);
        current.requests = Number(dRow.r);
      }
    }
    return { current, previous };
  }
}

export { firstRow };
