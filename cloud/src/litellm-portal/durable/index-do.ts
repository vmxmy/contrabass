import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import {
  UserRecordSchema,
  type UserRecord,
  IdentityMapRecordSchema,
  type IdentityMapRecord,
  InviteRecordSchema,
  type InviteRecord,
  MagicLinkNonceSchema,
  type MagicLinkNonce,
  AuditEventSchema,
  type AuditEvent,
  TenantRoleRecordSchema,
  type TenantRoleRecord,
  ImpersonationSessionSchema,
  type ImpersonationSession,
  ImpersonationAuditEnvelopeSchema,
} from "./schemas";
import type { LiteLLMPortalEnv } from "../types";
import {
  importTeams,
  importUsers,
  applyBootstrapAdmins,
  finalizeImport,
} from "../sync/litellm-importer";

// ---------------------------------------------------------------------------
// Local schemas
// ---------------------------------------------------------------------------

const TeamEntrySchema = z.object({ id: z.string(), alias: z.string() });
type TeamEntry = z.infer<typeof TeamEntrySchema>;

const TeamListSchema = z.array(TeamEntrySchema);

const EmailPointerSchema = z.object({
  userId: z.string(),
  teamId: z.string().nullable(),
  role: z.enum(["admin", "user"]),
});

// ---------------------------------------------------------------------------
// Storage key helpers
// ---------------------------------------------------------------------------

const KEY_TEAMS_LIST = "teams:list";
const KEY_META_IMPORTED = "meta:imported";
const KEY_META_BOOTSTRAP_ADMINS = "meta:bootstrapAdmins";
const SQL_BACKFILL_META_KEY = "sql_backfilled_from_kv_v1";
const SQL_LEGACY_KV_DELETED_META_KEY = "legacy_kv_deleted_v1";

function emailKey(email: string): string {
  return `email:${email.toLowerCase()}`;
}

function userKey(userId: string): string {
  return `user:${userId}`;
}

function nonceKey(token: string): string {
  return `nonce:${token}`;
}

function inviteKey(emailLc: string): string {
  return `invite:${emailLc.toLowerCase()}`;
}

function tenantRoleKey(userId: string, teamId: string): string {
  return `trole:${userId}:${teamId}`;
}

function auditKey(ts: string, id: string): string {
  return `audit:${ts}:${id}`;
}

type SqlRow = Record<string, SqlStorageValue>;

type SqlCapableStorage = DurableObjectStorage & { sql?: SqlStorage };

type StorageMigrationState = {
  backend: "sql" | "kv";
  teams: number;
  users: number;
  nonces: number;
  auditEvents: number;
  legacyKeys: number;
  legacyKvDeleted: boolean;
};

function firstRow<T extends SqlRow>(cursor: SqlStorageCursor<T>): T | undefined {
  return cursor.toArray()[0];
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function parseJson(raw: string | null): unknown | null {
  return raw == null ? null : JSON.parse(raw);
}

function optionalNumber(value: SqlStorageValue): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function userFromRow(row: SqlRow): UserRecord {
  const record = {
    userId: String(row.user_id),
    email: String(row.email),
    role: row.role,
    teamId: row.team_id === null ? null : String(row.team_id),
    ...(optionalNumber(row.max_budget) !== undefined ? { maxBudget: optionalNumber(row.max_budget) } : {}),
    createdAt: String(row.created_at),
  };
  return UserRecordSchema.parse(record);
}

function identityFromRow(row: SqlRow): IdentityMapRecord {
  return IdentityMapRecordSchema.parse({
    emailLc: String(row.email_lc),
    litellmUserId: String(row.litellm_user_id),
    teams: JSON.parse(String(row.teams_json)),
    userRole: row.user_role === null ? null : String(row.user_role),
    origin: String(row.origin),
    lastReconciledAt: String(row.last_reconciled_at),
  });
}

function inviteFromRow(row: SqlRow): InviteRecord {
  return InviteRecordSchema.parse({
    emailLc: String(row.email_lc),
    teamId: String(row.team_id),
    teamRole: row.team_role,
    status: row.status,
    invitedBy: String(row.invited_by),
    createdAt: String(row.created_at),
    consumedAt: row.consumed_at === null ? null : String(row.consumed_at),
  });
}

function tenantRoleFromRow(row: SqlRow): TenantRoleRecord {
  return TenantRoleRecordSchema.parse({
    userId: String(row.user_id),
    teamId: String(row.team_id),
    tenantRole: String(row.tenant_role),
    updatedBy: String(row.updated_by),
    updatedAt: String(row.updated_at),
  });
}

function nonceFromRow(row: SqlRow): MagicLinkNonce {
  return MagicLinkNonceSchema.parse({
    token: String(row.token),
    email: String(row.email),
    expiresAt: String(row.expires_at),
    consumedAt: row.consumed_at === null ? null : String(row.consumed_at),
  });
}

function auditFromRow(row: SqlRow): AuditEvent {
  return AuditEventSchema.parse({
    id: String(row.id),
    ts: String(row.ts),
    actorEmail: String(row.actor_email),
    action: String(row.action),
    entityKind: String(row.entity_kind),
    entityId: String(row.entity_id),
    before: parseJson(row.before_json === null ? null : String(row.before_json)),
    after: parseJson(row.after_json === null ? null : String(row.after_json)),
    reason: row.reason === null ? null : String(row.reason),
    impersonation:
      row.impersonation == null
        ? null
        : ImpersonationAuditEnvelopeSchema.parse(JSON.parse(String(row.impersonation))),
  });
}

function cursorUserId(cursor: string | undefined): string | null {
  if (cursor == null) return null;
  return cursor.startsWith("user:") ? cursor.slice("user:".length) : cursor;
}

// ---------------------------------------------------------------------------
// IndexDO
// ---------------------------------------------------------------------------

export class IndexDO extends DurableObject<LiteLLMPortalEnv> {
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
      CREATE TABLE IF NOT EXISTS cb_index_teams (
        id TEXT PRIMARY KEY,
        alias TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cb_index_users (
        user_id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        email_lc TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
        team_id TEXT,
        max_budget REAL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cb_index_magic_nonces (
        token TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS cb_index_magic_nonces_expires_idx
        ON cb_index_magic_nonces (expires_at);
      CREATE TABLE IF NOT EXISTS cb_index_audit_events (
        id TEXT PRIMARY KEY,
        ts TEXT NOT NULL,
        actor_email TEXT NOT NULL,
        action TEXT NOT NULL,
        entity_kind TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        before_json TEXT,
        after_json TEXT,
        reason TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS cb_index_audit_events_ts_idx
        ON cb_index_audit_events (ts DESC, id DESC);
      CREATE TABLE IF NOT EXISTS cb_index_meta (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cb_index_invites (
        email_lc TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        team_role TEXT NOT NULL CHECK (team_role IN ('admin', 'user')),
        status TEXT NOT NULL CHECK (status IN ('pending', 'consumed', 'revoked')),
        invited_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        consumed_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS cb_index_invites_status_idx
        ON cb_index_invites (status, email_lc);
      CREATE TABLE IF NOT EXISTS cb_index_tenant_roles (
        user_id TEXT NOT NULL,
        team_id TEXT NOT NULL,
        tenant_role TEXT NOT NULL CHECK (tenant_role IN ('tenant_admin', 'member')),
        updated_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, team_id)
      );
      CREATE INDEX IF NOT EXISTS cb_index_tenant_roles_team_idx
        ON cb_index_tenant_roles (team_id, user_id);
      CREATE TABLE IF NOT EXISTS cb_index_impersonation (
        real_actor TEXT NOT NULL,
        effective_team_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        PRIMARY KEY (real_actor, started_at)
      );
      CREATE INDEX IF NOT EXISTS cb_index_impersonation_actor_idx
        ON cb_index_impersonation (real_actor, started_at DESC);
      CREATE TABLE IF NOT EXISTS cb_index_identity (
        email_lc TEXT PRIMARY KEY,
        litellm_user_id TEXT NOT NULL,
        teams_json TEXT NOT NULL,
        user_role TEXT,
        origin TEXT NOT NULL CHECK (origin IN ('deterministic', 'recorded', 'migrated')),
        last_reconciled_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS cb_index_identity_user_idx
        ON cb_index_identity (litellm_user_id);
    `);

    const auditCols = sql
      .exec<{ name: string }>("PRAGMA table_info(cb_index_audit_events)")
      .toArray()
      .map((r) => r.name);
    if (!auditCols.includes("impersonation")) {
      sql.exec("ALTER TABLE cb_index_audit_events ADD COLUMN impersonation TEXT");
    }
    sql.exec(
      `CREATE INDEX IF NOT EXISTS cb_index_audit_events_imp_team_idx
         ON cb_index_audit_events (json_extract(impersonation, '$.effectiveTeam'))`,
    );

    const marker = firstRow(sql.exec<{ value_json: string }>(
      "SELECT value_json FROM cb_index_meta WHERE key = ?",
      SQL_BACKFILL_META_KEY,
    ));
    if (marker?.value_json !== "true") {
      await this.backfillSqlFromLegacyKV(sql);
      this.putMetaSql(sql, SQL_BACKFILL_META_KEY, true);
    }

    return sql;
  }

  private async backfillSqlFromLegacyKV(sql: SqlStorage): Promise<void> {
    const teams = await this.ctx.storage.get<unknown>(KEY_TEAMS_LIST);
    if (teams != null) {
      this.putTeamsSql(sql, TeamListSchema.parse(teams));
    }

    const users = await this.ctx.storage.list<unknown>({ prefix: "user:" });
    for (const raw of users.values()) {
      this.putUserSql(sql, UserRecordSchema.parse(raw));
    }

    const nonces = await this.ctx.storage.list<unknown>({ prefix: "nonce:" });
    for (const raw of nonces.values()) {
      this.putNonceSql(sql, MagicLinkNonceSchema.parse(raw));
    }

    const audits = await this.ctx.storage.list<unknown>({ prefix: "audit:" });
    for (const raw of audits.values()) {
      this.putAuditSql(sql, AuditEventSchema.parse(raw));
    }

    const tenantRoles = await this.ctx.storage.list<unknown>({ prefix: "trole:" });
    for (const raw of tenantRoles.values()) {
      this.putTenantRoleSql(sql, TenantRoleRecordSchema.parse(raw));
    }

    const imported = await this.ctx.storage.get<unknown>(KEY_META_IMPORTED);
    if (imported !== undefined) {
      this.putMetaSql(sql, "imported", imported === true);
    }

    const bootstrapAdmins = await this.ctx.storage.get<unknown>(KEY_META_BOOTSTRAP_ADMINS);
    if (bootstrapAdmins != null) {
      this.putMetaSql(sql, "bootstrapAdmins", z.array(z.string()).parse(bootstrapAdmins));
    }
  }

  private putTeamsSql(sql: SqlStorage, list: TeamEntry[]): void {
    sql.exec("DELETE FROM cb_index_teams");
    const now = new Date().toISOString();
    list.forEach((team, index) => {
      sql.exec(
        `INSERT INTO cb_index_teams (id, alias, position, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           alias = excluded.alias,
           position = excluded.position,
           updated_at = excluded.updated_at`,
        team.id,
        team.alias,
        index,
        now,
      );
    });
  }

  private putUserSql(sql: SqlStorage, record: UserRecord): void {
    const parsed = UserRecordSchema.parse(record);
    // Reconcile a stale row that shares this email but was keyed by a different
    // user_id (e.g. a first-login placeholder keyed by email before the LiteLLM
    // importer learned the canonical user_id). Without this delete the INSERT
    // below would violate the email_lc UNIQUE constraint and the canonical
    // mapping (cb_index_users.user_id = real LiteLLM user_id) would never land.
    sql.exec(
      "DELETE FROM cb_index_users WHERE email_lc = ? AND user_id <> ?",
      parsed.email.toLowerCase(),
      parsed.userId,
    );
    sql.exec(
      `INSERT INTO cb_index_users (
         user_id, email, email_lc, role, team_id, max_budget, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         email = excluded.email,
         email_lc = excluded.email_lc,
         role = excluded.role,
         team_id = excluded.team_id,
         max_budget = excluded.max_budget,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at`,
      parsed.userId,
      parsed.email,
      parsed.email.toLowerCase(),
      parsed.role,
      parsed.teamId,
      parsed.maxBudget ?? null,
      parsed.createdAt,
      new Date().toISOString(),
    );
  }

  private putIdentitySql(sql: SqlStorage, record: IdentityMapRecord): void {
    const parsed = IdentityMapRecordSchema.parse(record);
    sql.exec(
      `INSERT INTO cb_index_identity (
         email_lc, litellm_user_id, teams_json, user_role, origin,
         last_reconciled_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(email_lc) DO UPDATE SET
         litellm_user_id = excluded.litellm_user_id,
         teams_json = excluded.teams_json,
         user_role = excluded.user_role,
         origin = excluded.origin,
         last_reconciled_at = excluded.last_reconciled_at,
         updated_at = excluded.updated_at`,
      parsed.emailLc.toLowerCase(),
      parsed.litellmUserId,
      JSON.stringify(parsed.teams),
      parsed.userRole,
      parsed.origin,
      parsed.lastReconciledAt,
      new Date().toISOString(),
    );
  }

  private putNonceSql(sql: SqlStorage, nonce: MagicLinkNonce): void {
    const parsed = MagicLinkNonceSchema.parse(nonce);
    sql.exec(
      `INSERT INTO cb_index_magic_nonces (token, email, expires_at, consumed_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(token) DO UPDATE SET
         email = excluded.email,
         expires_at = excluded.expires_at,
         consumed_at = excluded.consumed_at,
         updated_at = excluded.updated_at`,
      parsed.token,
      parsed.email,
      parsed.expiresAt,
      parsed.consumedAt,
      new Date().toISOString(),
    );
  }

  private putInviteSql(sql: SqlStorage, record: InviteRecord): void {
    const parsed = InviteRecordSchema.parse(record);
    sql.exec(
      `INSERT INTO cb_index_invites (
         email_lc, team_id, team_role, status, invited_by, created_at, consumed_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(email_lc) DO UPDATE SET
         team_id = excluded.team_id,
         team_role = excluded.team_role,
         status = excluded.status,
         invited_by = excluded.invited_by,
         created_at = excluded.created_at,
         consumed_at = excluded.consumed_at,
         updated_at = excluded.updated_at`,
      parsed.emailLc,
      parsed.teamId,
      parsed.teamRole,
      parsed.status,
      parsed.invitedBy,
      parsed.createdAt,
      parsed.consumedAt,
      new Date().toISOString(),
    );
  }

  private putTenantRoleSql(sql: SqlStorage, record: TenantRoleRecord): void {
    const parsed = TenantRoleRecordSchema.parse(record);
    sql.exec(
      `INSERT INTO cb_index_tenant_roles (
         user_id, team_id, tenant_role, updated_by, updated_at
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, team_id) DO UPDATE SET
         tenant_role = excluded.tenant_role,
         updated_by = excluded.updated_by,
         updated_at = excluded.updated_at`,
      parsed.userId, parsed.teamId, parsed.tenantRole, parsed.updatedBy, parsed.updatedAt,
    );
  }

  private putAuditSql(sql: SqlStorage, event: AuditEvent): void {
    const parsed = AuditEventSchema.parse(event);
    sql.exec(
      `INSERT INTO cb_index_audit_events (
         id, ts, actor_email, action, entity_kind, entity_id, before_json, after_json, reason, impersonation, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         ts = excluded.ts,
         actor_email = excluded.actor_email,
         action = excluded.action,
         entity_kind = excluded.entity_kind,
         entity_id = excluded.entity_id,
         before_json = excluded.before_json,
         after_json = excluded.after_json,
         reason = excluded.reason,
         impersonation = excluded.impersonation,
         created_at = excluded.created_at`,
      parsed.id,
      parsed.ts,
      parsed.actorEmail,
      parsed.action,
      parsed.entityKind,
      parsed.entityId,
      json(parsed.before),
      json(parsed.after),
      parsed.reason,
      parsed.impersonation == null ? null : JSON.stringify(parsed.impersonation),
      parsed.ts,
    );
  }

  private putMetaSql(sql: SqlStorage, key: string, value: unknown): void {
    sql.exec(
      `INSERT INTO cb_index_meta (key, value_json, updated_at)
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
      "SELECT value_json FROM cb_index_meta WHERE key = ?",
      key,
    ));
    return row == null ? fallback : JSON.parse(row.value_json) as T;
  }

  // -------------------------------------------------------------------------
  // Team list
  // -------------------------------------------------------------------------

  async listTeams(): Promise<TeamEntry[]> {
    const sql = await this.sql();
    if (sql !== null) {
      return sql.exec<{ id: string; alias: string }>(
        "SELECT id, alias FROM cb_index_teams ORDER BY position ASC, id ASC",
      ).toArray().map((row) => TeamEntrySchema.parse(row));
    }

    const raw = await this.ctx.storage.get<unknown>(KEY_TEAMS_LIST);
    if (raw == null) return [];
    return TeamListSchema.parse(raw);
  }

  async setTeamsList(list: Array<{ id: string; alias: string }>): Promise<void> {
    const parsed = TeamListSchema.parse(list);
    const sql = await this.sql();
    if (sql !== null) {
      this.putTeamsSql(sql, parsed);
      return;
    }

    await this.ctx.storage.put(KEY_TEAMS_LIST, parsed);
  }

  // -------------------------------------------------------------------------
  // Email <-> user index
  // -------------------------------------------------------------------------

  async getUserByEmail(email: string): Promise<UserRecord | null> {
    if (typeof email !== "string" || email.length === 0) {
      throw new Error("getUserByEmail: email must be a non-empty string");
    }

    const sql = await this.sql();
    if (sql !== null) {
      const row = firstRow(sql.exec<SqlRow>(
        "SELECT * FROM cb_index_users WHERE email_lc = ?",
        email.toLowerCase(),
      ));
      return row == null ? null : userFromRow(row);
    }

    const pointer = await this.ctx.storage.get<unknown>(emailKey(email));
    if (pointer == null) return null;
    const { userId } = EmailPointerSchema.parse(pointer);
    const raw = await this.ctx.storage.get<unknown>(userKey(userId));
    if (raw == null) return null;
    return UserRecordSchema.parse(raw);
  }

  async getUserById(userId: string): Promise<UserRecord | null> {
    if (typeof userId !== "string" || userId.length === 0) {
      throw new Error("getUserById: userId must be a non-empty string");
    }

    const sql = await this.sql();
    if (sql !== null) {
      const row = firstRow(sql.exec<SqlRow>(
        "SELECT * FROM cb_index_users WHERE user_id = ?",
        userId,
      ));
      return row == null ? null : userFromRow(row);
    }

    const raw = await this.ctx.storage.get<unknown>(userKey(userId));
    if (raw == null) return null;
    return UserRecordSchema.parse(raw);
  }

  async putUser(record: UserRecord): Promise<void> {
    const parsed = UserRecordSchema.parse(record);
    const sql = await this.sql();
    if (sql !== null) {
      this.putUserSql(sql, parsed);
      return;
    }

    const pointer = EmailPointerSchema.parse({
      userId: parsed.userId,
      teamId: parsed.teamId,
      role: parsed.role,
    });
    const existingPointer = await this.ctx.storage.get<unknown>(emailKey(parsed.email));
    const staleUserId =
      existingPointer == null
        ? null
        : (() => {
            const p = EmailPointerSchema.parse(existingPointer);
            return p.userId !== parsed.userId ? p.userId : null;
          })();
    await this.ctx.storage.transaction(async (txn) => {
      if (staleUserId != null) {
        await txn.delete(userKey(staleUserId));
      }
      await txn.put(userKey(parsed.userId), parsed);
      await txn.put(emailKey(parsed.email), pointer);
    });
  }

  // -------------------------------------------------------------------------
  // Identity map (authoritative email -> LiteLLM user_id; SQL-only)
  // -------------------------------------------------------------------------

  async getIdentityByEmail(email: string): Promise<IdentityMapRecord | null> {
    if (typeof email !== "string" || email.length === 0) {
      throw new Error("getIdentityByEmail: email must be a non-empty string");
    }
    const sql = await this.sql();
    if (sql === null) throw new Error("getIdentityByEmail: SQL backend required");
    const row = firstRow(sql.exec<SqlRow>(
      "SELECT * FROM cb_index_identity WHERE email_lc = ?",
      email.trim().toLowerCase(),
    ));
    return row == null ? null : identityFromRow(row);
  }

  async getIdentityByUserId(userId: string): Promise<IdentityMapRecord | null> {
    if (typeof userId !== "string" || userId.length === 0) {
      throw new Error("getIdentityByUserId: userId must be a non-empty string");
    }
    const sql = await this.sql();
    if (sql === null) throw new Error("getIdentityByUserId: SQL backend required");
    const row = firstRow(sql.exec<SqlRow>(
      "SELECT * FROM cb_index_identity WHERE litellm_user_id = ? ORDER BY email_lc ASC",
      userId,
    ));
    return row == null ? null : identityFromRow(row);
  }

  async putIdentity(record: IdentityMapRecord): Promise<void> {
    const parsed = IdentityMapRecordSchema.parse(record);
    const sql = await this.sql();
    if (sql === null) throw new Error("putIdentity: SQL backend required");
    this.putIdentitySql(sql, parsed);
  }

  async listIdentities(opts?: { limit?: number; cursor?: string }): Promise<{ identities: IdentityMapRecord[]; cursor: string | undefined }> {
    const limit = opts?.limit ?? 100;
    const sql = await this.sql();
    if (sql === null) throw new Error("listIdentities: SQL backend required");
    const cursor = opts?.cursor ?? null;
    const rows = cursor === null
      ? sql.exec<SqlRow>("SELECT * FROM cb_index_identity ORDER BY email_lc ASC LIMIT ?", limit).toArray()
      : sql.exec<SqlRow>("SELECT * FROM cb_index_identity WHERE email_lc > ? ORDER BY email_lc ASC LIMIT ?", cursor, limit).toArray();
    const identities = rows.map(identityFromRow);
    const last = identities.at(-1);
    return {
      identities,
      cursor: identities.length >= limit && last != null ? last.emailLc : undefined,
    };
  }

  async deleteIdentity(email: string): Promise<void> {
    if (typeof email !== "string" || email.length === 0) {
      throw new Error("deleteIdentity: email must be a non-empty string");
    }
    const sql = await this.sql();
    if (sql === null) throw new Error("deleteIdentity: SQL backend required");
    sql.exec("DELETE FROM cb_index_identity WHERE email_lc = ?", email.trim().toLowerCase());
  }

  // -------------------------------------------------------------------------
  // Invites (admin-invite tenant onboarding)
  // -------------------------------------------------------------------------

  async putInvite(record: InviteRecord): Promise<void> {
    const parsed = InviteRecordSchema.parse(record);
    const sql = await this.sql();
    if (sql !== null) {
      this.putInviteSql(sql, parsed);
      return;
    }
    await this.ctx.storage.put(inviteKey(parsed.emailLc), parsed);
  }

  async getInvite(emailLc: string): Promise<InviteRecord | null> {
    if (typeof emailLc !== "string" || emailLc.length === 0) {
      throw new Error("getInvite: emailLc must be a non-empty string");
    }
    const key = emailLc.toLowerCase();
    const sql = await this.sql();
    if (sql !== null) {
      const row = firstRow(sql.exec<SqlRow>(
        "SELECT * FROM cb_index_invites WHERE email_lc = ?",
        key,
      ));
      return row == null ? null : inviteFromRow(row);
    }
    const raw = await this.ctx.storage.get<unknown>(inviteKey(key));
    if (raw == null) return null;
    return InviteRecordSchema.parse(raw);
  }

  async listInvites(opts?: { status?: "pending" | "consumed" | "revoked" }): Promise<InviteRecord[]> {
    const status = opts?.status;
    const sql = await this.sql();
    if (sql !== null) {
      const rows = status == null
        ? sql.exec<SqlRow>("SELECT * FROM cb_index_invites ORDER BY email_lc ASC").toArray()
        : sql.exec<SqlRow>(
          "SELECT * FROM cb_index_invites WHERE status = ? ORDER BY email_lc ASC",
          status,
        ).toArray();
      return rows.map(inviteFromRow);
    }
    const entries = await this.ctx.storage.list<unknown>({ prefix: "invite:" });
    const invites: InviteRecord[] = [];
    for (const raw of entries.values()) {
      const inv = InviteRecordSchema.parse(raw);
      if (status == null || inv.status === status) invites.push(inv);
    }
    invites.sort((a, b) => a.emailLc.localeCompare(b.emailLc));
    return invites;
  }

  // Idempotent: only a pending invite transitions to consumed. A second call
  // (or a call on a non-pending invite) returns the current record unchanged
  // so concurrent logins cannot double-consume.
  async markInviteConsumed(emailLc: string): Promise<InviteRecord | null> {
    const current = await this.getInvite(emailLc);
    if (current == null) return null;
    if (current.status !== "pending") return current;
    const consumed: InviteRecord = {
      ...current,
      status: "consumed",
      consumedAt: new Date().toISOString(),
    };
    await this.putInvite(consumed);
    return consumed;
  }

  // pending/revoked → revoked. A consumed invite is returned unchanged so the
  // caller can map it to 409 (revoking does not un-join an already-joined user).
  async revokeInvite(emailLc: string): Promise<InviteRecord | null> {
    const current = await this.getInvite(emailLc);
    if (current == null) return null;
    if (current.status === "consumed") return current;
    if (current.status === "revoked") return current;
    const revoked: InviteRecord = { ...current, status: "revoked" };
    await this.putInvite(revoked);
    return revoked;
  }

  // -------------------------------------------------------------------------
  // Tenant roles (portal-level, decoupled from LiteLLM user_role)
  // -------------------------------------------------------------------------

  async putTenantRole(record: TenantRoleRecord): Promise<void> {
    const parsed = TenantRoleRecordSchema.parse(record);
    const sql = await this.sql();
    if (sql !== null) {
      this.putTenantRoleSql(sql, parsed);
      return;
    }
    await this.ctx.storage.put(tenantRoleKey(parsed.userId, parsed.teamId), parsed);
  }

  async getTenantRole(userId: string, teamId: string): Promise<TenantRoleRecord | null> {
    if (typeof userId !== "string" || userId.length === 0) {
      throw new Error("getTenantRole: userId must be a non-empty string");
    }
    if (typeof teamId !== "string" || teamId.length === 0) {
      throw new Error("getTenantRole: teamId must be a non-empty string");
    }
    const sql = await this.sql();
    if (sql !== null) {
      const row = firstRow(sql.exec<SqlRow>(
        "SELECT * FROM cb_index_tenant_roles WHERE user_id = ? AND team_id = ?",
        userId, teamId,
      ));
      return row == null ? null : tenantRoleFromRow(row);
    }
    const raw = await this.ctx.storage.get<unknown>(tenantRoleKey(userId, teamId));
    return raw == null ? null : TenantRoleRecordSchema.parse(raw);
  }

  async listTenantRoles(opts?: { teamId?: string }): Promise<TenantRoleRecord[]> {
    const teamId = opts?.teamId;
    const sql = await this.sql();
    if (sql !== null) {
      const rows = teamId == null
        ? sql.exec<SqlRow>("SELECT * FROM cb_index_tenant_roles ORDER BY team_id, user_id").toArray()
        : sql.exec<SqlRow>(
          "SELECT * FROM cb_index_tenant_roles WHERE team_id = ? ORDER BY user_id",
          teamId,
        ).toArray();
      return rows.map(tenantRoleFromRow);
    }
    const entries = await this.ctx.storage.list<unknown>({ prefix: "trole:" });
    const out: TenantRoleRecord[] = [];
    for (const raw of entries.values()) {
      const rec = TenantRoleRecordSchema.parse(raw);
      if (teamId == null || rec.teamId === teamId) out.push(rec);
    }
    return out.sort((a, b) =>
      a.teamId === b.teamId ? a.userId.localeCompare(b.userId) : a.teamId.localeCompare(b.teamId));
  }

  // -------------------------------------------------------------------------
  // Impersonation session ledger (Owner-as-tenant; Ops Console)
  // -------------------------------------------------------------------------

  async putImpersonationSession(record: ImpersonationSession): Promise<void> {
    const parsed = ImpersonationSessionSchema.parse(record);
    const sql = await this.sql();
    if (sql !== null) {
      sql.exec(
        `INSERT OR REPLACE INTO cb_index_impersonation
           (real_actor, effective_team_id, started_at, ended_at)
         VALUES (?, ?, ?, ?)`,
        parsed.realActor, parsed.effectiveTeamId, parsed.startedAt, parsed.endedAt,
      );
      return;
    }
    await this.ctx.storage.put(
      `imp:${parsed.realActor}:${parsed.startedAt}`,
      parsed,
    );
  }

  async getActiveImpersonationSession(realActor: string): Promise<ImpersonationSession | null> {
    if (typeof realActor !== "string" || realActor.length === 0) {
      throw new Error("getActiveImpersonationSession: realActor must be a non-empty string");
    }
    const sql = await this.sql();
    if (sql !== null) {
      const row = firstRow(sql.exec<SqlRow>(
        `SELECT * FROM cb_index_impersonation
           WHERE real_actor = ? AND ended_at IS NULL
           ORDER BY started_at DESC LIMIT 1`,
        realActor,
      ));
      if (row == null) return null;
      return ImpersonationSessionSchema.parse({
        realActor: String(row.real_actor),
        effectiveTeamId: String(row.effective_team_id),
        startedAt: String(row.started_at),
        endedAt: row.ended_at == null ? null : String(row.ended_at),
      });
    }
    const entries = await this.ctx.storage.list<unknown>({ prefix: `imp:${realActor}:`, reverse: true });
    for (const raw of entries.values()) {
      const rec = ImpersonationSessionSchema.parse(raw);
      if (rec.endedAt == null) return rec;
    }
    return null;
  }

  async endImpersonationSession(realActor: string): Promise<void> {
    const active = await this.getActiveImpersonationSession(realActor);
    if (active == null) return;
    await this.putImpersonationSession({ ...active, endedAt: new Date().toISOString() });
  }

  // -------------------------------------------------------------------------
  // Magic-link nonces
  // -------------------------------------------------------------------------

  async storeNonce(nonce: MagicLinkNonce): Promise<void> {
    const parsed = MagicLinkNonceSchema.parse(nonce);
    const sql = await this.sql();
    if (sql !== null) {
      this.putNonceSql(sql, parsed);
    } else {
      await this.ctx.storage.put(nonceKey(parsed.token), parsed);
    }

    const expiresMs = new Date(parsed.expiresAt).getTime();
    const currentAlarm = await this.ctx.storage.getAlarm();
    if (currentAlarm == null || expiresMs < currentAlarm) {
      await this.ctx.storage.setAlarm(expiresMs);
    }
  }

  async consumeNonce(token: string): Promise<MagicLinkNonce | null> {
    if (typeof token !== "string" || token.length === 0) {
      throw new Error("consumeNonce: token must be a non-empty string");
    }

    const sql = await this.sql();
    if (sql !== null) {
      const row = firstRow(sql.exec<SqlRow>(
        "SELECT * FROM cb_index_magic_nonces WHERE token = ?",
        token,
      ));
      if (row == null) return null;
      const nonce = nonceFromRow(row);
      if (nonce.consumedAt != null) return null;
      if (new Date(nonce.expiresAt).getTime() <= Date.now()) return null;
      const consumed: MagicLinkNonce = { ...nonce, consumedAt: new Date().toISOString() };
      this.putNonceSql(sql, consumed);
      return consumed;
    }

    const raw = await this.ctx.storage.get<unknown>(nonceKey(token));
    if (raw == null) return null;

    const nonce = MagicLinkNonceSchema.parse(raw);

    if (nonce.consumedAt != null) return null;
    if (new Date(nonce.expiresAt).getTime() <= Date.now()) return null;

    const consumed: MagicLinkNonce = { ...nonce, consumedAt: new Date().toISOString() };
    await this.ctx.storage.put(nonceKey(token), consumed);
    return consumed;
  }

  // -------------------------------------------------------------------------
  // Audit log
  // -------------------------------------------------------------------------

  async appendAudit(event: AuditEvent): Promise<void> {
    const parsed = AuditEventSchema.parse(event);
    const sql = await this.sql();
    if (sql !== null) {
      this.putAuditSql(sql, parsed);
      return;
    }

    await this.ctx.storage.put(auditKey(parsed.ts, parsed.id), parsed);
  }

  async listAllUsers(opts?: { limit?: number; cursor?: string }): Promise<{ users: UserRecord[]; cursor: string | undefined }> {
    const limit = opts?.limit ?? 50;
    const sql = await this.sql();
    if (sql !== null) {
      const cursor = cursorUserId(opts?.cursor);
      const rows = cursor === null
        ? sql.exec<SqlRow>("SELECT * FROM cb_index_users ORDER BY user_id ASC LIMIT ?", limit).toArray()
        : sql.exec<SqlRow>("SELECT * FROM cb_index_users WHERE user_id > ? ORDER BY user_id ASC LIMIT ?", cursor, limit).toArray();
      const users = rows.map(userFromRow);
      const last = users.at(-1);
      return { users, cursor: users.length >= limit && last != null ? userKey(last.userId) : undefined };
    }

    const entries = await this.ctx.storage.list<unknown>({
      prefix: "user:",
      limit,
      ...(opts?.cursor != null ? { startAfter: opts.cursor } : {}),
    });
    const users: UserRecord[] = [];
    let lastKey: string | undefined;
    for (const [key, raw] of entries) {
      users.push(UserRecordSchema.parse(raw));
      lastKey = key;
    }
    const cursor = entries.size >= limit ? lastKey : undefined;
    return { users, cursor };
  }

  async listAudit(opts?: { limit?: number; before?: string }): Promise<AuditEvent[]> {
    const limit = opts?.limit ?? 50;
    const before = opts?.before;
    const sql = await this.sql();
    if (sql !== null) {
      const rows = before == null
        ? sql.exec<SqlRow>(
          "SELECT * FROM cb_index_audit_events ORDER BY ts DESC, id DESC LIMIT ?",
          limit,
        ).toArray()
        : sql.exec<SqlRow>(
          "SELECT * FROM cb_index_audit_events WHERE ts < ? ORDER BY ts DESC, id DESC LIMIT ?",
          before,
          limit,
        ).toArray();
      return rows.map(auditFromRow);
    }

    const entries = await this.ctx.storage.list<unknown>({ prefix: "audit:", reverse: true, limit: limit * 2 });
    const results: AuditEvent[] = [];

    for (const [key, raw] of entries) {
      if (results.length >= limit) break;
      if (before != null && key >= `audit:${before}`) continue;
      results.push(AuditEventSchema.parse(raw));
    }

    return results;
  }

  // -------------------------------------------------------------------------
  // Bootstrap meta
  // -------------------------------------------------------------------------

  async isImported(): Promise<boolean> {
    const sql = await this.sql();
    if (sql !== null) {
      return this.getMetaSql<boolean>(sql, "imported", false);
    }

    const raw = await this.ctx.storage.get<unknown>(KEY_META_IMPORTED);
    return raw === true;
  }

  async markImported(): Promise<void> {
    const sql = await this.sql();
    if (sql !== null) {
      this.putMetaSql(sql, "imported", true);
      return;
    }

    await this.ctx.storage.put(KEY_META_IMPORTED, true);
  }

  async getBootstrapAdmins(): Promise<string[]> {
    const sql = await this.sql();
    if (sql !== null) {
      return z.array(z.string()).parse(this.getMetaSql(sql, "bootstrapAdmins", []));
    }

    const raw = await this.ctx.storage.get<unknown>(KEY_META_BOOTSTRAP_ADMINS);
    if (raw == null) return [];
    return z.array(z.string()).parse(raw);
  }

  async setBootstrapAdmins(emails: string[]): Promise<void> {
    const parsed = z.array(z.string()).parse(emails);
    const sql = await this.sql();
    if (sql !== null) {
      this.putMetaSql(sql, "bootstrapAdmins", parsed);
      return;
    }

    await this.ctx.storage.put(KEY_META_BOOTSTRAP_ADMINS, parsed);
  }

  // -------------------------------------------------------------------------
  // Migration and cleanup helpers
  // -------------------------------------------------------------------------

  async getStorageMigrationState(): Promise<StorageMigrationState> {
    const sql = await this.sql();
    const legacyKeys = await this.countLegacyKVKeys();
    if (sql === null) {
      return {
        backend: "kv",
        teams: 0,
        users: 0,
        nonces: 0,
        auditEvents: 0,
        legacyKeys,
        legacyKvDeleted: false,
      };
    }

    return {
      backend: "sql",
      teams: this.countSql(sql, "cb_index_teams"),
      users: this.countSql(sql, "cb_index_users"),
      nonces: this.countSql(sql, "cb_index_magic_nonces"),
      auditEvents: this.countSql(sql, "cb_index_audit_events"),
      legacyKeys,
      legacyKvDeleted: this.getMetaSql<boolean>(sql, SQL_LEGACY_KV_DELETED_META_KEY, false),
    };
  }

  async deleteLegacyKV(): Promise<{ deleted: number; skipped: boolean }> {
    const sql = await this.sql();
    if (sql === null) return { deleted: 0, skipped: true };

    let deleted = 0;
    deleted += await this.deleteKeyIfPresent(KEY_TEAMS_LIST);
    deleted += await this.deleteKeyIfPresent(KEY_META_IMPORTED);
    deleted += await this.deleteKeyIfPresent(KEY_META_BOOTSTRAP_ADMINS);
    deleted += await this.deleteKeysByPrefix("email:");
    deleted += await this.deleteKeysByPrefix("user:");
    deleted += await this.deleteKeysByPrefix("nonce:");
    deleted += await this.deleteKeysByPrefix("audit:");
    this.putMetaSql(sql, SQL_LEGACY_KV_DELETED_META_KEY, true);
    return { deleted, skipped: false };
  }

  private countSql(sql: SqlStorage, table: string): number {
    const row = firstRow(sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`));
    return row?.n ?? 0;
  }

  private async countLegacyKVKeys(): Promise<number> {
    let count = 0;
    count += (await this.ctx.storage.list({ prefix: "email:" })).size;
    count += (await this.ctx.storage.list({ prefix: "user:" })).size;
    count += (await this.ctx.storage.list({ prefix: "nonce:" })).size;
    count += (await this.ctx.storage.list({ prefix: "audit:" })).size;
    count += await this.hasKey(KEY_TEAMS_LIST);
    count += await this.hasKey(KEY_META_IMPORTED);
    count += await this.hasKey(KEY_META_BOOTSTRAP_ADMINS);
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

  // -------------------------------------------------------------------------
  // Init: one-shot LiteLLM import orchestration (PDCSOT-46 / T-6.5)
  // -------------------------------------------------------------------------

  async init(): Promise<{ ok: true; imported: boolean }> {
    if (await this.isImported()) {
      return { ok: true, imported: true };
    }

    const teams = await importTeams(this.env);
    const users = await importUsers(this.env);
    const bootstrap = await applyBootstrapAdmins(this.env);

    await finalizeImport(this.env, {
      teamCount: teams.insertedTeams,
      userCount: users.insertedUsers,
      bootstrapAdmins: {
        configured: bootstrap.configuredEmails,
        promoted: bootstrap.promotedToAdmin,
        absentFromIndex: bootstrap.absentFromIndex.length,
      },
      errors: [
        ...teams.errors.map((e) => ({ entityId: e.teamId, reason: e.reason })),
        ...users.errors.map((e) => ({ entityId: e.userId, reason: e.reason })),
      ],
    });

    return { ok: true, imported: true };
  }

  // -------------------------------------------------------------------------
  // Alarm: clean up expired nonces and reschedule if more remain
  // -------------------------------------------------------------------------

  override async alarm(): Promise<void> {
    const sql = await this.sql();
    if (sql !== null) {
      const nowIso = new Date().toISOString();
      sql.exec("DELETE FROM cb_index_magic_nonces WHERE expires_at <= ?", nowIso);
      const next = firstRow(sql.exec<{ expires_at: string }>(
        "SELECT expires_at FROM cb_index_magic_nonces WHERE expires_at > ? ORDER BY expires_at ASC LIMIT 1",
        nowIso,
      ));
      if (next != null) {
        await this.ctx.storage.setAlarm(new Date(next.expires_at).getTime());
      }
      return;
    }

    const now = Date.now();
    const entries = await this.ctx.storage.list<unknown>({ prefix: "nonce:" });

    let nextAlarm: number | null = null;

    for (const [key, raw] of entries) {
      const nonce = MagicLinkNonceSchema.parse(raw);
      const expiresMs = new Date(nonce.expiresAt).getTime();
      if (expiresMs <= now) {
        await this.ctx.storage.delete(key);
      } else {
        if (nextAlarm == null || expiresMs < nextAlarm) {
          nextAlarm = expiresMs;
        }
      }
    }

    if (nextAlarm != null) {
      await this.ctx.storage.setAlarm(nextAlarm);
    }
  }
}
