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
  deleteKey,
  deleteKeyById,
  getKeyInfo,
  getTeamInfo,
  getUserInfo,
  KeyAliasConflictError,
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
import { parseUsageTimeseriesRequest, readGlobalUsageTimeseries, readUsageTimeseries } from "./timeseries";
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
  AdminSummarySchema,
  UsageSchema,
  UsageTimeseriesSchema,
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
} from "./schemas";
import { auditWrite } from "./observability/audit";
import type { LiteLLMKey, LiteLLMTeam, JsonValue } from "./types";

type HonoEnv = { Bindings: LiteLLMPortalEnv; Variables: { identity: PortalIdentity } };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ADMIN_SUMMARY_PAGE_SIZE = 100;

function isAdminRole(role: string | null): boolean {
  return role === "proxy_admin" || role === "proxy_admin_viewer";
}

function isManagedRole(role: string | null): boolean {
  return role === "proxy_admin"
    || role === "proxy_admin_viewer"
    || role === "internal_user"
    || role === "internal_user_viewer"
    || role === "team"
    || role === "customer";
}

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
  const teamModels = key.teamId === null
    ? []
    : teams.find((t) => t.id === key.teamId)?.models ?? [];
  const models = key.models.length > 0
    ? key.models
    : teamModels.length > 0
      ? teamModels
      : fallbackModels;
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

// ---------------------------------------------------------------------------
// One-route-per-sub-app typed chains (avoids TS2589 from long accumulation)
// ---------------------------------------------------------------------------

const meApp = new Hono<HonoEnv>()
  .use("/*", applyAuthMiddleware)
  .get("/me", (c) => {
    const identity = c.get("identity");
    return c.json(MeSchema.parse({
      email: identity.email,
      userId: identity.litellmUserId,
      company: portalCompanyName(c.env),
      domain: identity.domain,
      role: identity.role,
    }));
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
      return c.json(ErrorResponseSchema.parse({
        error: "validation_error",
        path: firstIssue?.path.join(".") ?? "",
        message: firstIssue?.message ?? "invalid_preferences",
      }), 422);
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
      return c.json(ErrorResponseSchema.parse({
        error: "validation_error",
        path: firstIssue?.path.join(".") ?? "",
        message: firstIssue?.message ?? "invalid_preferences",
      }), 422);
    }
    const store = new KVUserPrefsStore(c.env.USER_PREFS_KV);
    const next = await store.patchGlobalDefaults(parsed.data);
    return c.json(UserPreferencesSchema.parse(next));
  });

const dashboardApp = new Hono<HonoEnv>()
  .use("/*", applyAuthMiddleware)
  .get("/dashboard", async (c) => {
    const identity = c.get("identity");
    const data = await loadDashboard(c.env, identity);
    return c.json(DashboardSchema.parse(data));
  });

const modelsApp = new Hono<HonoEnv>()
  .use("/*", applyAuthMiddleware)
  .get("/models", async (c) => {
    const identity = c.get("identity");
    const user = await resolveLiteLLMUser(c.env, identity.email);
    const result = await readAvailableModels(c.env, user);
    return c.json(ModelsSchema.parse(result));
  });

const keysGetApp = new Hono<HonoEnv>()
  .use("/*", applyAuthMiddleware)
  .get("/keys", async (c) => {
    const identity = c.get("identity");
    const user = await resolveLiteLLMUser(c.env, identity.email);
    const keyList = await listUserKeys(c.env, user.userId);
    const teamIds = keyAwareTeamIds(user.teamIds, keyList.keys);
    const teams = await readUserTeams(c.env, teamIds);
    const modelAccess = await readAvailableModelsFromTeams(c.env, teamIds, teams);
    return c.json(KeysSchema.parse({
      litellmUserId: user.userId,
      totalCount: keyList.totalCount,
      keys: keyList.keys.map((key) => publicKeyWithModels(key, teams, modelAccess.models, c.env)),
    }));
  });

const keysPostApp = new Hono<HonoEnv>()
  .use("/*", applyAuthMiddleware)
  .post("/keys", async (c) => {
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
      return c.json(ErrorResponseSchema.parse({
        error: "validation_error",
        path: firstIssue?.path.join(".") ?? "",
        message: firstIssue?.message ?? "invalid_request",
      }), 422);
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
        return c.json({
          error: "key_alias_conflict",
          keyAlias: error.keyAlias,
          message: "API Key name already exists",
        }, 409);
      }
      throw error;
    }
  });

const keysDeleteApp = new Hono<HonoEnv>()
  .use("/*", applyAuthMiddleware)
  .delete("/keys/:keyId", async (c) => {
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

const usageApp = new Hono<HonoEnv>()
  .use("/*", applyAuthMiddleware)
  .get("/usage", async (c) => {
    const identity = c.get("identity");
    const user = await resolveLiteLLMUser(c.env, identity.email);
    const keyList = await listUserKeys(c.env, user.userId);
    const teamIds = keyAwareTeamIds(user.teamIds, keyList.keys);
    const teams = await readUserTeams(c.env, teamIds);
    const modelAccess = await readAvailableModelsFromTeams(c.env, teamIds, teams);
    const keySpend = roundCurrency(keyList.keys.reduce((sum, key) => sum + key.spend, 0));
    return c.json(UsageSchema.parse({
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
    }));
  });

const usageTimeseriesApp = new Hono<HonoEnv>()
  .use("/*", applyAuthMiddleware)
  .get("/usage/timeseries", async (c) => {
    const identity = c.get("identity");
    const requestParams = parseUsageTimeseriesRequest(new URL(c.req.url));
    if (!requestParams.ok) {
      return c.json(requestParams.body as Record<string, string>, 400);
    }
    const user = await resolveLiteLLMUser(c.env, identity.email);
    const result = await readUsageTimeseries(c.env, user.userId, requestParams.grain, requestParams.window);
    return c.json(UsageTimeseriesSchema.parse(result));
  });

const adminSummaryApp = new Hono<HonoEnv>()
  .use("/*", applyAuthMiddleware)
  .use("/admin/*", applyAdminRateLimit)
  .use("/admin/*", requireAdmin)
  .get("/admin/summary", async (c) => {
    const [userPage, teams] = await Promise.all([
      listAllUsers(c.env, { page: 1, size: ADMIN_SUMMARY_PAGE_SIZE }),
      listAllTeams(c.env),
    ]);
    const users = userPage.users;
    const sampledUserCount = users.length;
    const limited = userPage.totalCount > sampledUserCount;
    const overBudgetUserCount = users.filter((u) => u.maxBudget != null && Number(u.spend ?? 0) >= u.maxBudget).length;
    const overBudgetTeamCount = teams.filter((t) => t.maxBudget != null && Number(t.spend ?? 0) >= t.maxBudget).length;
    const noTeamUserCount = users.filter((u) => u.teamIds.length === 0).length;
    const unmanagedRoleCount = users.filter((u) => !isManagedRole(u.role)).length;
    return c.json(AdminSummarySchema.parse({
      userCount: userPage.totalCount,
      sampledUserCount,
      limited,
      teamCount: teams.length,
      adminCount: users.filter((u) => isAdminRole(u.role)).length,
      unmanagedRoleCount,
      noTeamUserCount,
      overBudgetUserCount,
      overBudgetTeamCount,
      riskCount: overBudgetUserCount + overBudgetTeamCount + unmanagedRoleCount,
      totalSpend: roundCurrency(users.reduce((sum, u) => sum + Number(u.spend ?? 0), 0)),
      teamSpend: roundCurrency(teams.reduce((sum, t) => sum + Number(t.spend ?? 0), 0)),
      totalBudget: sumDefinedNumbers([
        ...users.map((u) => u.maxBudget),
        ...teams.map((t) => t.maxBudget),
      ]),
    }));
  });

const adminUsersApp = new Hono<HonoEnv>()
  .use("/*", applyAuthMiddleware)
  .use("/admin/*", applyAdminRateLimit)
  .use("/admin/*", requireAdmin)
  .get("/admin/users", async (c) => {
    const url = new URL(c.req.url);
    const page = sanitizeIntParam(url.searchParams.get("page"), 1);
    const size = sanitizeIntParam(url.searchParams.get("size"), 50);
    const result = await listAllUsers(c.env, { page, size });
    return c.json(AdminUsersSchema.parse({
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
    }));
  });

const adminTeamsApp = new Hono<HonoEnv>()
  .use("/*", applyAuthMiddleware)
  .use("/admin/*", applyAdminRateLimit)
  .use("/admin/*", requireAdmin)
  .get("/admin/teams", async (c) => {
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
    return c.json(AdminAuditSchema.parse({
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
    }));
  });

const adminUsageTimeseriesApp = new Hono<HonoEnv>()
  .use("/*", applyAuthMiddleware)
  .use("/admin/*", applyAdminRateLimit)
  .use("/admin/*", requireAdmin)
  .get("/admin/usage/timeseries", async (c) => {
    const parsed = parseUsageTimeseriesRequest(new URL(c.req.url));
    if (!parsed.ok) {
      return c.json(parsed.body as Record<string, string>, 400);
    }
    const timeseries = await readGlobalUsageTimeseries(c.env, parsed.grain, parsed.window);
    return c.json(UsageTimeseriesSchema.parse(timeseries));
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

const internalRoleChangedApp = new Hono<{ Bindings: LiteLLMPortalEnv }>()
  .post("/_internal/role-changed", async (c) => {
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
      response: c.json({
        error: "validation_error",
        path: pathSegments.join("."),
        message: firstIssue?.message ?? "invalid_request",
      }, 422),
    };
  }
  return { ok: true, data: parsed.data };
}

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
      auditWrite(c.env, {
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
    const identity = c.get("identity");

    const existing = await getTeamInfo(c.env, teamId);
    if (!existing) return c.json({ error: "team_not_found" }, 404);

    if (!isDryRun) {
      await updateTeamLimits(c.env, teamId, { tpmLimit, rpmLimit, maxBudget }, identity.email);
      auditWrite(c.env, {
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

    return c.json(UpdateTeamLimitsResultSchema.parse({
      teamId,
      tpmLimit: tpmLimit ?? null,
      rpmLimit: rpmLimit ?? null,
      maxBudget: maxBudget ?? null,
      dryRun: isDryRun,
    }));
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
    const identity = c.get("identity");

    const existing = await getUserInfo(c.env, userId);
    if (!existing) return c.json({ error: "user_not_found" }, 404);

    if (!isDryRun) {
      await updateUser(c.env, userId, { role, maxBudget }, identity.email);
      auditWrite(c.env, {
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

    return c.json(UpdateUserResultSchema.parse({
      userId,
      role: role ?? null,
      maxBudget: maxBudget ?? null,
      dryRun: isDryRun,
    }));
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
    const expectedConfirm = (existing.alias && existing.alias.trim().length > 0)
      ? existing.alias.trim()
      : existing.displayKey?.trim() ?? "";
    if (expectedConfirm.length === 0 || submittedConfirm !== expectedConfirm) {
      return c.json({ error: "confirm_alias_mismatch" }, 403);
    }

    if (!isDryRun) {
      await deleteKeyById(c.env, keyId, identity.email);
      auditWrite(c.env, {
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
  .route("/api", usageTimeseriesApp)
  .route("/api", adminSummaryApp)
  .route("/api", adminUsersApp)
  .route("/api", adminTeamsApp)
  .route("/api", adminAuditApp)
  .route("/api", adminUsageTimeseriesApp)
  .route("/api", adminPreferencesDefaultsApp)
  .route("/api", adminRolesInvalidateApp)
  .route("/api", adminDisableKeyApp)
  .route("/api", adminUpdateTeamLimitsApp)
  .route("/api", adminUpdateUserApp)
  .route("/api", adminDeleteKeyApp)
  .all("/*", (c) => c.json({ error: "not_found" }, 404));

export { app };
export type AppType = typeof app;
