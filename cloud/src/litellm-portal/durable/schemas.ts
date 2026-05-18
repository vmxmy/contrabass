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

// Authoritative business→LiteLLM identity map. Keyed by the normalized
// (lowercased, trimmed) email — the only stable business join key — because the
// LiteLLM user_id is an arbitrary, non-derivable identifier (human slug, UUID,
// or special account) that cannot be reconstructed from the email. Separate
// authority from UserRecord so the role-cache / importer write tuple is
// untouched. `origin` records how litellmUserId was established:
//   "deterministic" — portal provisioned via POST /user/new with our id
//   "recorded"      — observed from LiteLLM (importer / on-demand resolve)
//   "migrated"      — controlled zero-spend migration repointed it
export const IdentityMapRecordSchema = z.object({
  emailLc: z.string(),
  litellmUserId: z.string(),
  teams: z.array(z.string()),
  userRole: z.string().nullable(),
  origin: z.enum(["deterministic", "recorded", "migrated"]),
  lastReconciledAt: z.string().datetime(),
}).strict();

export type IdentityMapRecord = z.infer<typeof IdentityMapRecordSchema>;

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

export const TenantRoleRecordSchema = z.object({
  userId: z.string(),
  teamId: z.string(),
  tenantRole: z.enum(["tenant_admin", "member"]),
  updatedBy: z.string(),
  updatedAt: z.string().datetime(),
}).strict();

export type TenantRoleRecord = z.infer<typeof TenantRoleRecordSchema>;

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

export const ImpersonationSessionSchema = z.object({
  realActor: z.string(),
  effectiveTeamId: z.string(),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable(),
}).strict();
export type ImpersonationSession = z.infer<typeof ImpersonationSessionSchema>;

export const MagicLinkNonceSchema = z.object({
  token: z.string(),
  email: z.string(),
  expiresAt: z.string().datetime(),
  consumedAt: z.string().datetime().nullable(),
}).strict();

export type MagicLinkNonce = z.infer<typeof MagicLinkNonceSchema>;

export const ImpersonationAuditEnvelopeSchema = z
  .object({
    realActor: z.string(),
    effectiveTeam: z.string(),
    viaImpersonation: z.literal(true),
  })
  .strict();

export type ImpersonationAuditEnvelope = z.infer<typeof ImpersonationAuditEnvelopeSchema>;

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
  impersonation: ImpersonationAuditEnvelopeSchema.nullable().optional(),
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
