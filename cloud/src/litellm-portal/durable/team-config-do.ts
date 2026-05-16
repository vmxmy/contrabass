import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import {
  KeyRecordSchema,
  SpendSnapshotSchema,
  TeamRecordSchema,
  TeamAlertWebhookSchema,
  type KeyRecord,
  type SpendSnapshot,
  type TeamRecord,
  type TeamAlertWebhook,
} from "./schemas";
import type { LiteLLMPortalEnv } from "../types";

const MemberSchema = z.object({
  userId: z.string(),
  role: z.enum(["admin", "user"]),
}).strict();

type Member = z.infer<typeof MemberSchema>;

type SqlRow = Record<string, SqlStorageValue>;

type SqlCapableStorage = DurableObjectStorage & { sql?: SqlStorage };

type TeamConfigMigrationState = {
  backend: "sql" | "kv";
  hasTeam: boolean;
  members: number;
  keys: number;
  hasSpend: boolean;
  dirty: boolean;
  legacyKeys: number;
  legacyKvDeleted: boolean;
};

const SQL_BACKFILL_META_KEY = "sql_backfilled_from_kv_v1";
const SQL_LEGACY_KV_DELETED_META_KEY = "legacy_kv_deleted_v1";
const ALERT_WEBHOOK_META_KEY = "alert_webhook_v1";
const ALERT_WEBHOOK_KV_KEY = "meta:alertWebhook";
const ALERT_DEDUPE_META_PREFIX = "budget_alert_sent:";
const ALERT_DEDUPE_KV_PREFIX = "meta:budgetAlertSent:";

function firstRow<T extends SqlRow>(cursor: SqlStorageCursor<T>): T | undefined {
  return cursor.toArray()[0];
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function parseJson(raw: string): unknown {
  return JSON.parse(raw);
}

function optionalNumber(value: SqlStorageValue): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalString(value: SqlStorageValue): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function teamFromRow(row: SqlRow): TeamRecord {
  return TeamRecordSchema.parse({
    id: String(row.team_id),
    alias: String(row.alias),
    models: z.array(z.string()).parse(parseJson(String(row.models_json))),
    ...(optionalNumber(row.max_budget) !== undefined ? { maxBudget: optionalNumber(row.max_budget) } : {}),
    ...(optionalNumber(row.tpm_limit) !== undefined ? { tpmLimit: optionalNumber(row.tpm_limit) } : {}),
    ...(optionalNumber(row.rpm_limit) !== undefined ? { rpmLimit: optionalNumber(row.rpm_limit) } : {}),
    blocked: row.blocked === 1,
    ...(optionalString(row.budget_duration) !== undefined ? { budgetDuration: optionalString(row.budget_duration) } : {}),
    ...(optionalString(row.budget_reset_at) !== undefined ? { budgetResetAt: optionalString(row.budget_reset_at) } : {}),
  });
}

function memberFromRow(row: SqlRow): Member {
  return MemberSchema.parse({ userId: String(row.user_id), role: row.role });
}

function keyFromRow(row: SqlRow): KeyRecord {
  return KeyRecordSchema.parse(parseJson(String(row.record_json)));
}

function spendFromRow(row: SqlRow): SpendSnapshot {
  return SpendSnapshotSchema.parse({
    teamId: String(row.team_id),
    currentSpend: Number(row.current_spend),
    maxBudget: optionalNumber(row.max_budget) ?? null,
    fetchedAt: String(row.fetched_at),
  });
}

export class TeamConfigDO extends DurableObject<LiteLLMPortalEnv> {
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
      CREATE TABLE IF NOT EXISTS cb_team (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        team_id TEXT NOT NULL,
        alias TEXT NOT NULL,
        models_json TEXT NOT NULL CHECK (json_valid(models_json)),
        max_budget REAL,
        tpm_limit INTEGER,
        rpm_limit INTEGER,
        blocked INTEGER NOT NULL CHECK (blocked IN (0, 1)),
        budget_duration TEXT,
        budget_reset_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cb_members (
        user_id TEXT PRIMARY KEY,
        role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cb_keys (
        id TEXT PRIMARY KEY,
        record_json TEXT NOT NULL CHECK (json_valid(record_json)),
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cb_spend_current (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        team_id TEXT NOT NULL,
        current_spend REAL NOT NULL,
        max_budget REAL,
        fetched_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cb_sync_meta (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        dirty INTEGER NOT NULL DEFAULT 0 CHECK (dirty IN (0, 1)),
        pending_idempotency_key TEXT,
        last_idempotency_key TEXT,
        last_synced_at TEXT,
        last_sync_error TEXT,
        last_spend_error TEXT,
        updated_at TEXT NOT NULL
      );
      INSERT INTO cb_sync_meta (singleton, dirty, updated_at)
      VALUES (1, 0, datetime('now'))
      ON CONFLICT(singleton) DO NOTHING;
      CREATE TABLE IF NOT EXISTS cb_team_meta (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    const marker = firstRow(sql.exec<{ value_json: string }>(
      "SELECT value_json FROM cb_team_meta WHERE key = ?",
      SQL_BACKFILL_META_KEY,
    ));
    if (marker?.value_json !== "true") {
      await this.backfillSqlFromLegacyKV(sql);
      this.putMetaSql(sql, SQL_BACKFILL_META_KEY, true);
    }

    return sql;
  }

  private async backfillSqlFromLegacyKV(sql: SqlStorage): Promise<void> {
    const team = await this.ctx.storage.get<unknown>("team");
    if (team != null) this.putTeamSql(sql, TeamRecordSchema.parse(team));

    const members = await this.ctx.storage.list<unknown>({ prefix: "members:" });
    for (const raw of members.values()) {
      this.putMemberSql(sql, MemberSchema.parse(raw));
    }

    const keys = await this.ctx.storage.list<unknown>({ prefix: "keys:" });
    for (const raw of keys.values()) {
      this.putKeySql(sql, KeyRecordSchema.parse(raw));
    }

    const spend = await this.ctx.storage.get<unknown>("spend:current");
    if (spend != null) this.putSpendSql(sql, SpendSnapshotSchema.parse(spend));

    const dirty = await this.ctx.storage.get<boolean>("meta:dirty");
    const pending = await this.ctx.storage.get<string>("meta:pendingIdempotencyKey");
    const lastSyncedAt = await this.ctx.storage.get<string>("meta:lastSyncedAt");
    const lastSyncError = await this.ctx.storage.get<string>("meta:lastSyncError");
    const lastIdempotencyKey = await this.ctx.storage.get<string>("meta:lastIdempotencyKey");
    const lastSpendError = await this.ctx.storage.get<string>("meta:lastSpendError");
    this.putSyncMetaSql(sql, {
      dirty: dirty ?? false,
      pendingIdempotencyKey: pending ?? null,
      lastSyncedAt: lastSyncedAt ?? null,
      lastSyncError: lastSyncError ?? null,
      lastIdempotencyKey: lastIdempotencyKey ?? null,
      lastSpendError: lastSpendError ?? null,
    });
  }

  private putTeamSql(sql: SqlStorage, record: TeamRecord): void {
    const parsed = TeamRecordSchema.parse(record);
    sql.exec(
      `INSERT INTO cb_team (
         singleton, team_id, alias, models_json, max_budget, tpm_limit, rpm_limit,
         blocked, budget_duration, budget_reset_at, updated_at
       ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET
         team_id = excluded.team_id,
         alias = excluded.alias,
         models_json = excluded.models_json,
         max_budget = excluded.max_budget,
         tpm_limit = excluded.tpm_limit,
         rpm_limit = excluded.rpm_limit,
         blocked = excluded.blocked,
         budget_duration = excluded.budget_duration,
         budget_reset_at = excluded.budget_reset_at,
         updated_at = excluded.updated_at`,
      parsed.id,
      parsed.alias,
      json(parsed.models),
      parsed.maxBudget ?? null,
      parsed.tpmLimit ?? null,
      parsed.rpmLimit ?? null,
      parsed.blocked ? 1 : 0,
      parsed.budgetDuration ?? null,
      parsed.budgetResetAt ?? null,
      new Date().toISOString(),
    );
  }

  private putMemberSql(sql: SqlStorage, member: Member): void {
    const parsed = MemberSchema.parse(member);
    sql.exec(
      `INSERT INTO cb_members (user_id, role, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         role = excluded.role,
         updated_at = excluded.updated_at`,
      parsed.userId,
      parsed.role,
      new Date().toISOString(),
    );
  }

  private putKeySql(sql: SqlStorage, record: KeyRecord): void {
    const parsed = KeyRecordSchema.parse(record);
    sql.exec(
      `INSERT INTO cb_keys (id, record_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         record_json = excluded.record_json,
         updated_at = excluded.updated_at`,
      parsed.id,
      json(parsed),
      new Date().toISOString(),
    );
  }

  private putSpendSql(sql: SqlStorage, snapshot: SpendSnapshot): void {
    const parsed = SpendSnapshotSchema.parse(snapshot);
    sql.exec(
      `INSERT INTO cb_spend_current (singleton, team_id, current_spend, max_budget, fetched_at)
       VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET
         team_id = excluded.team_id,
         current_spend = excluded.current_spend,
         max_budget = excluded.max_budget,
         fetched_at = excluded.fetched_at`,
      parsed.teamId,
      parsed.currentSpend,
      parsed.maxBudget,
      parsed.fetchedAt,
    );
  }

  private putSyncMetaSql(sql: SqlStorage, meta: {
    dirty?: boolean;
    pendingIdempotencyKey?: string | null;
    lastIdempotencyKey?: string | null;
    lastSyncedAt?: string | null;
    lastSyncError?: string | null;
    lastSpendError?: string | null;
  }): void {
    const current = firstRow(sql.exec<SqlRow>("SELECT * FROM cb_sync_meta WHERE singleton = 1"));
    const has = (key: keyof typeof meta): boolean => Object.prototype.hasOwnProperty.call(meta, key);
    const dirty = has("dirty") ? meta.dirty === true : current?.dirty === 1;
    const pendingIdempotencyKey = has("pendingIdempotencyKey")
      ? meta.pendingIdempotencyKey ?? null
      : (current?.pending_idempotency_key as string | null | undefined) ?? null;
    const lastIdempotencyKey = has("lastIdempotencyKey")
      ? meta.lastIdempotencyKey ?? null
      : (current?.last_idempotency_key as string | null | undefined) ?? null;
    const lastSyncedAt = has("lastSyncedAt")
      ? meta.lastSyncedAt ?? null
      : (current?.last_synced_at as string | null | undefined) ?? null;
    const lastSyncError = has("lastSyncError")
      ? meta.lastSyncError ?? null
      : (current?.last_sync_error as string | null | undefined) ?? null;
    const lastSpendError = has("lastSpendError")
      ? meta.lastSpendError ?? null
      : (current?.last_spend_error as string | null | undefined) ?? null;

    sql.exec(
      `INSERT INTO cb_sync_meta (
         singleton, dirty, pending_idempotency_key, last_idempotency_key,
         last_synced_at, last_sync_error, last_spend_error, updated_at
       ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET
         dirty = excluded.dirty,
         pending_idempotency_key = excluded.pending_idempotency_key,
         last_idempotency_key = excluded.last_idempotency_key,
         last_synced_at = excluded.last_synced_at,
         last_sync_error = excluded.last_sync_error,
         last_spend_error = excluded.last_spend_error,
         updated_at = excluded.updated_at`,
      dirty ? 1 : 0,
      pendingIdempotencyKey,
      lastIdempotencyKey,
      lastSyncedAt,
      lastSyncError,
      lastSpendError,
      new Date().toISOString(),
    );
  }

  private putMetaSql(sql: SqlStorage, key: string, value: unknown): void {
    sql.exec(
      `INSERT INTO cb_team_meta (key, value_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value_json = excluded.value_json,
         updated_at = excluded.updated_at`,
      key,
      json(value),
      new Date().toISOString(),
    );
  }

  private getMetaSql<T>(sql: SqlStorage, key: string, fallback: T): T {
    const row = firstRow(sql.exec<{ value_json: string }>(
      "SELECT value_json FROM cb_team_meta WHERE key = ?",
      key,
    ));
    return row == null ? fallback : JSON.parse(row.value_json) as T;
  }

  private markDirtySql(sql: SqlStorage, idempotencyKey?: string): void {
    this.putSyncMetaSql(sql, {
      dirty: true,
      ...(idempotencyKey ? { pendingIdempotencyKey: idempotencyKey } : {}),
    });
  }

  // ---------------------------------------------------------------------------
  // Team metadata
  // ---------------------------------------------------------------------------

  async getTeam(): Promise<TeamRecord | null> {
    const sql = await this.sql();
    if (sql !== null) {
      const row = firstRow(sql.exec<SqlRow>("SELECT * FROM cb_team WHERE singleton = 1"));
      return row == null ? null : teamFromRow(row);
    }

    return (await this.ctx.storage.get<TeamRecord>("team")) ?? null;
  }

  async putTeam(record: TeamRecord, idempotencyKey?: string): Promise<void> {
    TeamRecordSchema.parse(record);
    const sql = await this.sql();
    if (sql !== null) {
      this.putTeamSql(sql, record);
      this.markDirtySql(sql, idempotencyKey);
      return;
    }

    await this.ctx.storage.transaction(async (txn) => {
      await txn.put("team", record);
      await txn.put("meta:dirty", true);
      if (idempotencyKey) {
        await txn.put("meta:pendingIdempotencyKey", idempotencyKey);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Members
  // ---------------------------------------------------------------------------

  async listMembers(): Promise<Member[]> {
    const sql = await this.sql();
    if (sql !== null) {
      return sql.exec<SqlRow>("SELECT * FROM cb_members ORDER BY user_id ASC").toArray().map(memberFromRow);
    }

    const map = await this.ctx.storage.list<Member>({ prefix: "members:" });
    return Array.from(map.values());
  }

  async upsertMember(member: Member, idempotencyKey?: string): Promise<void> {
    MemberSchema.parse(member);
    const sql = await this.sql();
    if (sql !== null) {
      this.putMemberSql(sql, member);
      this.markDirtySql(sql, idempotencyKey);
      return;
    }

    await this.ctx.storage.transaction(async (txn) => {
      await txn.put(`members:${member.userId}`, member);
      await txn.put("meta:dirty", true);
      if (idempotencyKey) {
        await txn.put("meta:pendingIdempotencyKey", idempotencyKey);
      }
    });
  }

  async removeMember(userId: string, idempotencyKey?: string): Promise<void> {
    const sql = await this.sql();
    if (sql !== null) {
      sql.exec("DELETE FROM cb_members WHERE user_id = ?", userId);
      this.markDirtySql(sql, idempotencyKey);
      return;
    }

    await this.ctx.storage.transaction(async (txn) => {
      await txn.delete(`members:${userId}`);
      await txn.put("meta:dirty", true);
      if (idempotencyKey) {
        await txn.put("meta:pendingIdempotencyKey", idempotencyKey);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Keys
  // ---------------------------------------------------------------------------

  async listKeys(): Promise<KeyRecord[]> {
    const sql = await this.sql();
    if (sql !== null) {
      return sql.exec<SqlRow>("SELECT * FROM cb_keys ORDER BY id ASC").toArray().map(keyFromRow);
    }

    const map = await this.ctx.storage.list<KeyRecord>({ prefix: "keys:" });
    return Array.from(map.values());
  }

  async upsertKey(record: KeyRecord, idempotencyKey?: string): Promise<void> {
    KeyRecordSchema.parse(record);
    const sql = await this.sql();
    if (sql !== null) {
      this.putKeySql(sql, record);
      this.markDirtySql(sql, idempotencyKey);
      return;
    }

    await this.ctx.storage.transaction(async (txn) => {
      await txn.put(`keys:${record.id}`, record);
      await txn.put("meta:dirty", true);
      if (idempotencyKey) {
        await txn.put("meta:pendingIdempotencyKey", idempotencyKey);
      }
    });
  }

  async deleteKey(id: string, idempotencyKey?: string): Promise<void> {
    const sql = await this.sql();
    if (sql !== null) {
      sql.exec("DELETE FROM cb_keys WHERE id = ?", id);
      this.markDirtySql(sql, idempotencyKey);
      return;
    }

    await this.ctx.storage.transaction(async (txn) => {
      await txn.delete(`keys:${id}`);
      await txn.put("meta:dirty", true);
      if (idempotencyKey) {
        await txn.put("meta:pendingIdempotencyKey", idempotencyKey);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Spend snapshot (set by spend cron; does NOT touch dirty)
  // ---------------------------------------------------------------------------

  async getSpend(): Promise<SpendSnapshot | null> {
    const sql = await this.sql();
    if (sql !== null) {
      const row = firstRow(sql.exec<SqlRow>("SELECT * FROM cb_spend_current WHERE singleton = 1"));
      return row == null ? null : spendFromRow(row);
    }

    return (await this.ctx.storage.get<SpendSnapshot>("spend:current")) ?? null;
  }

  async putSpend(snapshot: SpendSnapshot): Promise<void> {
    SpendSnapshotSchema.parse(snapshot);
    const sql = await this.sql();
    if (sql !== null) {
      this.putSpendSql(sql, snapshot);
      return;
    }

    await this.ctx.storage.put("spend:current", snapshot);
  }

  async recordSpendError(reason: string): Promise<void> {
    const truncated = reason.slice(0, 200);
    const sql = await this.sql();
    if (sql !== null) {
      this.putSyncMetaSql(sql, { lastSpendError: truncated });
      return;
    }

    await this.ctx.storage.put("meta:lastSpendError", truncated);
  }

  // ---------------------------------------------------------------------------
  // Per-team budget alert webhook + budget-cycle dedupe
  // ---------------------------------------------------------------------------

  async getAlertWebhook(): Promise<TeamAlertWebhook | null> {
    const sql = await this.sql();
    if (sql !== null) {
      const raw = this.getMetaSql<unknown>(sql, ALERT_WEBHOOK_META_KEY, null);
      if (raw == null) return null;
      return TeamAlertWebhookSchema.parse(raw);
    }
    const raw = await this.ctx.storage.get<unknown>(ALERT_WEBHOOK_KV_KEY);
    return raw == null ? null : TeamAlertWebhookSchema.parse(raw);
  }

  async setAlertWebhook(webhook: TeamAlertWebhook): Promise<void> {
    const parsed = TeamAlertWebhookSchema.parse(webhook);
    const sql = await this.sql();
    if (sql !== null) {
      this.putMetaSql(sql, ALERT_WEBHOOK_META_KEY, parsed);
      return;
    }
    await this.ctx.storage.put(ALERT_WEBHOOK_KV_KEY, parsed);
  }

  async clearAlertWebhook(): Promise<void> {
    const sql = await this.sql();
    if (sql !== null) {
      this.putMetaSql(sql, ALERT_WEBHOOK_META_KEY, null);
      return;
    }
    await this.ctx.storage.delete(ALERT_WEBHOOK_KV_KEY);
  }

  async hasBudgetAlertForCycle(cycleKey: string): Promise<boolean> {
    const sql = await this.sql();
    if (sql !== null) {
      return this.getMetaSql<unknown>(sql, `${ALERT_DEDUPE_META_PREFIX}${cycleKey}`, null) != null;
    }
    return (await this.ctx.storage.get<unknown>(`${ALERT_DEDUPE_KV_PREFIX}${cycleKey}`)) != null;
  }

  async markBudgetAlertForCycle(cycleKey: string): Promise<void> {
    const sql = await this.sql();
    if (sql !== null) {
      this.putMetaSql(sql, `${ALERT_DEDUPE_META_PREFIX}${cycleKey}`, { sentAt: new Date().toISOString() });
      this.pruneOldAlertMarkersSql(sql);
      return;
    }
    await this.ctx.storage.put(`${ALERT_DEDUPE_KV_PREFIX}${cycleKey}`, { sentAt: new Date().toISOString() });
  }

  private pruneOldAlertMarkersSql(sql: SqlStorage): void {
    sql.exec(
      `DELETE FROM cb_team_meta
       WHERE key LIKE '${ALERT_DEDUPE_META_PREFIX}%'
         AND updated_at < datetime('now', '-60 days')`,
    );
  }

  // ---------------------------------------------------------------------------
  // Sync metadata (used by queue consumer)
  // ---------------------------------------------------------------------------

  async recordSyncSuccess(idempotencyKey: string): Promise<void> {
    const sql = await this.sql();
    if (sql !== null) {
      const current = firstRow(sql.exec<SqlRow>("SELECT * FROM cb_sync_meta WHERE singleton = 1"));
      const pending = current?.pending_idempotency_key as string | null | undefined;
      this.putSyncMetaSql(sql, {
        lastSyncedAt: new Date().toISOString(),
        lastSyncError: null,
        lastIdempotencyKey: idempotencyKey,
        ...(pending === undefined || pending === null || pending === idempotencyKey
          ? { dirty: false, pendingIdempotencyKey: null }
          : { dirty: current?.dirty === 1, pendingIdempotencyKey: pending }),
      });
      return;
    }

    await this.ctx.storage.transaction(async (txn) => {
      const pending = await txn.get<string>("meta:pendingIdempotencyKey");
      await txn.put("meta:lastSyncedAt", new Date().toISOString());
      await txn.delete("meta:lastSyncError");
      await txn.put("meta:lastIdempotencyKey", idempotencyKey);
      // Only clear dirty if this success matches the latest pending mutation.
      // If pending is undefined (legacy path, no pendingIdempotencyKey written),
      // treat as a match so existing behaviour is preserved.
      if (pending === undefined || pending === idempotencyKey) {
        await txn.put("meta:dirty", false);
        await txn.delete("meta:pendingIdempotencyKey");
      }
      // Otherwise a newer mutation is still pending — leave dirty=true.
    });
  }

  async recordSyncError(reason: string): Promise<void> {
    const truncated = reason.slice(0, 200);
    const sql = await this.sql();
    if (sql !== null) {
      this.putSyncMetaSql(sql, { lastSyncError: truncated });
      return;
    }

    await this.ctx.storage.put("meta:lastSyncError", truncated);
  }

  async getSyncMetadata(): Promise<{
    lastSyncedAt: string | null;
    lastSyncError: string | null;
    dirty: boolean;
  }> {
    const sql = await this.sql();
    if (sql !== null) {
      const row = firstRow(sql.exec<SqlRow>("SELECT * FROM cb_sync_meta WHERE singleton = 1"));
      return {
        lastSyncedAt: row?.last_synced_at == null ? null : String(row.last_synced_at),
        lastSyncError: row?.last_sync_error == null ? null : String(row.last_sync_error),
        dirty: row?.dirty === 1,
      };
    }

    const [lastSyncedAt, lastSyncError, dirty] = await Promise.all([
      this.ctx.storage.get<string>("meta:lastSyncedAt"),
      this.ctx.storage.get<string>("meta:lastSyncError"),
      this.ctx.storage.get<boolean>("meta:dirty"),
    ]);
    return {
      lastSyncedAt: lastSyncedAt ?? null,
      lastSyncError: lastSyncError ?? null,
      dirty: dirty ?? false,
    };
  }

  // ---------------------------------------------------------------------------
  // Migration and cleanup helpers
  // ---------------------------------------------------------------------------

  async getStorageMigrationState(): Promise<TeamConfigMigrationState> {
    const sql = await this.sql();
    const legacyKeys = await this.countLegacyKVKeys();
    if (sql === null) {
      return {
        backend: "kv",
        hasTeam: false,
        members: 0,
        keys: 0,
        hasSpend: false,
        dirty: false,
        legacyKeys,
        legacyKvDeleted: false,
      };
    }

    return {
      backend: "sql",
      hasTeam: this.countSql(sql, "cb_team") > 0,
      members: this.countSql(sql, "cb_members"),
      keys: this.countSql(sql, "cb_keys"),
      hasSpend: this.countSql(sql, "cb_spend_current") > 0,
      dirty: (firstRow(sql.exec<SqlRow>("SELECT dirty FROM cb_sync_meta WHERE singleton = 1"))?.dirty ?? 0) === 1,
      legacyKeys,
      legacyKvDeleted: this.getMetaSql<boolean>(sql, SQL_LEGACY_KV_DELETED_META_KEY, false),
    };
  }

  async deleteLegacyKV(): Promise<{ deleted: number; skipped: boolean }> {
    const sql = await this.sql();
    if (sql === null) return { deleted: 0, skipped: true };

    let deleted = 0;
    deleted += await this.deleteKeyIfPresent("team");
    deleted += await this.deleteKeyIfPresent("spend:current");
    deleted += await this.deleteKeyIfPresent("meta:dirty");
    deleted += await this.deleteKeyIfPresent("meta:pendingIdempotencyKey");
    deleted += await this.deleteKeyIfPresent("meta:lastSyncedAt");
    deleted += await this.deleteKeyIfPresent("meta:lastSyncError");
    deleted += await this.deleteKeyIfPresent("meta:lastIdempotencyKey");
    deleted += await this.deleteKeyIfPresent("meta:lastSpendError");
    deleted += await this.deleteKeysByPrefix("members:");
    deleted += await this.deleteKeysByPrefix("keys:");
    this.putMetaSql(sql, SQL_LEGACY_KV_DELETED_META_KEY, true);
    return { deleted, skipped: false };
  }

  private countSql(sql: SqlStorage, table: string): number {
    const row = firstRow(sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`));
    return row?.n ?? 0;
  }

  private async countLegacyKVKeys(): Promise<number> {
    let count = 0;
    count += await this.hasKey("team");
    count += await this.hasKey("spend:current");
    count += await this.hasKey("meta:dirty");
    count += await this.hasKey("meta:pendingIdempotencyKey");
    count += await this.hasKey("meta:lastSyncedAt");
    count += await this.hasKey("meta:lastSyncError");
    count += await this.hasKey("meta:lastIdempotencyKey");
    count += await this.hasKey("meta:lastSpendError");
    count += (await this.ctx.storage.list({ prefix: "members:" })).size;
    count += (await this.ctx.storage.list({ prefix: "keys:" })).size;
    return count;
  }

  private async hasKey(key: string): Promise<number> {
    return (await this.ctx.storage.get(key)) === undefined ? 0 : 1;
  }

  private async deleteKeyIfPresent(key: string): Promise<number> {
    return await this.ctx.storage.delete(key) ? 1 : 0;
  }

  private async deleteKeysByPrefix(prefix: string): Promise<number> {
    let deleted = 0;
    for (;;) {
      const entries = await this.ctx.storage.list({ prefix, limit: 1000 });
      if (entries.size === 0) return deleted;
      for (const key of entries.keys()) {
        if (await this.ctx.storage.delete(key)) deleted++;
      }
      if (entries.size < 1000) return deleted;
    }
  }
}
