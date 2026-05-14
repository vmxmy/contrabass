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

  async putTeam(record: TeamRecord): Promise<void> {
    TeamRecordSchema.parse(record);
    await this.ctx.storage.transaction(async (txn) => {
      await txn.put("team", record);
      await txn.put("meta:dirty", true);
    });
  }

  // ---------------------------------------------------------------------------
  // Members
  // ---------------------------------------------------------------------------

  async listMembers(): Promise<Member[]> {
    const map = await this.ctx.storage.list<Member>({ prefix: "members:" });
    return Array.from(map.values());
  }

  async upsertMember(member: Member): Promise<void> {
    MemberSchema.parse(member);
    await this.ctx.storage.transaction(async (txn) => {
      await txn.put(`members:${member.userId}`, member);
      await txn.put("meta:dirty", true);
    });
  }

  async removeMember(userId: string): Promise<void> {
    await this.ctx.storage.transaction(async (txn) => {
      await txn.delete(`members:${userId}`);
      await txn.put("meta:dirty", true);
    });
  }

  // ---------------------------------------------------------------------------
  // Keys
  // ---------------------------------------------------------------------------

  async listKeys(): Promise<KeyRecord[]> {
    const map = await this.ctx.storage.list<KeyRecord>({ prefix: "keys:" });
    return Array.from(map.values());
  }

  async upsertKey(record: KeyRecord): Promise<void> {
    KeyRecordSchema.parse(record);
    await this.ctx.storage.transaction(async (txn) => {
      await txn.put(`keys:${record.id}`, record);
      await txn.put("meta:dirty", true);
    });
  }

  async deleteKey(id: string): Promise<void> {
    await this.ctx.storage.transaction(async (txn) => {
      await txn.delete(`keys:${id}`);
      await txn.put("meta:dirty", true);
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
      await txn.put("meta:lastSyncedAt", new Date().toISOString());
      await txn.delete("meta:lastSyncError");
      await txn.put("meta:dirty", false);
      await txn.put("meta:lastIdempotencyKey", idempotencyKey);
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
