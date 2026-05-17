import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { LiteLLMPortalEnv, PortalIdentity } from "./types";
import { applyAdminRateLimit } from "./security/rate-limit-middleware";
import { authenticateRequest } from "./auth";
import { resolveIdentity } from "./roles";
import { invalidateRole } from "./role-cache";
import { KVUserPrefsStore } from "./preferences";
import { sendEmail } from "./notifications";
import { portalCompanyName, roundCurrency, sumDefinedNumbers, uniqueSorted } from "./utils";
import {
  configuredAllowedModels,
  createKey,
  createTeam,
  deleteKey,
  deleteKeyById,
  getKeyInfo,
  getTeamInfo,
  getUserInfo,
  KeyAliasConflictError,
  LiteLLMRequestError,
  listAllTeams,
  listAllUsers,
  listAuditEvents,
  listUserKeys,
  publicKey,
  publicTeam,
  readAvailableModels,
  readAvailableModelsFromTeams,
  readUserTeams,
  resolveLiteLLMUser,
  updateKeyBlocked,
  updateTeamLimits,
  updateUser,
} from "./litellm";
import { parseDashboardRequest, buildDashboard, buildSummary, SUMMARY_USER_CAP } from "./dashboard";
import type { IndexDOLike, UsageRollup, DashboardWindow } from "./dashboard-schemas";
import { WINDOW_SPEC } from "./dashboard-schemas";
import { LiteLLMUsageSource } from "./usage/litellm-usage-source";
import { ROLLUP_KEY } from "./usage/usage-rollup";
import { readUserDailyActivity } from "./usage";
import {
  MeSchema,
  DashboardSchema,
  ModelsSchema,
  KeysSchema,
  CreateKeyBodySchema,
  CreateKeyResultSchema,
  AdminUsersSchema,
  AdminTeamsSchema,
  AdminAuditSchema,
  type AdminTeams,
  type AdminUsers,
  UsageSchema,
  UserPreferencesSchema,
  UserPreferencesPatchSchema,
  ErrorResponseSchema,
  AdminRolesInvalidateQuerySchema,
  RoleChangedBodySchema,
  DisableKeyBodySchema,
  DisableKeyResultSchema,
  UpdateTeamLimitsBodySchema,
  UpdateTeamLimitsResultSchema,
  UpdateUserBodySchema,
  UpdateUserResultSchema,
  AdminDeleteKeyBodySchema,
  AdminDeleteKeyResultSchema,
  AdminCreateTeamBodySchema,
  AdminCreateTeamResultSchema,
  AdminCreateInviteBodySchema,
  TenantCreateInviteBodySchema,
  AdminCreateInviteResultSchema,
  AdminInviteListSchema,
  AdminRevokeInviteBodySchema,
  AdminRevokeInviteResultSchema,
  SetTeamAlertWebhookBodySchema,
  TeamAlertWebhookResultSchema,
  SetTenantRoleBodySchema,
  SetTenantRoleResultSchema,
} from "./schemas";
import { auditWrite } from "./observability/audit";
import { enqueueSync } from "./sync/queue-producer";
import type { LiteLLMKey, LiteLLMTeam, JsonValue } from "./types";

type HonoEnv = { Bindings: LiteLLMPortalEnv; Variables: { identity: PortalIdentity } };

// ---------------------------------------------------------------------------
// DO stub types (inline — avoids dragging DO modules into vitest transform)
// ---------------------------------------------------------------------------

type IndexDOAdminStub = {
  listTeams(): Promise<Array<{ id: string; alias: string }>>;
  listAllUsers(opts?: { limit?: number; cursor?: string }): Promise<{
    users: Array<{
      userId: string;
      email: string;
      role: "admin" | "user";
      teamId: string | null;
      maxBudget?: number;
      createdAt: string;
    }>;
    cursor: string | undefined;
  }>;
};

type TeamConfigDOAdminStub = {
  getTeam(): Promise<{
    id: string;
    alias: string;
    models: string[];
    maxBudget?: number;
    tpmLimit?: number;
    rpmLimit?: number;
    blocked: boolean;
  } | null>;
  getSyncMetadata(): Promise<{
    lastSyncedAt: string | null;
    lastSyncError: string | null;
    dirty: boolean;
  }>;
};

type TeamConfigDOWriteStub = {
  getTeam(): Promise<{
    id: string;
    alias: string;
    models: string[];
    maxBudget?: number;
    tpmLimit?: number;
    rpmLimit?: number;
    blocked: boolean;
    budgetDuration?: string;
    budgetResetAt?: string;
  } | null>;
  putTeam(
    record: {
      id: string;
      alias: string;
      models: string[];
      maxBudget?: number;
      tpmLimit?: number;
      rpmLimit?: number;
      blocked: boolean;
      budgetDuration?: string;
      budgetResetAt?: string;
    },
    idempotencyKey?: string,
  ): Promise<void>;
  getSyncMetadata(): Promise<{
    lastSyncedAt: string | null;
    lastSyncError: string | null;
    dirty: boolean;
  }>;
};

type IndexDOStorageAdminStub = IndexDOAdminStub & {
  getStorageMigrationState(): Promise<{
    backend: "sql" | "kv";
    teams: number;
    users: number;
    nonces: number;
    auditEvents: number;
    legacyKeys: number;
    legacyKvDeleted: boolean;
  }>;
  deleteLegacyKV(): Promise<{ deleted: number; skipped: boolean }>;
};

type TeamConfigDOStorageAdminStub = {
  getStorageMigrationState(): Promise<{
    backend: "sql" | "kv";
    hasTeam: boolean;
    members: number;
    keys: number;
    hasSpend: boolean;
    dirty: boolean;
    legacyKeys: number;
    legacyKvDeleted: boolean;
  }>;
  deleteLegacyKV(): Promise<{ deleted: number; skipped: boolean }>;
};

const DeleteLegacyDOStorageBodySchema = z
  .object({
    confirm: z.literal("delete-legacy-do-kv"),
    teamIds: z.array(z.string().min(1)).optional(),
  })
  .strict();

type IndexDOWriteStub = {
  getUserById(userId: string): Promise<{
    userId: string;
    email: string;
    role: "admin" | "user";
    teamId: string | null;
    maxBudget?: number;
    createdAt: string;
  } | null>;
  putUser(record: {
    userId: string;
    email: string;
    role: "admin" | "user";
    teamId: string | null;
    maxBudget?: number;
    createdAt: string;
  }): Promise<void>;
};

type InviteRecordShape = {
  emailLc: string;
  teamId: string;
  teamRole: "admin" | "user";
  status: "pending" | "consumed" | "revoked";
  invitedBy: string;
  createdAt: string;
  consumedAt: string | null;
};

type IndexDOInviteStub = {
  listTeams(): Promise<Array<{ id: string; alias: string }>>;
  setTeamsList(list: Array<{ id: string; alias: string }>): Promise<void>;
  putInvite(record: InviteRecordShape): Promise<void>;
  getInvite(emailLc: string): Promise<InviteRecordShape | null>;
  listInvites(opts?: { status?: "pending" | "consumed" | "revoked" }): Promise<InviteRecordShape[]>;
  revokeInvite(emailLc: string): Promise<InviteRecordShape | null>;
};

function inviteToPublic(record: InviteRecordShape) {
  return {
    email: record.emailLc,
    teamId: record.teamId,
    teamRole: record.teamRole,
    status: record.status,
    invitedBy: record.invitedBy,
    createdAt: record.createdAt,
    consumedAt: record.consumedAt,
  };
}

type TeamConfigDOAlertStub = {
  getTeam(): Promise<{ id: string } | null>;
  getAlertWebhook(): Promise<{ url: string; updatedAt: string; updatedBy: string } | null>;
  setAlertWebhook(webhook: { url: string; updatedAt: string; updatedBy: string }): Promise<void>;
  clearAlertWebhook(): Promise<void>;
};

// ---------------------------------------------------------------------------
// DO-path helpers for flag-gated admin endpoints
// ---------------------------------------------------------------------------

async function adminTeamsFromDO(env: LiteLLMPortalEnv): Promise<AdminTeams> {
  if (!env.INDEX_DO) return { teams: [] };
  const idx = env.INDEX_DO.get(env.INDEX_DO.idFromName("index")) as unknown as IndexDOAdminStub;
  const entries = await idx.listTeams();

  const teams: AdminTeams["teams"] = await Promise.all(
    entries.map(async (entry) => {
      let teamRecord: Awaited<ReturnType<TeamConfigDOAdminStub["getTeam"]>> = null;
      let syncMeta: { lastSyncedAt: string | null; lastSyncError: string | null; dirty: boolean } = {
        lastSyncedAt: null,
        lastSyncError: null,
        dirty: false,
      };
      if (env.TEAM_CONFIG_DO) {
        const stub = env.TEAM_CONFIG_DO.get(
          env.TEAM_CONFIG_DO.idFromName(entry.id),
        ) as unknown as TeamConfigDOAdminStub;
        [teamRecord, syncMeta] = await Promise.all([stub.getTeam(), stub.getSyncMetadata()]);
      }
      return {
        id: entry.id,
        alias: teamRecord?.alias ?? entry.alias ?? null,
        models: teamRecord?.models ?? [],
        spend: null,
        maxBudget: teamRecord?.maxBudget ?? null,
        tpmLimit: teamRecord?.tpmLimit ?? null,
        rpmLimit: teamRecord?.rpmLimit ?? null,
        lastSyncedAt: syncMeta.lastSyncedAt ?? undefined,
        lastSyncError: syncMeta.lastSyncError,
        dirty: syncMeta.dirty || undefined,
      };
    }),
  );

  return AdminTeamsSchema.parse({ teams });
}

async function adminUsersFromDO(env: LiteLLMPortalEnv, opts: { page: number; size: number }): Promise<AdminUsers> {
  if (!env.INDEX_DO) return { users: [], totalCount: 0, page: opts.page, size: opts.size };
  const idx = env.INDEX_DO.get(env.INDEX_DO.idFromName("index")) as unknown as IndexDOAdminStub;

  // Collect enough pages to serve the requested page
  const targetOffset = (opts.page - 1) * opts.size;
  let collected: Array<{ userId: string; email: string; role: string; teamId: string | null; maxBudget?: number }> = [];
  let cursor: string | undefined;

  // Walk storage pages until we have enough records for offset + size
  while (collected.length < targetOffset + opts.size) {
    const batch = await idx.listAllUsers({ limit: 200, cursor });
    collected = collected.concat(batch.users);
    cursor = batch.cursor;
    if (cursor == null) break;
  }

  const totalCount = collected.length;
  const page = collected.slice(targetOffset, targetOffset + opts.size);

  const users = page.map((u) => ({
    userId: u.userId,
    email: u.email,
    spend: null,
    maxBudget: u.maxBudget ?? null,
    teamIds: u.teamId != null ? [u.teamId] : [],
    role: u.role,
  }));

  return AdminUsersSchema.parse({ users, totalCount, page: opts.page, size: opts.size });
}

async function listDOStorageMigrationState(
  env: LiteLLMPortalEnv,
  opts: { limit: number; teamIds?: string[] } = { limit: 100 },
): Promise<Record<string, unknown>> {
  if (!env.INDEX_DO) {
    return { index: null, teams: [], errors: ["INDEX_DO binding not configured"] };
  }

  const indexStub = env.INDEX_DO.get(env.INDEX_DO.idFromName("index")) as unknown as IndexDOStorageAdminStub;
  const [index, allTeams] = await Promise.all([indexStub.getStorageMigrationState(), indexStub.listTeams()]);

  const requestedTeamIds = opts.teamIds != null ? new Set(opts.teamIds) : null;
  const matchingTeams = requestedTeamIds == null ? allTeams : allTeams.filter((team) => requestedTeamIds.has(team.id));
  const selectedTeams = matchingTeams.slice(0, opts.limit);
  const errors: string[] = [];

  if (!env.TEAM_CONFIG_DO) {
    return {
      index,
      teams: [],
      totalTeams: allTeams.length,
      scannedTeams: 0,
      limited: false,
      errors: ["TEAM_CONFIG_DO binding not configured"],
    };
  }

  const teams = await Promise.all(
    selectedTeams.map(async (team) => {
      try {
        const stub = env.TEAM_CONFIG_DO!.get(
          env.TEAM_CONFIG_DO!.idFromName(team.id),
        ) as unknown as TeamConfigDOStorageAdminStub;
        return { id: team.id, alias: team.alias, state: await stub.getStorageMigrationState() };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        errors.push(`${team.id}:${reason}`);
        return { id: team.id, alias: team.alias, state: null };
      }
    }),
  );

  return {
    index,
    teams,
    totalTeams: allTeams.length,
    scannedTeams: teams.length,
    limited: matchingTeams.length > selectedTeams.length,
    ...(errors.length > 0 ? { errors } : {}),
  };
}

async function deleteLegacyDOStorageKV(env: LiteLLMPortalEnv, teamIds?: string[]): Promise<Record<string, unknown>> {
  if (!env.INDEX_DO) {
    return { index: null, teams: [], errors: ["INDEX_DO binding not configured"] };
  }
  const indexStub = env.INDEX_DO.get(env.INDEX_DO.idFromName("index")) as unknown as IndexDOStorageAdminStub;
  const allTeams = await indexStub.listTeams();
  const requestedTeamIds = teamIds != null ? new Set(teamIds) : null;
  const selectedTeams = requestedTeamIds == null ? allTeams : allTeams.filter((team) => requestedTeamIds.has(team.id));
  const errors: string[] = [];

  const index = await indexStub.deleteLegacyKV();
  const teams = await Promise.all(
    selectedTeams.map(async (team) => {
      if (!env.TEAM_CONFIG_DO) {
        return { id: team.id, alias: team.alias, result: { deleted: 0, skipped: true } };
      }
      try {
        const stub = env.TEAM_CONFIG_DO.get(
          env.TEAM_CONFIG_DO.idFromName(team.id),
        ) as unknown as TeamConfigDOStorageAdminStub;
        return { id: team.id, alias: team.alias, result: await stub.deleteLegacyKV() };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        errors.push(`${team.id}:${reason}`);
        return { id: team.id, alias: team.alias, result: { deleted: 0, skipped: true } };
      }
    }),
  );

  return {
    index,
    teams,
    totalTeams: allTeams.length,
    cleanedTeams: teams.length,
    ...(errors.length > 0 ? { errors } : {}),
  };
}

// ---------------------------------------------------------------------------
// DO-first write helpers for flag-gated admin endpoints (PDCSOT-55)
// ---------------------------------------------------------------------------

async function adminUpdateTeamLimitsDO(
  env: LiteLLMPortalEnv,
  c: Context<HonoEnv>,
  teamId: string,
  body: { tpmLimit?: number | null; rpmLimit?: number | null; maxBudget?: number | null },
  isDryRun: boolean,
): Promise<Response> {
  if (!env.TEAM_CONFIG_DO) return c.json({ error: "team_config_do_unavailable" }, 503);
  const teamConfigStub = env.TEAM_CONFIG_DO.get(
    env.TEAM_CONFIG_DO.idFromName(teamId),
  ) as unknown as TeamConfigDOWriteStub;
  const currentTeam = await teamConfigStub.getTeam();
  if (!currentTeam) return c.json({ error: "team_not_found" }, 404);
  const updated = {
    ...currentTeam,
    ...(body.maxBudget !== undefined && body.maxBudget !== null ? { maxBudget: body.maxBudget } : {}),
    ...(body.tpmLimit !== undefined && body.tpmLimit !== null ? { tpmLimit: body.tpmLimit } : {}),
    ...(body.rpmLimit !== undefined && body.rpmLimit !== null ? { rpmLimit: body.rpmLimit } : {}),
  };
  if (isDryRun) {
    const meta = await teamConfigStub.getSyncMetadata();
    return c.json({
      team: updated,
      lastSyncedAt: meta.lastSyncedAt,
      lastSyncError: meta.lastSyncError,
      dirty: meta.dirty,
      enqueued: false,
      dryRun: true,
    });
  }
  const idempotencyKey = `team.update:${teamId}:${Date.now()}-${crypto.randomUUID()}`;
  await teamConfigStub.putTeam(updated, idempotencyKey);
  const enqueueResult = await enqueueSync(env, {
    kind: "team.update",
    entityId: teamId,
    payload: {
      team_id: teamId,
      max_budget: updated.maxBudget,
      tpm_limit: updated.tpmLimit,
      rpm_limit: updated.rpmLimit,
    },
    idempotencyKey,
  });
  const meta = await teamConfigStub.getSyncMetadata();
  return c.json({
    team: updated,
    lastSyncedAt: meta.lastSyncedAt,
    lastSyncError: meta.lastSyncError,
    dirty: meta.dirty,
    enqueued: enqueueResult.delivered,
  });
}

async function adminUpdateUserDO(
  env: LiteLLMPortalEnv,
  c: Context<HonoEnv>,
  userId: string,
  body: { role?: string | null; maxBudget?: number | null },
  isDryRun: boolean,
): Promise<Response> {
  if (!env.INDEX_DO) return c.json({ error: "index_do_unavailable" }, 503);
  const idxStub = env.INDEX_DO.get(env.INDEX_DO.idFromName("index")) as unknown as IndexDOWriteStub;
  const currentUser = await idxStub.getUserById(userId);
  if (!currentUser) return c.json({ error: "user_not_found" }, 404);
  const updatedRole: "admin" | "user" =
    body.role === "proxy_admin" || body.role === "proxy_admin_viewer"
      ? "admin"
      : body.role != null
        ? "user"
        : currentUser.role;
  const updated = {
    ...currentUser,
    role: updatedRole,
    ...(body.maxBudget !== undefined && body.maxBudget !== null ? { maxBudget: body.maxBudget } : {}),
  };
  if (isDryRun) {
    return c.json({
      userId: updated.userId,
      role: updated.role,
      maxBudget: updated.maxBudget ?? null,
      enqueued: false,
      dryRun: true,
    });
  }
  await idxStub.putUser(updated);
  const enqueueResult = await enqueueSync(env, {
    kind: "user.update",
    entityId: userId,
    payload: {
      user_id: userId,
      user_role: body.role ?? undefined,
      max_budget: updated.maxBudget,
    },
  });
  return c.json({
    userId: updated.userId,
    role: updated.role,
    maxBudget: updated.maxBudget ?? null,
    enqueued: enqueueResult.delivered,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sanitizeIntParam(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

function keyAwareTeamIds(userTeamIds: string[], keys: LiteLLMKey[]): string[] {
  return uniqueSorted([
    ...userTeamIds,
    ...keys.map((key) => key.teamId).filter((id): id is string => typeof id === "string" && id.trim().length > 0),
  ]);
}

function keyDisplayModels(
  key: LiteLLMKey,
  teams: LiteLLMTeam[],
  fallbackModels: string[],
  env: LiteLLMPortalEnv,
): string[] {
  const configured = configuredAllowedModels(env);
  const teamModels = key.teamId === null ? [] : (teams.find((t) => t.id === key.teamId)?.models ?? []);
  const models = key.models.length > 0 ? key.models : teamModels.length > 0 ? teamModels : fallbackModels;
  return configured.length > 0 ? models.filter((m) => configured.includes(m)) : models;
}

function publicKeyWithModels(
  key: LiteLLMKey,
  teams: LiteLLMTeam[],
  fallbackModels: string[],
  env: LiteLLMPortalEnv,
): Record<string, JsonValue> {
  return {
    ...publicKey(key),
    models: keyDisplayModels(key, teams, fallbackModels, env),
  };
}

// ---------------------------------------------------------------------------
// Dashboard loader — used by SSR in index.ts
// ---------------------------------------------------------------------------

export async function loadDashboard(
  env: LiteLLMPortalEnv,
  identity: PortalIdentity,
): Promise<Record<string, JsonValue>> {
  const user = await resolveLiteLLMUser(env, identity.email);
  const [keyList, activity] = await Promise.all([
    listUserKeys(env, user.userId),
    readUserDailyActivity(env, user.userId),
  ]);
  const teamIds = keyAwareTeamIds(user.teamIds, keyList.keys);
  const teams = await readUserTeams(env, teamIds);
  const modelAccess = await readAvailableModelsFromTeams(env, teamIds, teams);
  const keySpend = roundCurrency(keyList.keys.reduce((sum, key) => sum + key.spend, 0));
  const totalSpend = user.spend ?? keySpend;
  const keyBudget = sumDefinedNumbers(keyList.keys.map((key) => key.maxBudget));

  return {
    me: {
      email: identity.email,
      domain: identity.domain,
      company: portalCompanyName(env),
    },
    user: {
      litellmUserId: user.userId,
      litellmUserFound: user.found,
      totalSpend,
      maxBudget: user.maxBudget,
    },
    summary: {
      totalSpend,
      recentSpend: activity.available ? activity.totalSpend : null,
      keySpend,
      keyBudget,
      keyCount: keyList.totalCount,
      availableModelCount: modelAccess.models.length,
      teamCount: teams.length,
      totalTokens: activity.totalTokens,
      requestCount: activity.requestCount,
    },
    models: modelAccess,
    teams: teams.map(publicTeam),
    keys: {
      totalCount: keyList.totalCount,
      items: keyList.keys.map((key) => publicKeyWithModels(key, teams, modelAccess.models, env)),
    },
    usage: activity,
  };
}

// ---------------------------------------------------------------------------
// Auth middleware helper (applied to every api sub-app)
// ---------------------------------------------------------------------------

async function applyAuthMiddleware(c: Context<HonoEnv>, next: () => Promise<void>): Promise<Response | void> {
  const auth = await authenticateRequest(c.req.raw, c.env);
  if (!auth.ok) {
    return c.json({ error: auth.error }, auth.status);
  }
  const identityResult = await resolveIdentity(c.env, auth.principal);
  if (!identityResult.ok) {
    return c.json({ error: identityResult.error }, identityResult.status);
  }
  c.set("identity", identityResult.identity);
  await next();
}

async function requireAdmin(c: Context<HonoEnv>, next: () => Promise<void>): Promise<Response | void> {
  if (c.get("identity").role !== "admin") {
    return c.json({ error: "admin_required" }, 403);
  }
  await next();
}

function tenantTeamIdFromReq(c: Context<HonoEnv>): string | null {
  const p = c.req.param("teamId");
  if (!p) return null;
  try {
    return decodeURIComponent(p).trim() || null;
  } catch {
    return null; // malformed → treated as no team id → requireTenantAdmin returns 403
  }
}

async function requireTenantAdmin(c: Context<HonoEnv>, next: () => Promise<void>): Promise<Response | void> {
  const id = c.get("identity");
  // Platform admin is a superset (Owner / impersonation).
  if (id.role === "admin") { await next(); return; }
  const targetTeam = tenantTeamIdFromReq(c) ?? id.tenantTeamId;
  if (
    id.tenantRole === "tenant_admin" &&
    id.tenantTeamId != null &&
    targetTeam != null &&
    targetTeam === id.tenantTeamId
  ) {
    await next();
    return;
  }
  return c.json({ error: "tenant_admin_required" }, 403);
}

// ---------------------------------------------------------------------------
// One-route-per-sub-app typed chains (avoids TS2589 from long accumulation)
// ---------------------------------------------------------------------------

const meApp = new Hono<HonoEnv>().use("/*", applyAuthMiddleware).get("/me", (c) => {
  const identity = c.get("identity");
  return c.json(
    MeSchema.parse({
      email: identity.email,
      userId: identity.litellmUserId,
      company: portalCompanyName(c.env),
      domain: identity.domain,
      role: identity.role,
      tenantRole: identity.tenantRole,
      tenantTeamId: identity.tenantTeamId,
    }),
  );
});

const preferencesApp = new Hono<HonoEnv>()
  .use("/*", applyAuthMiddleware)
  .get("/me/preferences", async (c) => {
    const identity = c.get("identity");
    const store = new KVUserPrefsStore(c.env.USER_PREFS_KV);
    return c.json(UserPreferencesSchema.parse(await store.getForEmail(identity.email)));
  })
  .patch("/me/preferences", async (c) => {
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    const parsed = UserPreferencesPatchSchema.safeParse(rawBody);
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      return c.json(
        ErrorResponseSchema.parse({
          error: "validation_error",
          path: firstIssue?.path.join(".") ?? "",
          message: firstIssue?.message ?? "invalid_preferences",
        }),
        422,
      );
    }
    const identity = c.get("identity");
    const store = new KVUserPrefsStore(c.env.USER_PREFS_KV);
    const next = await store.patchForEmail(identity.email, parsed.data);
    return c.json(UserPreferencesSchema.parse(next));
  });

const adminPreferencesDefaultsApp = new Hono<HonoEnv>()
  .use("/*", applyAuthMiddleware)
  .use("/admin/*", applyAdminRateLimit)
  .use("/admin/*", requireAdmin)
  .get("/admin/preferences-defaults", async (c) => {
    const store = new KVUserPrefsStore(c.env.USER_PREFS_KV);
    return c.json(UserPreferencesSchema.parse(await store.getGlobalDefaults()));
  })
  .patch("/admin/preferences-defaults", async (c) => {
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    const parsed = UserPreferencesPatchSchema.safeParse(rawBody);
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      return c.json(
        ErrorResponseSchema.parse({
          error: "validation_error",
          path: firstIssue?.path.join(".") ?? "",
          message: firstIssue?.message ?? "invalid_preferences",
        }),
        422,
      );
    }
    const store = new KVUserPrefsStore(c.env.USER_PREFS_KV);
    const next = await store.patchGlobalDefaults(parsed.data);
    return c.json(UserPreferencesSchema.parse(next));
  });

const dashboardApp = new Hono<HonoEnv>().use("/*", applyAuthMiddleware).get("/dashboard", async (c) => {
  const identity = c.get("identity");
  const data = await loadDashboard(c.env, identity);
  return c.json(DashboardSchema.parse(data));
});

const modelsApp = new Hono<HonoEnv>().use("/*", applyAuthMiddleware).get("/models", async (c) => {
  const identity = c.get("identity");
  const user = await resolveLiteLLMUser(c.env, identity.email);
  const result = await readAvailableModels(c.env, user);
  return c.json(ModelsSchema.parse(result));
});

const keysGetApp = new Hono<HonoEnv>().use("/*", applyAuthMiddleware).get("/keys", async (c) => {
  const identity = c.get("identity");
  const user = await resolveLiteLLMUser(c.env, identity.email);
  const keyList = await listUserKeys(c.env, user.userId);
  const teamIds = keyAwareTeamIds(user.teamIds, keyList.keys);
  const teams = await readUserTeams(c.env, teamIds);
  const modelAccess = await readAvailableModelsFromTeams(c.env, teamIds, teams);
  return c.json(
    KeysSchema.parse({
      litellmUserId: user.userId,
      totalCount: keyList.totalCount,
      keys: keyList.keys.map((key) => publicKeyWithModels(key, teams, modelAccess.models, c.env)),
    }),
  );
});

const keysPostApp = new Hono<HonoEnv>().use("/*", applyAuthMiddleware).post("/keys", async (c) => {
  const identity = c.get("identity");
  const user = await resolveLiteLLMUser(c.env, identity.email);
  if (!user.found) {
    return c.json({ error: "user_not_found" }, 400);
  }

  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const parsed = CreateKeyBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const isKeyAlias = !firstIssue || firstIssue.path[0] === "keyAlias";
    if (isKeyAlias) {
      return c.json({ error: "key_alias_required" }, 400);
    }
    return c.json(
      ErrorResponseSchema.parse({
        error: "validation_error",
        path: firstIssue?.path.join(".") ?? "",
        message: firstIssue?.message ?? "invalid_request",
      }),
      422,
    );
  }

  const { keyAlias, models, maxBudget, duration } = parsed.data;

  try {
    const result = await createKey(c.env, user.userId, {
      keyAlias,
      models,
      maxBudget: maxBudget ?? null,
      duration: duration ?? null,
    });
    try {
      const preferences = await new KVUserPrefsStore(c.env.USER_PREFS_KV).getForEmail(identity.email);
      if (preferences.notifications.keyCreation) {
        await sendEmail(identity.email, "keyCreation", {
          keyAlias: result.keyAlias ?? keyAlias,
          createdAt: new Date().toISOString(),
        });
      }
    } catch {
      // Key creation should not fail if notification delivery is unavailable.
    }
    return c.json(CreateKeyResultSchema.parse(result), 201);
  } catch (error) {
    if (error instanceof KeyAliasConflictError) {
      return c.json(
        {
          error: "key_alias_conflict",
          keyAlias: error.keyAlias,
          message: "API Key name already exists",
        },
        409,
      );
    }
    throw error;
  }
});

const keysDeleteApp = new Hono<HonoEnv>().use("/*", applyAuthMiddleware).delete("/keys/:keyId", async (c) => {
  const identity = c.get("identity");
  const encodedKeyId = c.req.param("keyId") ?? "";
  let keyId = "";
  try {
    keyId = decodeURIComponent(encodedKeyId).trim();
  } catch {
    return c.json({ error: "key_id_required" }, 400);
  }
  if (!keyId) {
    return c.json({ error: "key_id_required" }, 400);
  }

  const user = await resolveLiteLLMUser(c.env, identity.email);
  if (!user.found) {
    return c.json({ error: "user_not_found" }, 400);
  }

  const keyList = await listUserKeys(c.env, user.userId);
  const key = keyList.keys.find((item) => item.id === keyId);
  if (key === undefined) {
    return c.json({ error: "key_not_found" }, 404);
  }

  await deleteKey(c.env, key, identity.email);
  return new Response(null, { status: 204 });
});

const usageApp = new Hono<HonoEnv>().use("/*", applyAuthMiddleware).get("/usage", async (c) => {
  const identity = c.get("identity");
  const user = await resolveLiteLLMUser(c.env, identity.email);
  const keyList = await listUserKeys(c.env, user.userId);
  const teamIds = keyAwareTeamIds(user.teamIds, keyList.keys);
  const teams = await readUserTeams(c.env, teamIds);
  const modelAccess = await readAvailableModelsFromTeams(c.env, teamIds, teams);
  const keySpend = roundCurrency(keyList.keys.reduce((sum, key) => sum + key.spend, 0));
  return c.json(
    UsageSchema.parse({
      userId: user.userId,
      email: identity.email,
      litellmUserFound: user.found,
      totalSpend: user.spend ?? keySpend,
      maxBudget: user.maxBudget,
      totalKeyCount: keyList.totalCount,
      keys: keyList.keys.map((key) => ({
        id: key.id,
        alias: key.alias,
        spend: key.spend,
        maxBudget: key.maxBudget,
        models: keyDisplayModels(key, teams, modelAccess.models, c.env),
      })),
    }),
  );
});

const adminUsersApp = new Hono<HonoEnv>()
  .use("/*", applyAuthMiddleware)
  .use("/admin/*", applyAdminRateLimit)
  .use("/admin/*", requireAdmin)
  .get("/admin/users", async (c) => {
    const url = new URL(c.req.url);
    const page = sanitizeIntParam(url.searchParams.get("page"), 1);
    const size = sanitizeIntParam(url.searchParams.get("size"), 50);
    if (c.env.INDEX_DO && c.env.TEAM_CONFIG_DO) {
      return c.json(await adminUsersFromDO(c.env, { page, size }));
    }
    const result = await listAllUsers(c.env, { page, size });
    return c.json(
      AdminUsersSchema.parse({
        users: result.users.map((u) => ({
          userId: u.userId,
          email: u.email,
          spend: u.spend,
          maxBudget: u.maxBudget,
          teamIds: u.teamIds,
          role: u.role,
        })),
        totalCount: result.totalCount,
        page: result.page,
        size: result.size,
      }),
    );
  });

const adminTeamsApp = new Hono<HonoEnv>()
  .use("/*", applyAuthMiddleware)
  .use("/admin/*", applyAdminRateLimit)
  .use("/admin/*", requireAdmin)
  .get("/admin/teams", async (c) => {
    if (c.env.INDEX_DO && c.env.TEAM_CONFIG_DO) {
      return c.json(await adminTeamsFromDO(c.env));
    }
    const teams = await listAllTeams(c.env);
    return c.json(AdminTeamsSchema.parse({ teams: teams.map(publicTeam) }));
  });

const adminAuditApp = new Hono<HonoEnv>()
  .use("/*", applyAuthMiddleware)
  .use("/admin/*", applyAdminRateLimit)
  .use("/admin/*", requireAdmin)
  .get("/admin/audit", async (c) => {
    const url = new URL(c.req.url);
    const page = sanitizeIntParam(url.searchParams.get("page"), 1);
    const size = sanitizeIntParam(url.searchParams.get("size"), 50);
    const result = await listAuditEvents(c.env, { page, size });
    return c.json(
      AdminAuditSchema.parse({
        events: result.events.map((e) => ({
          id: e.id,
          createdAt: e.createdAt,
          action: e.action,
          actorUserId: e.actorUserId,
          actorUserEmail: e.actorUserEmail,
          objectType: e.objectType,
          objectId: e.objectId,
        })),
        totalCount: result.totalCount,
        page: result.page,
        size: result.size,
      }),
    );
  });

async function loadRollup(env: LiteLLMPortalEnv): Promise<UsageRollup | null> {
  if (!env.USAGE_ROLLUP_KV) return null;
  try {
    const raw = await env.USAGE_ROLLUP_KV.get(ROLLUP_KEY);
    return raw ? (JSON.parse(raw) as UsageRollup) : null;
  } catch (err) { console.warn("[dashboard] rollup KV parse error", String(err).slice(0, 80)); return null; }
}
function emptyDashboard(scopeLabel: string, window: DashboardWindow) {
  return { scope: scopeLabel, window, grain: "day" as const, grainFallback: false,
    timezone: "Asia/Shanghai" as const, available: false, empty: false,
    kpi: { spend:{current:0,previous:null,deltaPct:null}, requests:{current:0,previous:null,deltaPct:null}, totalTokens:{current:0,previous:null,deltaPct:null} },
    trend: [], models: [] };
}
function indexDOLike(env: LiteLLMPortalEnv): IndexDOLike | null {
  if (!env.INDEX_DO) return null;
  return env.INDEX_DO.get(env.INDEX_DO.idFromName("index")) as unknown as IndexDOLike;
}

const usageOverviewApp = new Hono<HonoEnv>().use("/*", applyAuthMiddleware).get("/usage/overview", async (c) => {
  const parsed = parseDashboardRequest(new URL(c.req.url));
  if (!parsed.ok) return c.json(parsed.body, 400);
  const identity = c.get("identity");
  const opts = {
    scope: { kind: "self" as const, userId: identity.litellmUserId },
    window: parsed.window,
    grain: parsed.grain,
    grainFallback: parsed.grainFallback,
  };
  try {
    const res = await buildDashboard(
      { usage: new LiteLLMUsageSource(c.env), index: indexDOLike(c.env), rollup: null, now: Date.now() },
      opts,
    );
    return c.json(res);
  } catch (e) {
    if (e && typeof e === "object" && (e as { kind?: string }).kind === "unavailable") {
      return c.json(emptyDashboard("self", parsed.window), 200);
    }
    throw e;
  }
});

const adminUsageOverviewApp = new Hono<HonoEnv>()
  .use("/*", applyAuthMiddleware)
  .use("/admin/*", applyAdminRateLimit)
  .use("/admin/*", requireAdmin)
  .get("/admin/usage/overview", async (c) => {
    const url = new URL(c.req.url);
    const parsed = parseDashboardRequest(url);
    if (!parsed.ok) return c.json(parsed.body, 400);
    const member = url.searchParams.get("member");
    const scope =
      member != null && member.length > 0 ? { kind: "member" as const, userId: member } : { kind: "global" as const };
    const rollup = await loadRollup(c.env);
    const opts = { scope, window: parsed.window, grain: parsed.grain, grainFallback: parsed.grainFallback };
    try {
      const res = await buildDashboard(
        { usage: new LiteLLMUsageSource(c.env), index: indexDOLike(c.env), rollup, now: Date.now() },
        opts,
      );
      return c.json(res);
    } catch (e) {
      if (e && typeof e === "object" && (e as { kind?: string }).kind === "unavailable") {
        const label = scope.kind === "global" ? "global" : `member:${scope.userId}`;
        return c.json(emptyDashboard(label, parsed.window), 200);
      }
      throw e;
    }
  });

const adminRolesInvalidateApp = new Hono<HonoEnv>()
  .use("/*", applyAuthMiddleware)
  .use("/admin/*", async (c, next) => {
    const identity = c.get("identity");
    if (identity.role !== "admin") {
      return c.json({ error: "admin_required" }, 403);
    }
    await next();
  })
  .post("/admin/roles/invalidate", async (c) => {
    const url = new URL(c.req.url);
    const parsed = AdminRolesInvalidateQuerySchema.safeParse({
      email: url.searchParams.get("email"),
    });
    if (!parsed.success) {
      return c.json({ error: "email_required" }, 400);
    }
    await invalidateRole(c.env, parsed.data.email);
    return new Response(null, { status: 204 });
  });

const internalRoleChangedApp = new Hono<{ Bindings: LiteLLMPortalEnv }>().post("/_internal/role-changed", async (c) => {
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const parsed = RoleChangedBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ error: "invalid_body" }, 400);
  }
  const { email, secret } = parsed.data;
  const expectedToken = c.env.ROLE_INVALIDATION_WEBHOOK_TOKEN;
  if (!expectedToken || secret !== expectedToken) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await invalidateRole(c.env, email);
  return new Response(null, { status: 204 });
});

// ---------------------------------------------------------------------------
// Feature flag helper
// ---------------------------------------------------------------------------

function isWriteOpsEnabled(env: LiteLLMPortalEnv): boolean {
  return env.LITELLM_PORTAL_WRITE_OPS_ENABLED === "true";
}

function writeOpsDisabledResponse<T extends object>(c: { json: (body: T, status?: number) => Response }): Response {
  return c.json({ error: "not_found" } as unknown as T, 404);
}

// ---------------------------------------------------------------------------
// Shared write-body parsing helper
// ---------------------------------------------------------------------------

async function parseWriteBody<T>(
  c: { req: { json: () => Promise<unknown> }; json: (body: object, status?: number) => Response },
  schema: z.ZodType<T>,
): Promise<{ ok: true; data: T } | { ok: false; response: Response }> {
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return { ok: false, response: c.json({ error: "invalid_json" }, 400) };
  }
  const parsed = schema.safeParse(rawBody);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const pathSegments = firstIssue?.path.map((segment) => String(segment)) ?? [];
    return {
      ok: false,
      response: c.json(
        {
          error: "validation_error",
          path: pathSegments.join("."),
          message: firstIssue?.message ?? "invalid_request",
        },
        422,
      ),
    };
  }
  return { ok: true, data: parsed.data };
}

// ---------------------------------------------------------------------------
// Admin DO storage migration helpers
// ---------------------------------------------------------------------------

const adminDOStorageApp = new Hono<HonoEnv>()
  .use("/*", applyAuthMiddleware)
  .use("/admin/*", applyAdminRateLimit)
  .use("/admin/*", requireAdmin)
  .get("/admin/do-storage/migration-state", async (c) => {
    const url = new URL(c.req.url);
    const limit = Math.min(sanitizeIntParam(url.searchParams.get("limit"), 100), 500);
    const teamIds = url.searchParams
      .getAll("teamId")
      .map((id) => id.trim())
      .filter(Boolean);
    return c.json(
      await listDOStorageMigrationState(c.env, {
        limit,
        ...(teamIds.length > 0 ? { teamIds } : {}),
      }),
    );
  })
  .post("/admin/do-storage/delete-legacy-kv", async (c) => {
    if (!isWriteOpsEnabled(c.env)) return writeOpsDisabledResponse(c);

    const parsed = await parseWriteBody(c, DeleteLegacyDOStorageBodySchema);
    if (!parsed.ok) return parsed.response;

    return c.json(await deleteLegacyDOStorageKV(c.env, parsed.data.teamIds));
  });

// ---------------------------------------------------------------------------
// Admin write endpoints — low risk: PATCH /api/admin/keys/:id/disable
// ---------------------------------------------------------------------------

const adminDisableKeyApp = new Hono<HonoEnv>()
  .use("/*", applyAuthMiddleware)
  .use("/admin/*", applyAdminRateLimit)
  .use("/admin/*", requireAdmin)
  .patch("/admin/keys/:keyId/disable", async (c) => {
    if (!isWriteOpsEnabled(c.env)) return writeOpsDisabledResponse(c);

    const keyId = decodeURIComponent(c.req.param("keyId") ?? "").trim();
    if (!keyId) return c.json({ error: "key_id_required" }, 400);

    const parsed = await parseWriteBody(c, DisableKeyBodySchema);
    if (!parsed.ok) return parsed.response;
    const { reason, disabled } = parsed.data;

    const isDryRun = new URL(c.req.url).searchParams.get("dryRun") === "true";
    const identity = c.get("identity");

    const existing = await getKeyInfo(c.env, keyId);
    if (!existing) return c.json({ error: "key_not_found" }, 404);

    if (!isDryRun) {
      await updateKeyBlocked(c.env, keyId, disabled, identity.email);
      await auditWrite(c.env, {
        actor: identity.email,
        action: disabled ? "admin_key_disable" : "admin_key_enable",
        target: keyId,
        ip: c.req.header("cf-connecting-ip") ?? "unknown",
        ts: new Date().toISOString(),
        before: JSON.stringify({ blocked: existing.blocked }),
        after: JSON.stringify({ blocked: disabled }),
        reason,
      });
    }

    return c.json(DisableKeyResultSchema.parse({ keyId, disabled, dryRun: isDryRun }));
  });

// ---------------------------------------------------------------------------
// Admin write endpoints — low risk: PATCH /api/admin/teams/:id/limits
// ---------------------------------------------------------------------------

const adminUpdateTeamLimitsApp = new Hono<HonoEnv>()
  .use("/*", applyAuthMiddleware)
  .use("/admin/*", applyAdminRateLimit)
  .use("/admin/*", requireAdmin)
  .patch("/admin/teams/:teamId/limits", async (c) => {
    if (!isWriteOpsEnabled(c.env)) return writeOpsDisabledResponse(c);

    const teamId = decodeURIComponent(c.req.param("teamId") ?? "").trim();
    if (!teamId) return c.json({ error: "team_id_required" }, 400);

    const parsed = await parseWriteBody(c, UpdateTeamLimitsBodySchema);
    if (!parsed.ok) return parsed.response;
    const { reason, tpmLimit, rpmLimit, maxBudget } = parsed.data;

    const isDryRun = new URL(c.req.url).searchParams.get("dryRun") === "true";

    if (c.env.INDEX_DO && c.env.PORTAL_SESSION_SECRET) {
      return adminUpdateTeamLimitsDO(c.env, c, teamId, { tpmLimit, rpmLimit, maxBudget }, isDryRun);
    }

    const identity = c.get("identity");

    const existing = await getTeamInfo(c.env, teamId);
    if (!existing) return c.json({ error: "team_not_found" }, 404);

    if (!isDryRun) {
      await updateTeamLimits(c.env, teamId, { tpmLimit, rpmLimit, maxBudget }, identity.email);
      await auditWrite(c.env, {
        actor: identity.email,
        action: "admin_team_limits_update",
        target: teamId,
        ip: c.req.header("cf-connecting-ip") ?? "unknown",
        ts: new Date().toISOString(),
        before: JSON.stringify({
          tpmLimit: existing.tpmLimit,
          rpmLimit: existing.rpmLimit,
          maxBudget: existing.maxBudget,
        }),
        after: JSON.stringify({
          tpmLimit: tpmLimit ?? existing.tpmLimit,
          rpmLimit: rpmLimit ?? existing.rpmLimit,
          maxBudget: maxBudget ?? existing.maxBudget,
        }),
        reason,
      });
    }

    return c.json(
      UpdateTeamLimitsResultSchema.parse({
        teamId,
        tpmLimit: tpmLimit ?? null,
        rpmLimit: rpmLimit ?? null,
        maxBudget: maxBudget ?? null,
        dryRun: isDryRun,
      }),
    );
  });

// ---------------------------------------------------------------------------
// Admin write endpoints — medium risk: PATCH /api/admin/users/:id
// ---------------------------------------------------------------------------

const adminUpdateUserApp = new Hono<HonoEnv>()
  .use("/*", applyAuthMiddleware)
  .use("/admin/*", applyAdminRateLimit)
  .use("/admin/*", requireAdmin)
  .patch("/admin/users/:userId", async (c) => {
    if (!isWriteOpsEnabled(c.env)) return writeOpsDisabledResponse(c);

    const userId = decodeURIComponent(c.req.param("userId") ?? "").trim();
    if (!userId) return c.json({ error: "user_id_required" }, 400);

    const parsed = await parseWriteBody(c, UpdateUserBodySchema);
    if (!parsed.ok) return parsed.response;
    const { reason, role, maxBudget } = parsed.data;

    const isDryRun = new URL(c.req.url).searchParams.get("dryRun") === "true";

    if (c.env.INDEX_DO && c.env.TEAM_CONFIG_DO) {
      return adminUpdateUserDO(c.env, c, userId, { role, maxBudget }, isDryRun);
    }

    const identity = c.get("identity");

    const existing = await getUserInfo(c.env, userId);
    if (!existing) return c.json({ error: "user_not_found" }, 404);

    if (!isDryRun) {
      await updateUser(c.env, userId, { role, maxBudget }, identity.email);
      await auditWrite(c.env, {
        actor: identity.email,
        action: "admin_user_update",
        target: userId,
        ip: c.req.header("cf-connecting-ip") ?? "unknown",
        ts: new Date().toISOString(),
        before: JSON.stringify({ role: existing.role, maxBudget: existing.maxBudget }),
        after: JSON.stringify({
          role: role ?? existing.role,
          maxBudget: maxBudget ?? existing.maxBudget,
        }),
        reason,
      });
    }

    return c.json(
      UpdateUserResultSchema.parse({
        userId,
        role: role ?? null,
        maxBudget: maxBudget ?? null,
        dryRun: isDryRun,
      }),
    );
  });

// ---------------------------------------------------------------------------
// Admin write endpoints — medium risk: DELETE /api/admin/keys/:id
// ---------------------------------------------------------------------------

const adminDeleteKeyApp = new Hono<HonoEnv>()
  .use("/*", applyAuthMiddleware)
  .use("/admin/*", applyAdminRateLimit)
  .use("/admin/*", requireAdmin)
  .delete("/admin/keys/:keyId", async (c) => {
    if (!isWriteOpsEnabled(c.env)) return writeOpsDisabledResponse(c);

    const keyId = decodeURIComponent(c.req.param("keyId") ?? "").trim();
    if (!keyId) return c.json({ error: "key_id_required" }, 400);

    const parsed = await parseWriteBody(c, AdminDeleteKeyBodySchema);
    if (!parsed.ok) return parsed.response;
    const { reason, confirmAlias } = parsed.data;

    const submittedConfirm = confirmAlias?.trim() ?? "";
    if (submittedConfirm.length === 0) {
      return c.json({ error: "confirm_alias_required" }, 400);
    }

    const isDryRun = new URL(c.req.url).searchParams.get("dryRun") === "true";
    const identity = c.get("identity");

    const existing = await getKeyInfo(c.env, keyId);
    if (!existing) return c.json({ error: "key_not_found" }, 404);

    // Typed-confirmation: the submitted string MUST match the key's alias (or, if
    // the key has no alias, its public displayKey). This is the safety contract
    // the UI's ConfirmDialog enforces server-side.
    const expectedConfirm =
      existing.alias && existing.alias.trim().length > 0 ? existing.alias.trim() : (existing.displayKey?.trim() ?? "");
    if (expectedConfirm.length === 0 || submittedConfirm !== expectedConfirm) {
      return c.json({ error: "confirm_alias_mismatch" }, 403);
    }

    if (!isDryRun) {
      await deleteKeyById(c.env, keyId, identity.email);
      await auditWrite(c.env, {
        actor: identity.email,
        action: "admin_key_delete",
        target: keyId,
        ip: c.req.header("cf-connecting-ip") ?? "unknown",
        ts: new Date().toISOString(),
        before: JSON.stringify({
          keyId,
          alias: existing.alias,
          displayKey: existing.displayKey,
          userId: existing.userId,
          teamId: existing.teamId,
        }),
        after: JSON.stringify({ deleted: true }),
        reason,
      });
    }

    return c.json(AdminDeleteKeyResultSchema.parse({ keyId, dryRun: isDryRun }));
  });

// ---------------------------------------------------------------------------
// Admin-invite tenant onboarding — POST /api/admin/teams
// ---------------------------------------------------------------------------

const adminCreateTeamApp = new Hono<HonoEnv>()
  .use("/*", applyAuthMiddleware)
  .use("/admin/*", applyAdminRateLimit)
  .use("/admin/*", requireAdmin)
  .post("/admin/teams", async (c) => {
    if (!isWriteOpsEnabled(c.env)) return writeOpsDisabledResponse(c);

    const parsed = await parseWriteBody(c, AdminCreateTeamBodySchema);
    if (!parsed.ok) return parsed.response;
    const { reason, alias, models, maxBudget, tpmLimit, rpmLimit, budgetDuration } = parsed.data;

    const isDryRun = new URL(c.req.url).searchParams.get("dryRun") === "true";
    if (isDryRun) {
      return c.json(
        AdminCreateTeamResultSchema.parse({
          teamId: "(dry-run)",
          alias,
          models,
          maxBudget: maxBudget ?? null,
          dryRun: true,
        }),
      );
    }

    const identity = c.get("identity");

    let created;
    try {
      created = await createTeam(
        c.env,
        {
          alias,
          models,
          maxBudget: maxBudget ?? null,
          tpmLimit: tpmLimit ?? null,
          rpmLimit: rpmLimit ?? null,
          ...(budgetDuration ? { budgetDuration } : {}),
        },
        identity.email,
      );
    } catch (err) {
      if (err instanceof LiteLLMRequestError) {
        const status = err.status === 422 ? 422 : 502;
        return c.json({ error: "litellm_team_create_failed", detail: err.body }, status);
      }
      throw err;
    }

    // LiteLLM is authoritative for team identity. DO materialization is
    // best-effort: if it fails, the spend/teams crons reconcile from listTeams.
    try {
      if (c.env.TEAM_CONFIG_DO) {
        const teamStub = c.env.TEAM_CONFIG_DO.get(
          c.env.TEAM_CONFIG_DO.idFromName(created.teamId),
        ) as unknown as TeamConfigDOWriteStub;
        await teamStub.putTeam({
          id: created.teamId,
          alias: created.alias,
          models: created.models,
          blocked: false,
          ...(created.maxBudget != null ? { maxBudget: created.maxBudget } : {}),
          ...(tpmLimit != null ? { tpmLimit } : {}),
          ...(rpmLimit != null ? { rpmLimit } : {}),
          ...(budgetDuration ? { budgetDuration } : {}),
        });
      }
      if (c.env.INDEX_DO) {
        const idx = c.env.INDEX_DO.get(
          c.env.INDEX_DO.idFromName("index"),
        ) as unknown as IndexDOInviteStub;
        const existing = await idx.listTeams();
        await idx.setTeamsList([
          ...existing.filter((t) => t.id !== created.teamId),
          { id: created.teamId, alias: created.alias },
        ]);
      }
    } catch (err) {
      console.error("[admin_team_create] DO materialization failed (non-fatal):", err);
    }

    await auditWrite(c.env, {
      actor: identity.email,
      action: "admin_team_create",
      target: created.teamId,
      ip: c.req.header("cf-connecting-ip") ?? "unknown",
      ts: new Date().toISOString(),
      before: "null",
      after: JSON.stringify(created),
      reason,
    });

    return c.json(
      AdminCreateTeamResultSchema.parse({
        teamId: created.teamId,
        alias: created.alias,
        models: created.models,
        maxBudget: created.maxBudget,
        dryRun: false,
      }),
    );
  });

// ---------------------------------------------------------------------------
// F1/F2/F3 shared cores — exact admin logic, parametrized by team + scope.
// `scope` ("admin" | "tenant") only changes the audit action prefix; the admin
// path passes scope="admin" + the param/body teamId so its behavior is byte-for-
// byte identical to the pre-refactor handlers. The tenant path passes
// scope="tenant" + the caller's pinned identity.tenantTeamId.
// ---------------------------------------------------------------------------

type WriteScope = "admin" | "tenant";

async function listInvitesCore(
  c: Context<HonoEnv>,
  teamFilter: string | null,
): Promise<Response> {
  if (!c.env.INDEX_DO) return c.json({ error: "index_do_unavailable" }, 503);
  const statusParam = new URL(c.req.url).searchParams.get("status");
  const status =
    statusParam === "pending" || statusParam === "consumed" || statusParam === "revoked"
      ? statusParam
      : undefined;
  const idx = c.env.INDEX_DO.get(
    c.env.INDEX_DO.idFromName("index"),
  ) as unknown as IndexDOInviteStub;
  const invites = await idx.listInvites(status ? { status } : undefined);
  const scoped = teamFilter == null ? invites : invites.filter((i) => i.teamId === teamFilter);
  return c.json(AdminInviteListSchema.parse({ invites: scoped.map(inviteToPublic) }));
}

async function createInviteCore(
  c: Context<HonoEnv>,
  scope: WriteScope,
  teamId: string,
  email: string,
  teamRole: "admin" | "user",
  reason: string,
): Promise<Response> {
  const emailLc = email.toLowerCase();

  if (!c.env.TEAM_CONFIG_DO) return c.json({ error: "team_config_do_unavailable" }, 503);
  if (!c.env.INDEX_DO) return c.json({ error: "index_do_unavailable" }, 503);

  const teamStub = c.env.TEAM_CONFIG_DO.get(
    c.env.TEAM_CONFIG_DO.idFromName(teamId),
  ) as unknown as TeamConfigDOAdminStub;
  const team = await teamStub.getTeam();
  if (!team) return c.json({ error: "team_not_found" }, 404);

  const idx = c.env.INDEX_DO.get(
    c.env.INDEX_DO.idFromName("index"),
  ) as unknown as IndexDOInviteStub;
  const prior = await idx.getInvite(emailLc);
  if (prior && prior.status === "consumed") {
    return c.json({ error: "invite_already_consumed" }, 409);
  }

  const isDryRun = new URL(c.req.url).searchParams.get("dryRun") === "true";
  const record: InviteRecordShape = {
    emailLc,
    teamId,
    teamRole,
    status: "pending",
    invitedBy: c.get("identity").email,
    createdAt: new Date().toISOString(),
    consumedAt: null,
  };

  if (isDryRun) {
    return c.json(
      AdminCreateInviteResultSchema.parse({ invite: inviteToPublic(record), dryRun: true }),
    );
  }

  await idx.putInvite(record);
  await auditWrite(c.env, {
    actor: c.get("identity").email,
    action: `${scope}_invite_create`,
    target: emailLc,
    ip: c.req.header("cf-connecting-ip") ?? "unknown",
    ts: new Date().toISOString(),
    before: prior ? JSON.stringify(inviteToPublic(prior)) : "null",
    after: JSON.stringify(inviteToPublic(record)),
    reason,
  });

  return c.json(
    AdminCreateInviteResultSchema.parse({ invite: inviteToPublic(record), dryRun: false }),
  );
}

async function revokeInviteCore(
  c: Context<HonoEnv>,
  scope: WriteScope,
  restrictTeamId: string | null,
): Promise<Response> {
  const email = decodeURIComponent(c.req.param("email") ?? "").trim();
  if (!email) return c.json({ error: "email_required" }, 400);
  const emailLc = email.toLowerCase();

  const parsed = await parseWriteBody(c, AdminRevokeInviteBodySchema);
  if (!parsed.ok) return parsed.response;
  const { reason, confirmEmail } = parsed.data;
  if (confirmEmail.trim().toLowerCase() !== emailLc) {
    return c.json({ error: "confirm_email_mismatch" }, 403);
  }

  if (!c.env.INDEX_DO) return c.json({ error: "index_do_unavailable" }, 503);
  const idx = c.env.INDEX_DO.get(
    c.env.INDEX_DO.idFromName("index"),
  ) as unknown as IndexDOInviteStub;

  const isDryRun = new URL(c.req.url).searchParams.get("dryRun") === "true";
  if (isDryRun) {
    const preview = await idx.getInvite(emailLc);
    if (!preview) return c.json({ error: "invite_not_found" }, 404);
    if (restrictTeamId != null && preview.teamId !== restrictTeamId) {
      return c.json({ error: "invite_not_found" }, 404);
    }
    if (preview.status === "consumed") return c.json({ error: "invite_already_consumed" }, 409);
    return c.json(
      AdminRevokeInviteResultSchema.parse({ email: emailLc, status: preview.status, dryRun: true }),
    );
  }

  if (restrictTeamId != null) {
    const existing = await idx.getInvite(emailLc);
    if (!existing || existing.teamId !== restrictTeamId) {
      return c.json({ error: "invite_not_found" }, 404);
    }
  }

  const result = await idx.revokeInvite(emailLc);
  if (!result) return c.json({ error: "invite_not_found" }, 404);
  // revokeInvite returns a consumed invite unchanged — joining is not undone.
  if (result.status === "consumed") {
    return c.json({ error: "invite_already_consumed" }, 409);
  }

  await auditWrite(c.env, {
    actor: c.get("identity").email,
    action: `${scope}_invite_revoke`,
    target: emailLc,
    ip: c.req.header("cf-connecting-ip") ?? "unknown",
    ts: new Date().toISOString(),
    before: "pending",
    after: result.status,
    reason,
  });

  return c.json(
    AdminRevokeInviteResultSchema.parse({ email: emailLc, status: result.status, dryRun: false }),
  );
}

// ---------------------------------------------------------------------------
// Admin-invite tenant onboarding — /api/admin/invites
// ---------------------------------------------------------------------------

const adminInvitesApp = new Hono<HonoEnv>()
  .use("/*", applyAuthMiddleware)
  .use("/admin/*", applyAdminRateLimit)
  .use("/admin/*", requireAdmin)
  .get("/admin/invites", (c) => listInvitesCore(c, null))
  .post("/admin/invites", async (c) => {
    if (!isWriteOpsEnabled(c.env)) return writeOpsDisabledResponse(c);
    const parsed = await parseWriteBody(c, AdminCreateInviteBodySchema);
    if (!parsed.ok) return parsed.response;
    const { reason, email, teamId, teamRole } = parsed.data;
    return createInviteCore(c, "admin", teamId, email, teamRole, reason);
  })
  .delete("/admin/invites/:email", async (c) => {
    if (!isWriteOpsEnabled(c.env)) return writeOpsDisabledResponse(c);
    return revokeInviteCore(c, "admin", null);
  });

// ---------------------------------------------------------------------------
// Per-team budget alert webhook — /api/admin/teams/:teamId/alert-webhook
// ---------------------------------------------------------------------------

async function alertWebhookGetCore(c: Context<HonoEnv>, teamId: string): Promise<Response> {
  if (!teamId) return c.json({ error: "team_id_required" }, 400);
  if (!c.env.TEAM_CONFIG_DO) return c.json({ error: "team_config_do_unavailable" }, 503);
  const stub = c.env.TEAM_CONFIG_DO.get(
    c.env.TEAM_CONFIG_DO.idFromName(teamId),
  ) as unknown as TeamConfigDOAlertStub;
  const webhook = await stub.getAlertWebhook();
  return c.json(
    TeamAlertWebhookResultSchema.parse({
      teamId,
      url: webhook?.url ?? null,
      updatedAt: webhook?.updatedAt ?? null,
    }),
  );
}

async function alertWebhookSetCore(
  c: Context<HonoEnv>,
  scope: WriteScope,
  teamId: string,
): Promise<Response> {
  if (!isWriteOpsEnabled(c.env)) return writeOpsDisabledResponse(c);
  if (!teamId) return c.json({ error: "team_id_required" }, 400);

  const parsed = await parseWriteBody(c, SetTeamAlertWebhookBodySchema);
  if (!parsed.ok) return parsed.response;
  const { reason, url } = parsed.data;

  if (!c.env.TEAM_CONFIG_DO) return c.json({ error: "team_config_do_unavailable" }, 503);
  const stub = c.env.TEAM_CONFIG_DO.get(
    c.env.TEAM_CONFIG_DO.idFromName(teamId),
  ) as unknown as TeamConfigDOAlertStub;
  const team = await stub.getTeam();
  if (!team) return c.json({ error: "team_not_found" }, 404);

  const identity = c.get("identity");
  const prior = await stub.getAlertWebhook();
  const updatedAt = new Date().toISOString();
  await stub.setAlertWebhook({ url, updatedAt, updatedBy: identity.email });

  await auditWrite(c.env, {
    actor: identity.email,
    action: `${scope}_team_alert_webhook_set`,
    target: teamId,
    ip: c.req.header("cf-connecting-ip") ?? "unknown",
    ts: updatedAt,
    before: prior ? JSON.stringify({ url: prior.url }) : "null",
    after: JSON.stringify({ url }),
    reason,
  });

  return c.json(TeamAlertWebhookResultSchema.parse({ teamId, url, updatedAt }));
}

async function alertWebhookClearCore(
  c: Context<HonoEnv>,
  scope: WriteScope,
  teamId: string,
): Promise<Response> {
  if (!isWriteOpsEnabled(c.env)) return writeOpsDisabledResponse(c);
  if (!teamId) return c.json({ error: "team_id_required" }, 400);

  const parsed = await parseWriteBody(c, AdminRevokeInviteBodySchema.pick({ reason: true }));
  if (!parsed.ok) return parsed.response;

  if (!c.env.TEAM_CONFIG_DO) return c.json({ error: "team_config_do_unavailable" }, 503);
  const stub = c.env.TEAM_CONFIG_DO.get(
    c.env.TEAM_CONFIG_DO.idFromName(teamId),
  ) as unknown as TeamConfigDOAlertStub;
  const identity = c.get("identity");
  const prior = await stub.getAlertWebhook();
  await stub.clearAlertWebhook();

  await auditWrite(c.env, {
    actor: identity.email,
    action: `${scope}_team_alert_webhook_clear`,
    target: teamId,
    ip: c.req.header("cf-connecting-ip") ?? "unknown",
    ts: new Date().toISOString(),
    before: prior ? JSON.stringify({ url: prior.url }) : "null",
    after: "null",
    reason: parsed.data.reason,
  });

  return c.json(TeamAlertWebhookResultSchema.parse({ teamId, url: null, updatedAt: null }));
}

const adminTeamAlertWebhookApp = new Hono<HonoEnv>()
  .use("/*", applyAuthMiddleware)
  .use("/admin/*", applyAdminRateLimit)
  .use("/admin/*", requireAdmin)
  .get("/admin/teams/:teamId/alert-webhook", (c) =>
    alertWebhookGetCore(c, decodeURIComponent(c.req.param("teamId") ?? "").trim()),
  )
  .put("/admin/teams/:teamId/alert-webhook", (c) =>
    alertWebhookSetCore(c, "admin", decodeURIComponent(c.req.param("teamId") ?? "").trim()),
  )
  .delete("/admin/teams/:teamId/alert-webhook", (c) =>
    alertWebhookClearCore(c, "admin", decodeURIComponent(c.req.param("teamId") ?? "").trim()),
  );

// ---------------------------------------------------------------------------
// Admin write endpoints — PUT /api/admin/teams/:teamId/members/:userId/tenant-role
// ---------------------------------------------------------------------------

type IndexDOTenantRoleStub = {
  putTenantRole(record: {
    userId: string;
    teamId: string;
    tenantRole: "tenant_admin" | "member";
    updatedBy: string;
    updatedAt: string;
  }): Promise<void>;
  appendAudit(entry: object): Promise<void>;
};

const adminTenantRoleApp = new Hono<HonoEnv>()
  .use("/*", applyAuthMiddleware)
  .use("/admin/*", applyAdminRateLimit)
  .use("/admin/*", requireAdmin)
  .put("/admin/teams/:teamId/members/:userId/tenant-role", async (c) => {
    if (!isWriteOpsEnabled(c.env)) return writeOpsDisabledResponse(c);

    const teamId = decodeURIComponent(c.req.param("teamId") ?? "").trim();
    const userId = decodeURIComponent(c.req.param("userId") ?? "").trim();
    if (!teamId || !userId) return c.json({ error: "team_and_user_required" }, 400);

    const parsed = await parseWriteBody(c, SetTenantRoleBodySchema);
    if (!parsed.ok) return parsed.response;

    if (!c.env.INDEX_DO) return c.json({ error: "index_do_unavailable" }, 503);

    const identity = c.get("identity");
    const isDryRun = new URL(c.req.url).searchParams.get("dryRun") === "true";

    if (!isDryRun) {
      const idx = c.env.INDEX_DO.get(
        c.env.INDEX_DO.idFromName("index"),
      ) as unknown as IndexDOTenantRoleStub;
      const updatedAt = new Date().toISOString();
      await idx.putTenantRole({
        userId,
        teamId,
        tenantRole: parsed.data.tenantRole,
        updatedBy: identity.email,
        updatedAt,
      });
      await auditWrite(c.env, {
        actor: identity.email,
        action: "admin_tenant_role_set",
        target: `${teamId}/${userId}`,
        ip: c.req.header("cf-connecting-ip") ?? "unknown",
        ts: updatedAt,
        before: "null",
        after: JSON.stringify({ tenantRole: parsed.data.tenantRole }),
        reason: parsed.data.reason,
      });
    }

    return c.json(
      SetTenantRoleResultSchema.parse({
        userId,
        teamId,
        tenantRole: parsed.data.tenantRole,
        dryRun: isDryRun,
      }),
    );
  });

async function billingListCore(c: Context<HonoEnv>): Promise<Response> {
  if (!c.env.BILLING_ARCHIVE_R2) return c.json({ error: "billing_archive_unavailable" }, 503);
  const listed = await c.env.BILLING_ARCHIVE_R2.list({ prefix: "billing/" });
  const periods: string[] = [];
  for (const obj of listed.objects) {
    const match = /^billing\/(\d{4})\/(\d{2})\.csv$/u.exec(obj.key);
    if (match) periods.push(`${match[1]}-${match[2]}`);
  }
  return c.json({ periods });
}

async function readR2Text(obj: { text?: () => Promise<string>; body?: unknown }): Promise<string> {
  if (typeof obj.text === "function") return obj.text();
  // Fallbacks accommodate the test R2 stub (no .text()); production R2ObjectBody always has .text().
  const body = obj.body;
  if (typeof body === "string") return body;
  if (body instanceof ReadableStream) return new Response(body).text();
  return String(body ?? "");
}

// Splits a CSV header line into trimmed column names. The billing archive uses
// a flat comma-separated header (no embedded commas/quotes in column names), so
// a simple split is sufficient and deterministic.
function csvColumnIndex(headerLine: string, column: string): number {
  return headerLine.split(",").findIndex((h) => h.trim() === column);
}

// Keeps only rows whose `team_id` column equals the caller's team. Returns the
// header line plus matching rows (header-only when no rows match — a valid empty
// bill). If `team_id` cannot be located, fail closed to header-only so a tenant
// never receives unfiltered cross-tenant data.
function filterBillingCsvByTeam(csv: string, teamId: string): string {
  const lines = csv.split("\n");
  if (lines.length === 0) return csv;
  const header = lines[0];
  const teamCol = csvColumnIndex(header, "team_id");
  if (teamCol < 0) return header;
  const rows = lines
    .slice(1)
    .filter((line) => line.length > 0 && line.split(",")[teamCol]?.trim() === teamId);
  return [header, ...rows].join("\n");
}

async function billingDownloadCore(
  c: Context<HonoEnv>,
  scope: WriteScope,
  restrictTeamId: string | null = null,
): Promise<Response> {
  const yearMonth = decodeURIComponent(c.req.param("yearMonth") ?? "").trim();
  const match = /^(\d{4})-(\d{2})$/u.exec(yearMonth);
  if (!match) return c.json({ error: "invalid_period" }, 400);
  if (!c.env.BILLING_ARCHIVE_R2) return c.json({ error: "billing_archive_unavailable" }, 503);

  const key = `billing/${match[1]}/${match[2]}.csv`;
  const obj = await c.env.BILLING_ARCHIVE_R2.get(key);
  if (!obj) return c.json({ error: "billing_archive_not_found" }, 404);

  await auditWrite(c.env, {
    actor: c.get("identity").email,
    action: `${scope}_billing_archive_download`,
    target: yearMonth,
    ip: c.req.header("cf-connecting-ip") ?? "unknown",
    ts: new Date().toISOString(),
    before: "",
    after: "",
    reason: "",
  });

  const headers = {
    "content-type": "text/csv",
    "content-disposition": `attachment; filename="billing-${yearMonth}.csv"`,
    "cache-control": "private, no-store",
  };

  // Admin path is byte-identical: stream the original object body unchanged.
  if (restrictTeamId == null) {
    return new Response(obj.body, { headers });
  }

  // Tenant path: the archive holds one row per team across ALL tenants, so a
  // tenant_admin must only ever see their own team's row(s).
  const filtered = filterBillingCsvByTeam(await readR2Text(obj), restrictTeamId);
  return new Response(filtered, { headers });
}

const adminBillingArchiveApp = new Hono<HonoEnv>()
  .use("/*", applyAuthMiddleware)
  .use("/admin/*", applyAdminRateLimit)
  .use("/admin/*", requireAdmin)
  .get("/admin/billing", (c) => billingListCore(c))
  .get("/admin/billing/:yearMonth", (c) => billingDownloadCore(c, "admin"));

// ---------------------------------------------------------------------------
// Tenant-scoped self-serve variants — /api/tenant/* (reuse F1/F2/F3 cores)
// teamId is pinned to the caller's identity.tenantTeamId; body/param teamId is
// ignored. Gated by requireTenantAdmin (Task 4).
// ---------------------------------------------------------------------------

function tenantTeamOr403(c: Context<HonoEnv>): { ok: true; teamId: string } | { ok: false; response: Response } {
  const teamId = c.get("identity").tenantTeamId;
  if (teamId == null) return { ok: false, response: c.json({ error: "no_tenant_scope" }, 403) };
  return { ok: true, teamId };
}

const tenantInvitesApp = new Hono<HonoEnv>()
  .use("/*", applyAuthMiddleware)
  .use("/tenant/*", applyAdminRateLimit)
  .use("/tenant/*", requireTenantAdmin)
  .get("/tenant/invites", (c) => {
    const scoped = tenantTeamOr403(c);
    if (!scoped.ok) return scoped.response;
    return listInvitesCore(c, scoped.teamId);
  })
  .post("/tenant/invites", async (c) => {
    if (!isWriteOpsEnabled(c.env)) return writeOpsDisabledResponse(c);
    const scoped = tenantTeamOr403(c);
    if (!scoped.ok) return scoped.response;
    const parsed = await parseWriteBody(c, TenantCreateInviteBodySchema);
    if (!parsed.ok) return parsed.response;
    const { reason, email, teamRole } = parsed.data;
    return createInviteCore(c, "tenant", scoped.teamId, email, teamRole, reason);
  })
  .delete("/tenant/invites/:email", async (c) => {
    if (!isWriteOpsEnabled(c.env)) return writeOpsDisabledResponse(c);
    const scoped = tenantTeamOr403(c);
    if (!scoped.ok) return scoped.response;
    return revokeInviteCore(c, "tenant", scoped.teamId);
  });

const tenantAlertWebhookApp = new Hono<HonoEnv>()
  .use("/*", applyAuthMiddleware)
  .use("/tenant/*", applyAdminRateLimit)
  .use("/tenant/*", requireTenantAdmin)
  .get("/tenant/alert-webhook", (c) => {
    const scoped = tenantTeamOr403(c);
    if (!scoped.ok) return scoped.response;
    return alertWebhookGetCore(c, scoped.teamId);
  })
  .put("/tenant/alert-webhook", (c) => {
    const scoped = tenantTeamOr403(c);
    if (!scoped.ok) return scoped.response;
    return alertWebhookSetCore(c, "tenant", scoped.teamId);
  })
  .delete("/tenant/alert-webhook", (c) => {
    const scoped = tenantTeamOr403(c);
    if (!scoped.ok) return scoped.response;
    return alertWebhookClearCore(c, "tenant", scoped.teamId);
  });

const tenantBillingApp = new Hono<HonoEnv>()
  .use("/*", applyAuthMiddleware)
  .use("/tenant/*", applyAdminRateLimit)
  .use("/tenant/*", requireTenantAdmin)
  .get("/tenant/billing", (c) => billingListCore(c))
  .get("/tenant/billing/:yearMonth", (c) => {
    const scoped = tenantTeamOr403(c);
    if (!scoped.ok) return scoped.response;
    return billingDownloadCore(c, "tenant", scoped.teamId);
  });

// ---------------------------------------------------------------------------
// Top-level app mounts /api/* with global error handler
// ---------------------------------------------------------------------------

const app = new Hono<{ Bindings: LiteLLMPortalEnv }>()
  .onError((err, c) => {
    const message = err instanceof Error ? err.message : "internal_error";
    const status = message === "litellm_config_missing" ? 500 : 502;
    return c.json({ error: message }, status);
  })
  // Unauthenticated internal webhook — must be mounted before any auth-gated sub-apps.
  // Hono v4: use("/*", mw) in a sub-app intercepts all paths, so unauthenticated routes
  // must precede auth-gated sub-apps in the mount order.
  .route("/api", internalRoleChangedApp)
  .route("/api", meApp)
  .route("/api", preferencesApp)
  .route("/api", dashboardApp)
  .route("/api", modelsApp)
  .route("/api", keysGetApp)
  .route("/api", keysPostApp)
  .route("/api", keysDeleteApp)
  .route("/api", usageApp)
  .route("/api", usageOverviewApp)
  .route("/api", adminUsersApp)
  .route("/api", adminTeamsApp)
  .route("/api", adminAuditApp)
  .route("/api", adminUsageOverviewApp)
  .route("/api", adminPreferencesDefaultsApp)
  .route("/api", adminRolesInvalidateApp)
  .route("/api", adminDOStorageApp)
  .route("/api", adminDisableKeyApp)
  .route("/api", adminUpdateTeamLimitsApp)
  .route("/api", adminUpdateUserApp)
  .route("/api", adminDeleteKeyApp)
  .route("/api", adminCreateTeamApp)
  .route("/api", adminInvitesApp)
  .route("/api", adminTeamAlertWebhookApp)
  .route("/api", adminTenantRoleApp)
  .route("/api", adminBillingArchiveApp)
  .route("/api", tenantInvitesApp)
  .route("/api", tenantAlertWebhookApp)
  .route("/api", tenantBillingApp)
  .all("/*", (c) => c.json({ error: "not_found" }, 404));

export { app };
export type AppType = typeof app;
