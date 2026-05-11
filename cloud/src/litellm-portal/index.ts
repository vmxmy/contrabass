import { portalAppJs } from "./app.generated";
import { kumoStandaloneCss } from "./kumo-css.generated";
import { authenticateRequest } from "./auth";
import {
  csv,
  cssResponse,
  htmlResponse,
  javascriptResponse,
  jsonResponse,
  roundCurrency,
  securityHeaders,
  sumDefinedNumbers,
  uniqueSorted,
} from "./utils";
import { portalCompanyName, renderPortalHtml } from "./html";
import {
  configuredAllowedModels,
  createKey,
  KeyAliasConflictError,
  listUserKeys,
  publicKey,
  publicTeam,
  readAvailableModels,
  readAvailableModelsFromTeams,
  readUserTeams,
  resolveLiteLLMUser,
} from "./litellm";
import { resolveIdentity } from "./roles";
import { parseUsageTimeseriesRequest, readUsageTimeseries } from "./timeseries";
import { readUserDailyActivity } from "./usage";
import { adminListUsers, adminListTeams, adminListAuditEvents, adminGlobalUsageTimeseries } from "./admin";
import type { JsonValue, LiteLLMKey, LiteLLMPortalEnv, LiteLLMTeam, PortalIdentity } from "./types";

export type { LiteLLMPortalEnv } from "./types";

export async function handleLiteLLMPortalRequest(request: Request, env: LiteLLMPortalEnv): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: securityHeaders() });
  }

  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    return htmlResponse(renderPortalHtml(env));
  }

  if (request.method === "GET" && url.pathname === "/kumo.css") {
    return cssResponse(kumoStandaloneCss);
  }

  if (request.method === "GET" && url.pathname === "/portal.js") {
    return javascriptResponse(portalAppJs);
  }

  if (request.method === "GET" && url.pathname === "/favicon.ico") {
    return new Response(null, { status: 204, headers: securityHeaders() });
  }

  if (!url.pathname.startsWith("/api/")) {
    return jsonResponse({ error: "not_found" }, 404);
  }

  const auth = await authenticateRequest(request, env);
  if (!auth.ok) {
    return jsonResponse({ error: auth.error }, auth.status);
  }

  try {
    const identityResult = await resolveIdentity(env, auth.principal);
    if (!identityResult.ok) {
      return jsonResponse({ error: identityResult.error }, identityResult.status);
    }
    return await routeApiRequest(request, env, identityResult.identity);
  } catch (error) {
    const message = error instanceof Error ? error.message : "internal_error";
    return jsonResponse({ error: message }, message === "litellm_config_missing" ? 500 : 502);
  }
}

function requireAdmin(identity: PortalIdentity): Response | null {
  if (identity.role !== "admin") {
    return jsonResponse({ error: "admin_required" }, 403);
  }
  return null;
}

async function routeApiRequest(
  request: Request,
  env: LiteLLMPortalEnv,
  identity: PortalIdentity,
): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/api/me") {
    return jsonResponse({
      email: identity.email,
      userId: identity.litellmUserId,
      company: portalCompanyName(env),
      domain: identity.domain,
      role: identity.role,
    });
  }

  if (request.method === "GET" && url.pathname === "/api/dashboard") {
    return jsonResponse(await readDashboard(env, identity));
  }

  if (request.method === "GET" && url.pathname === "/api/models") {
    const user = await resolveLiteLLMUser(env, identity.email);
    return jsonResponse(await readAvailableModels(env, user));
  }

  if (request.method === "GET" && url.pathname === "/api/keys") {
    const user = await resolveLiteLLMUser(env, identity.email);
    const keyList = await listUserKeys(env, user.userId);
    const teamIds = keyAwareTeamIds(user.teamIds, keyList.keys);
    const teams = await readUserTeams(env, teamIds);
    const modelAccess = await readAvailableModelsFromTeams(env, teamIds, teams);
    return jsonResponse({
      litellmUserId: user.userId,
      totalCount: keyList.totalCount,
      keys: keyList.keys.map((key) => publicKeyWithModels(key, teams, modelAccess.models, env)),
    });
  }

  if (request.method === "POST" && url.pathname === "/api/keys") {
    const user = await resolveLiteLLMUser(env, identity.email);
    if (!user.found) {
      return jsonResponse({ error: "user_not_found" }, 400);
    }
    const body = await request.json() as Record<string, unknown>;
    const keyAlias = typeof body.keyAlias === "string" ? body.keyAlias.trim() : "";
    if (!keyAlias) {
      return jsonResponse({ error: "key_alias_required" }, 400);
    }
    const models = Array.isArray(body.models)
      ? body.models.filter((m): m is string => typeof m === "string")
      : undefined;
    const maxBudget = typeof body.maxBudget === "number" && Number.isFinite(body.maxBudget) && body.maxBudget >= 0
      ? body.maxBudget
      : null;
    const duration = typeof body.duration === "string" && body.duration.length > 0
      ? body.duration
      : null;
    try {
      const result = await createKey(env, user.userId, { keyAlias, models, maxBudget, duration });
      return jsonResponse(result, 201);
    } catch (error) {
      if (error instanceof KeyAliasConflictError) {
        return jsonResponse({
          error: "key_alias_conflict",
          keyAlias: error.keyAlias,
          message: "API Key name already exists",
        }, 409);
      }
      throw error;
    }
  }

  if (request.method === "GET" && url.pathname === "/api/usage") {
    const user = await resolveLiteLLMUser(env, identity.email);
    const keyList = await listUserKeys(env, user.userId);
    const teamIds = keyAwareTeamIds(user.teamIds, keyList.keys);
    const teams = await readUserTeams(env, teamIds);
    const modelAccess = await readAvailableModelsFromTeams(env, teamIds, teams);
    const keySpend = roundCurrency(keyList.keys.reduce((sum, key) => sum + key.spend, 0));
    return jsonResponse({
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
        models: keyDisplayModels(key, teams, modelAccess.models, env),
      })),
    });
  }

  if (request.method === "GET" && url.pathname === "/api/usage/timeseries") {
    const requestParams = parseUsageTimeseriesRequest(url);
    if (!requestParams.ok) {
      return jsonResponse(requestParams.body, 400);
    }
    const user = await resolveLiteLLMUser(env, identity.email);
    return jsonResponse(await readUsageTimeseries(env, user.userId, requestParams.grain, requestParams.window));
  }

  if (request.method === "GET" && url.pathname.startsWith("/api/admin/")) {
    const gate = requireAdmin(identity);
    if (gate !== null) {
      return gate;
    }
    if (url.pathname === "/api/admin/users") {
      return adminListUsers(request, env);
    }
    if (url.pathname === "/api/admin/teams") {
      return adminListTeams(request, env);
    }
    if (url.pathname === "/api/admin/audit") {
      return adminListAuditEvents(request, env);
    }
    if (url.pathname === "/api/admin/usage/timeseries") {
      return adminGlobalUsageTimeseries(request, env);
    }
    return jsonResponse({ error: "not_found" }, 404);
  }

  return jsonResponse({ error: "not_found" }, 404);
}

async function readDashboard(
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

function keyAwareTeamIds(userTeamIds: string[], keys: LiteLLMKey[]): string[] {
  return uniqueSorted([
    ...userTeamIds,
    ...keys.map((key) => key.teamId).filter((teamId): teamId is string => typeof teamId === "string" && teamId.trim().length > 0),
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
    : teams.find((team) => team.id === key.teamId)?.models ?? [];
  const models = key.models.length > 0
    ? key.models
    : teamModels.length > 0
      ? teamModels
      : fallbackModels;
  return configured.length > 0
    ? models.filter((model) => configured.includes(model))
    : models;
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

export default {
  fetch: handleLiteLLMPortalRequest,
} satisfies ExportedHandler<LiteLLMPortalEnv>;
