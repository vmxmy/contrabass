import { DurableObject } from "cloudflare:workers";
import type { LiteLLMPortalEnv } from "../types";
import { SpendEventSchema, type SpendEvent } from "./usage-schemas";

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
}

export { firstRow };
