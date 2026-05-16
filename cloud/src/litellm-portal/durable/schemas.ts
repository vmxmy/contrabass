import { z } from "zod";

// ---------------------------------------------------------------------------
// Durable Object storage records
// ---------------------------------------------------------------------------

export const TeamRecordSchema = z.object({
  id: z.string(),
  alias: z.string(),
  models: z.array(z.string()),
  maxBudget: z.number().optional(),
  tpmLimit: z.number().optional(),
  rpmLimit: z.number().optional(),
  blocked: z.boolean(),
  budgetDuration: z.string().optional(),
  budgetResetAt: z.string().datetime().optional(),
}).strict();

export type TeamRecord = z.infer<typeof TeamRecordSchema>;

export const UserRecordSchema = z.object({
  userId: z.string(),
  email: z.string(),
  role: z.enum(["admin", "user"]),
  teamId: z.string().nullable(),
  maxBudget: z.number().optional(),
  createdAt: z.string().datetime(),
}).strict();

export type UserRecord = z.infer<typeof UserRecordSchema>;

export const InviteRecordSchema = z.object({
  emailLc: z.string(),
  teamId: z.string(),
  teamRole: z.enum(["admin", "user"]),
  status: z.enum(["pending", "consumed", "revoked"]),
  invitedBy: z.string(),
  createdAt: z.string().datetime(),
  consumedAt: z.string().datetime().nullable(),
}).strict();

export type InviteRecord = z.infer<typeof InviteRecordSchema>;

export const KeyRecordSchema = z.object({
  id: z.string(),
  alias: z.string(),
  displayKey: z.string(),
  userId: z.string(),
  teamId: z.string().nullable(),
  models: z.array(z.string()),
  maxBudget: z.number().optional(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime().nullable().optional(),
  blocked: z.boolean(),
}).strict();

export type KeyRecord = z.infer<typeof KeyRecordSchema>;

export const SpendSnapshotSchema = z.object({
  teamId: z.string(),
  currentSpend: z.number(),
  maxBudget: z.number().nullable(),
  fetchedAt: z.string().datetime(),
}).strict();

export type SpendSnapshot = z.infer<typeof SpendSnapshotSchema>;

export const TeamAlertWebhookSchema = z.object({
  url: z.string().url(),
  updatedAt: z.string().datetime(),
  updatedBy: z.string(),
}).strict();

export type TeamAlertWebhook = z.infer<typeof TeamAlertWebhookSchema>;

export const MagicLinkNonceSchema = z.object({
  token: z.string(),
  email: z.string(),
  expiresAt: z.string().datetime(),
  consumedAt: z.string().datetime().nullable(),
}).strict();

export type MagicLinkNonce = z.infer<typeof MagicLinkNonceSchema>;

export const AuditEventSchema = z.object({
  id: z.string(),
  ts: z.string().datetime(),
  actorEmail: z.string(),
  action: z.string(),
  entityKind: z.string(),
  entityId: z.string(),
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  reason: z.string().nullable(),
}).strict();

export type AuditEvent = z.infer<typeof AuditEventSchema>;

export const SyncMessageSchema = z.object({
  kind: z.enum(["team.update", "user.update", "key.generate", "key.delete", "key.update"]),
  entityId: z.string(),
  payload: z.unknown(),
  idempotencyKey: z.string(),
  enqueuedAt: z.string().datetime(),
}).strict();

export type SyncMessage = z.infer<typeof SyncMessageSchema>;
