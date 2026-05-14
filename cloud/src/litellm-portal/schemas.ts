import { z } from "zod";

// ---------------------------------------------------------------------------
// Primitive helpers
// ---------------------------------------------------------------------------

const nullableString = z.string().nullable();
const nullableNumber = z.number().nullable();

// ---------------------------------------------------------------------------
// /api/me
// ---------------------------------------------------------------------------

export const MeSchema = z.object({
  email: z.string(),
  userId: z.string(),
  company: z.string(),
  domain: z.string(),
  role: z.enum(["admin", "user", "none"]),
});

export type Me = z.infer<typeof MeSchema>;


// ---------------------------------------------------------------------------
// /api/me/preferences and /api/admin/preferences-defaults
// ---------------------------------------------------------------------------

export const UserPreferencesNotificationsSchema = z.object({
  budgetThresholdEnabled: z.boolean().default(true),
  budgetThreshold: z.number().min(0).max(1).default(0.8),
  keyExpirySoon: z.boolean().default(true),
  keyCreation: z.boolean().default(true),
});

const DefaultUserPreferencesNotifications = {
  budgetThresholdEnabled: true,
  budgetThreshold: 0.8,
  keyExpirySoon: true,
  keyCreation: true,
} satisfies z.infer<typeof UserPreferencesNotificationsSchema>;

export const UserPreferencesSchema = z.object({
  theme: z.enum(["auto", "dark", "light"]).default("auto"),
  defaultTab: z.enum(["user", "admin"]).default("user"),
  defaultUsageWindow: z.enum(["6h", "24h", "48h", "7d", "30d", "12mo"]).default("30d"),
  language: z.enum(["auto", "zh-CN", "en"]).default("auto"),
  density: z.enum(["comfortable", "compact"]).default("comfortable"),
  notifications: UserPreferencesNotificationsSchema.default(DefaultUserPreferencesNotifications),
});

export const UserPreferencesPatchSchema = z.object({
  theme: z.enum(["auto", "dark", "light"]).optional(),
  defaultTab: z.enum(["user", "admin"]).optional(),
  defaultUsageWindow: z.enum(["6h", "24h", "48h", "7d", "30d", "12mo"]).optional(),
  language: z.enum(["auto", "zh-CN", "en"]).optional(),
  density: z.enum(["comfortable", "compact"]).optional(),
  notifications: z.object({
    budgetThresholdEnabled: z.boolean().optional(),
    budgetThreshold: z.number().min(0).max(1).optional(),
    keyExpirySoon: z.boolean().optional(),
    keyCreation: z.boolean().optional(),
  }).strict().optional(),
}).strict();

export type UserPreferences = z.infer<typeof UserPreferencesSchema>;
export type UserPreferencesPatch = z.infer<typeof UserPreferencesPatchSchema>;

// ---------------------------------------------------------------------------
// /api/dashboard sub-shapes
// ---------------------------------------------------------------------------

export const DashboardMeSchema = z.object({
  email: nullableString.optional(),
  domain: nullableString.optional(),
  company: nullableString.optional(),
});

export const DashboardUserSchema = z.object({
  litellmUserId: nullableString.optional(),
  litellmUserFound: z.boolean().optional(),
  totalSpend: nullableNumber.optional(),
  maxBudget: nullableNumber.optional(),
});

export const DashboardSummarySchema = z.object({
  totalSpend: nullableNumber.optional(),
  recentSpend: nullableNumber.optional(),
  keySpend: nullableNumber.optional(),
  keyBudget: nullableNumber.optional(),
  keyCount: z.number().nullable().optional(),
  availableModelCount: z.number().nullable().optional(),
  teamCount: z.number().nullable().optional(),
  totalTokens: z.number().nullable().optional(),
  requestCount: z.number().nullable().optional(),
});

export const DashboardTeamSchema = z.object({
  id: nullableString.optional(),
  alias: nullableString.optional(),
  models: z.array(z.string()).nullable().optional(),
  spend: nullableNumber.optional(),
  maxBudget: nullableNumber.optional(),
  tpmLimit: nullableNumber.optional(),
  rpmLimit: nullableNumber.optional(),
});

export const DashboardKeySchema = z.object({
  id: nullableString.optional(),
  alias: nullableString.optional(),
  displayKey: nullableString.optional(),
  userId: nullableString.optional(),
  teamId: nullableString.optional(),
  models: z.array(z.string()).optional(),
  spend: nullableNumber.optional(),
  maxBudget: nullableNumber.optional(),
  expiresAt: nullableString.optional(),
  createdAt: nullableString.optional(),
  blocked: z.boolean().nullable().optional(),
  lastSyncedAt: z.string().datetime().optional(),
  lastSyncError: z.string().nullable().optional(),
  dirty: z.boolean().optional(),
});

export const DashboardModelsSchema = z.object({
  models: z.array(z.string()).optional(),
  source: z.string().optional(),
  teamIds: z.array(z.string()).optional(),
});

export const DashboardUsageSchema = z.object({
  available: z.boolean().optional(),
  totalSpend: z.number().optional(),
  totalTokens: z.number().optional(),
  requestCount: z.number().optional(),
  topModels: z.array(z.object({
    model: z.string(),
    spend: z.number(),
    totalTokens: z.number(),
    requests: z.number(),
  })).optional(),
});

export const DashboardSchema = z.object({
  me: DashboardMeSchema.optional(),
  user: DashboardUserSchema.optional(),
  summary: DashboardSummarySchema.optional(),
  models: DashboardModelsSchema.optional(),
  teams: z.array(DashboardTeamSchema).optional(),
  keys: z.object({
    totalCount: z.number().optional(),
    items: z.array(DashboardKeySchema).optional(),
  }).optional(),
  usage: DashboardUsageSchema.optional(),
  role: z.string().optional(),
  email: z.string().optional(),
  litellmUserId: z.string().optional(),
  error: nullableString.optional(),
});

export type Dashboard = z.infer<typeof DashboardSchema>;

// ---------------------------------------------------------------------------
// /api/models
// ---------------------------------------------------------------------------

export const ModelsSchema = z.object({
  models: z.array(z.string()),
  source: z.string(),
  teamIds: z.array(z.string()).optional(),
});

export type Models = z.infer<typeof ModelsSchema>;

// ---------------------------------------------------------------------------
// /api/keys
// ---------------------------------------------------------------------------

export const KeysSchema = z.object({
  litellmUserId: z.string(),
  totalCount: z.number(),
  keys: z.array(DashboardKeySchema),
});

export type Keys = z.infer<typeof KeysSchema>;

// ---------------------------------------------------------------------------
// /api/keys POST request body
// ---------------------------------------------------------------------------

export const CreateKeyBodySchema = z.object({
  keyAlias: z.string().min(1),
  models: z.array(z.string()).optional(),
  maxBudget: z.number().nonnegative().nullable().optional(),
  duration: z.string().optional(),
});

export type CreateKeyBody = z.infer<typeof CreateKeyBodySchema>;

// ---------------------------------------------------------------------------
// /api/keys POST response
// ---------------------------------------------------------------------------

export const CreateKeyResultSchema = z.object({
  rawKey: z.string(),
  keyAlias: nullableString,
  expires: nullableString,
  keyId: z.string(),
});

export type CreateKeyResult = z.infer<typeof CreateKeyResultSchema>;

// ---------------------------------------------------------------------------
// /api/usage
// ---------------------------------------------------------------------------

export const UsageKeyEntrySchema = z.object({
  id: z.string(),
  alias: nullableString,
  spend: z.number(),
  maxBudget: nullableNumber,
  models: z.array(z.string()),
});

export const UsageSchema = z.object({
  userId: z.string(),
  email: z.string(),
  litellmUserFound: z.boolean(),
  totalSpend: z.number(),
  maxBudget: nullableNumber,
  totalKeyCount: z.number(),
  keys: z.array(UsageKeyEntrySchema),
});

export type Usage = z.infer<typeof UsageSchema>;

// ---------------------------------------------------------------------------
// /api/admin/users
// ---------------------------------------------------------------------------

export const AdminUserSchema = z.object({
  userId: z.string(),
  email: z.string(),
  spend: nullableNumber,
  maxBudget: nullableNumber,
  teamIds: z.array(z.string()),
  role: nullableString,
  lastSyncedAt: z.string().datetime().optional(),
  lastSyncError: z.string().nullable().optional(),
  dirty: z.boolean().optional(),
});

export const AdminUsersSchema = z.object({
  users: z.array(AdminUserSchema),
  totalCount: z.number(),
  page: z.number(),
  size: z.number(),
});

export type AdminUsers = z.infer<typeof AdminUsersSchema>;

// ---------------------------------------------------------------------------
// /api/admin/teams
// ---------------------------------------------------------------------------

export const AdminTeamSchema = z.object({
  id: z.string(),
  alias: nullableString,
  models: z.array(z.string()),
  spend: nullableNumber,
  maxBudget: nullableNumber,
  tpmLimit: nullableNumber,
  rpmLimit: nullableNumber,
  lastSyncedAt: z.string().datetime().optional(),
  lastSyncError: z.string().nullable().optional(),
  dirty: z.boolean().optional(),
});

export const AdminTeamsSchema = z.object({
  teams: z.array(AdminTeamSchema),
});

export type AdminTeams = z.infer<typeof AdminTeamsSchema>;

// ---------------------------------------------------------------------------
// /api/admin/audit
// ---------------------------------------------------------------------------

export const AdminAuditEventSchema = z.object({
  id: z.string(),
  createdAt: nullableString,
  action: z.string(),
  actorUserId: nullableString,
  actorUserEmail: nullableString,
  objectType: nullableString,
  objectId: nullableString,
});

export const AdminAuditSchema = z.object({
  events: z.array(AdminAuditEventSchema),
  totalCount: z.number(),
  page: z.number(),
  size: z.number(),
});

export type AdminAudit = z.infer<typeof AdminAuditSchema>;

// ---------------------------------------------------------------------------
// /api/admin/summary
// ---------------------------------------------------------------------------

export const AdminSummarySchema = z.object({
  userCount: z.number().nullable().optional(),
  sampledUserCount: z.number().nullable().optional(),
  limited: z.boolean().optional(),
  teamCount: z.number().nullable().optional(),
  adminCount: z.number().nullable().optional(),
  unmanagedRoleCount: z.number().nullable().optional(),
  noTeamUserCount: z.number().nullable().optional(),
  overBudgetUserCount: z.number().nullable().optional(),
  overBudgetTeamCount: z.number().nullable().optional(),
  riskCount: z.number().nullable().optional(),
  totalSpend: nullableNumber,
  teamSpend: nullableNumber,
  totalBudget: nullableNumber,
});

export type AdminSummary = z.infer<typeof AdminSummarySchema>;

// ---------------------------------------------------------------------------
// /api/usage/timeseries and /api/admin/usage/timeseries (re-use from types.ts)
// ---------------------------------------------------------------------------

export const UsageBucketSchema = z.object({
  start: z.string(),
  end: z.string(),
  label: z.string(),
  totalTokens: z.number(),
  promptTokens: z.number(),
  completionTokens: z.number(),
  requests: z.number(),
  spend: z.number(),
});

export const UsageTotalsSchema = z.object({
  totalTokens: z.number(),
  promptTokens: z.number(),
  completionTokens: z.number(),
  requests: z.number(),
  spend: z.number(),
});

export const LiteLLMModelUsageSchema = z.object({
  model: z.string(),
  spend: z.number(),
  totalTokens: z.number(),
  requests: z.number(),
});

export const UsageTimeseriesSchema = z.object({
  available: z.boolean(),
  grain: z.enum(["minute", "hour", "day", "month"]),
  window: z.string(),
  windowLabel: z.string(),
  start: z.string(),
  end: z.string(),
  source: z.enum(["spend_logs_v2", "spend_logs_v2_global", "user_daily_activity"]),
  timezone: z.string(),
  limited: z.boolean(),
  maxPages: z.number().nullable(),
  buckets: z.array(UsageBucketSchema),
  totals: UsageTotalsSchema,
  topModels: z.array(LiteLLMModelUsageSchema),
});

export type UsageTimeseries = z.infer<typeof UsageTimeseriesSchema>;

// ---------------------------------------------------------------------------
// Error response (422 validation failure)
// ---------------------------------------------------------------------------

export const ErrorResponseSchema = z.object({
  error: z.string(),
  path: z.string().optional(),
  message: z.string().optional(),
});

export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

// ---------------------------------------------------------------------------
// /api/admin/roles/invalidate
// ---------------------------------------------------------------------------

export const AdminRolesInvalidateQuerySchema = z.object({
  email: z.string().min(1),
});

export type AdminRolesInvalidateQuery = z.infer<typeof AdminRolesInvalidateQuerySchema>;

// ---------------------------------------------------------------------------
// Admin write operation schemas (Phase 1: low + medium risk)
// ---------------------------------------------------------------------------

const REASON_PRESETS = ["routine_maintenance", "security_incident", "user_request", "budget_adjustment", "other"] as const;

export const WriteReasonSchema = z.union([
  z.enum(REASON_PRESETS),
  z.string().min(1).max(500),
]);

export type WriteReason = z.infer<typeof WriteReasonSchema>;

// PATCH /api/admin/keys/:id/disable
export const DisableKeyBodySchema = z.object({
  reason: WriteReasonSchema,
  disabled: z.boolean(),
});

export type DisableKeyBody = z.infer<typeof DisableKeyBodySchema>;

export const DisableKeyResultSchema = z.object({
  keyId: z.string(),
  disabled: z.boolean(),
  dryRun: z.boolean(),
});

export type DisableKeyResult = z.infer<typeof DisableKeyResultSchema>;

// PATCH /api/admin/teams/:id/limits
export const UpdateTeamLimitsBodySchema = z.object({
  reason: WriteReasonSchema,
  tpmLimit: z.number().nonnegative().nullable().optional(),
  rpmLimit: z.number().nonnegative().nullable().optional(),
  maxBudget: z.number().nonnegative().nullable().optional(),
});

export type UpdateTeamLimitsBody = z.infer<typeof UpdateTeamLimitsBodySchema>;

export const UpdateTeamLimitsResultSchema = z.object({
  teamId: z.string(),
  tpmLimit: z.number().nullable(),
  rpmLimit: z.number().nullable(),
  maxBudget: z.number().nullable(),
  dryRun: z.boolean(),
});

export type UpdateTeamLimitsResult = z.infer<typeof UpdateTeamLimitsResultSchema>;

// PATCH /api/admin/users/:id
export const UpdateUserBodySchema = z.object({
  reason: WriteReasonSchema,
  role: z.string().min(1).optional(),
  maxBudget: z.number().nonnegative().nullable().optional(),
});

export type UpdateUserBody = z.infer<typeof UpdateUserBodySchema>;

export const UpdateUserResultSchema = z.object({
  userId: z.string(),
  role: z.string().nullable(),
  maxBudget: z.number().nullable(),
  dryRun: z.boolean(),
});

export type UpdateUserResult = z.infer<typeof UpdateUserResultSchema>;

// DELETE /api/admin/keys/:id (admin)
export const AdminDeleteKeyBodySchema = z.object({
  reason: WriteReasonSchema,
  confirmAlias: z.string().min(1),
});

export type AdminDeleteKeyBody = z.infer<typeof AdminDeleteKeyBodySchema>;

export const AdminDeleteKeyResultSchema = z.object({
  keyId: z.string(),
  dryRun: z.boolean(),
});

export type AdminDeleteKeyResult = z.infer<typeof AdminDeleteKeyResultSchema>;

// ---------------------------------------------------------------------------
// /api/_internal/role-changed
// ---------------------------------------------------------------------------

export const RoleChangedBodySchema = z.object({
  email: z.string().min(1),
  secret: z.string().min(1),
});

export type RoleChangedBody = z.infer<typeof RoleChangedBodySchema>;
