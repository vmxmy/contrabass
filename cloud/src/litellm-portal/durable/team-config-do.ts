import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import {
  KeyRecordSchema,
  SpendSnapshotSchema,
  TeamRecordSchema,
  type KeyRecord,
  type SpendSnapshot,
  type TeamRecord,
} from "./schemas";
import type { LiteLLMPortalEnv } from "../types";

const MemberSchema = z.object({
  userId: z.string(),
  role: z.enum(["admin", "user"]),
}).strict();

type Member = z.infer<typeof MemberSchema>;

export class TeamConfigDO extends DurableObject<LiteLLMPortalEnv> {
  // ---------------------------------------------------------------------------
  // Team metadata
  // ---------------------------------------------------------------------------

  async getTeam(): Promise<TeamRecord | null> {
    return (await this.ctx.storage.get<TeamRecord>("team")) ?? null;
  }

  async putTeam(record: TeamRecord, idempotencyKey?: string): Promise<void> {
    TeamRecordSchema.parse(record);
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
    const map = await this.ctx.storage.list<Member>({ prefix: "members:" });
    return Array.from(map.values());
  }

  async upsertMember(member: Member, idempotencyKey?: string): Promise<void> {
    MemberSchema.parse(member);
    await this.ctx.storage.transaction(async (txn) => {
      await txn.put(`members:${member.userId}`, member);
      await txn.put("meta:dirty", true);
      if (idempotencyKey) {
        await txn.put("meta:pendingIdempotencyKey", idempotencyKey);
      }
    });
  }

  async removeMember(userId: string, idempotencyKey?: string): Promise<void> {
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
    const map = await this.ctx.storage.list<KeyRecord>({ prefix: "keys:" });
    return Array.from(map.values());
  }

  async upsertKey(record: KeyRecord, idempotencyKey?: string): Promise<void> {
    KeyRecordSchema.parse(record);
    await this.ctx.storage.transaction(async (txn) => {
      await txn.put(`keys:${record.id}`, record);
      await txn.put("meta:dirty", true);
      if (idempotencyKey) {
        await txn.put("meta:pendingIdempotencyKey", idempotencyKey);
      }
    });
  }

  async deleteKey(id: string, idempotencyKey?: string): Promise<void> {
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
    return (await this.ctx.storage.get<SpendSnapshot>("spend:current")) ?? null;
  }

  async putSpend(snapshot: SpendSnapshot): Promise<void> {
    SpendSnapshotSchema.parse(snapshot);
    await this.ctx.storage.put("spend:current", snapshot);
  }

  async recordSpendError(reason: string): Promise<void> {
    await this.ctx.storage.put("meta:lastSpendError", reason.slice(0, 200));
  }

  // ---------------------------------------------------------------------------
  // Sync metadata (used by queue consumer)
  // ---------------------------------------------------------------------------

  async recordSyncSuccess(idempotencyKey: string): Promise<void> {
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
    await this.ctx.storage.put("meta:lastSyncError", reason.slice(0, 200));
  }

  async getSyncMetadata(): Promise<{
    lastSyncedAt: string | null;
    lastSyncError: string | null;
    dirty: boolean;
  }> {
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
}
