import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import {
  UserRecordSchema,
  type UserRecord,
  MagicLinkNonceSchema,
  type MagicLinkNonce,
  AuditEventSchema,
  type AuditEvent,
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

function emailKey(email: string): string {
  return `email:${email.toLowerCase()}`;
}

function userKey(userId: string): string {
  return `user:${userId}`;
}

function nonceKey(token: string): string {
  return `nonce:${token}`;
}

function auditKey(ts: string, id: string): string {
  return `audit:${ts}:${id}`;
}

// ---------------------------------------------------------------------------
// IndexDO
// ---------------------------------------------------------------------------

export class IndexDO extends DurableObject<LiteLLMPortalEnv> {
  // -------------------------------------------------------------------------
  // Team list
  // -------------------------------------------------------------------------

  async listTeams(): Promise<TeamEntry[]> {
    const raw = await this.ctx.storage.get<unknown>(KEY_TEAMS_LIST);
    if (raw == null) return [];
    return TeamListSchema.parse(raw);
  }

  async setTeamsList(list: Array<{ id: string; alias: string }>): Promise<void> {
    const parsed = TeamListSchema.parse(list);
    await this.ctx.storage.put(KEY_TEAMS_LIST, parsed);
  }

  // -------------------------------------------------------------------------
  // Email <-> user index
  // -------------------------------------------------------------------------

  async getUserByEmail(email: string): Promise<UserRecord | null> {
    if (typeof email !== "string" || email.length === 0) {
      throw new Error("getUserByEmail: email must be a non-empty string");
    }
    const pointer = await this.ctx.storage.get<unknown>(emailKey(email));
    if (pointer == null) return null;
    const { userId } = EmailPointerSchema.parse(pointer);
    const raw = await this.ctx.storage.get<unknown>(userKey(userId));
    if (raw == null) return null;
    return UserRecordSchema.parse(raw);
  }

  async putUser(record: UserRecord): Promise<void> {
    const parsed = UserRecordSchema.parse(record);
    const pointer = EmailPointerSchema.parse({
      userId: parsed.userId,
      teamId: parsed.teamId,
      role: parsed.role,
    });
    await this.ctx.storage.transaction(async (txn) => {
      await txn.put(userKey(parsed.userId), parsed);
      await txn.put(emailKey(parsed.email), pointer);
    });
  }

  // -------------------------------------------------------------------------
  // Magic-link nonces
  // -------------------------------------------------------------------------

  async storeNonce(nonce: MagicLinkNonce): Promise<void> {
    const parsed = MagicLinkNonceSchema.parse(nonce);
    await this.ctx.storage.put(nonceKey(parsed.token), parsed);

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
    await this.ctx.storage.put(auditKey(parsed.ts, parsed.id), parsed);
  }

  async listAllUsers(opts?: { limit?: number; cursor?: string }): Promise<{ users: UserRecord[]; cursor: string | undefined }> {
    const limit = opts?.limit ?? 50;
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
    const raw = await this.ctx.storage.get<unknown>(KEY_META_IMPORTED);
    return raw === true;
  }

  async markImported(): Promise<void> {
    await this.ctx.storage.put(KEY_META_IMPORTED, true);
  }

  async getBootstrapAdmins(): Promise<string[]> {
    const raw = await this.ctx.storage.get<unknown>(KEY_META_BOOTSTRAP_ADMINS);
    if (raw == null) return [];
    return z.array(z.string()).parse(raw);
  }

  async setBootstrapAdmins(emails: string[]): Promise<void> {
    const parsed = z.array(z.string()).parse(emails);
    await this.ctx.storage.put(KEY_META_BOOTSTRAP_ADMINS, parsed);
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
