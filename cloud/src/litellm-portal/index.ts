import { portalAppJs } from "./app.generated";
import { kumoStandaloneCss } from "./kumo-css.generated";
import { authenticateRequest } from "./auth";
import {
  csv,
  cssResponse,
  htmlResponse,
  javascriptResponse,
  jsonResponse,
  portalCompanyName,
  roundCurrency,
  securityHeaders,
  sumDefinedNumbers,
  uniqueSorted,
} from "./utils";
import {
  configuredAllowedModels,
  createKey,
  deleteKey,
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
import { adminListUsers, adminListTeams, adminListAuditEvents, adminGlobalUsageTimeseries, adminSummary } from "./admin";
import type { JsonValue, LiteLLMKey, LiteLLMPortalEnv, LiteLLMTeam, PortalIdentity } from "./types";
import { recordMetric } from "./observability/metrics";
import { recordAudit } from "./observability/audit";
import { checkClientErrorRateLimit, recordClientError } from "./observability/client-error";
import type { ClientErrorPayload } from "./observability/client-error";

export type { LiteLLMPortalEnv } from "./types";

export async function handleLiteLLMPortalRequest(request: Request, env: LiteLLMPortalEnv): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: securityHeaders() });
  }

  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    const nonce = crypto.randomUUID().replace(/-/g, "");
    const { renderPortalSSR } = await import("./server");
    try {
      const auth = await authenticateRequest(request, env);
      if (auth.ok) {
        const identityResult = await resolveIdentity(env, auth.principal);
        if (identityResult.ok) {
          let dashboard: Record<string, JsonValue> | null = null;
          let dashboardError: string | null = null;
          try {
            dashboard = await loadDashboard(env, identityResult.identity);
          } catch (err) {
            dashboardError = err instanceof Error ? err.message : "dashboard_load_failed";
          }
          const initialData: JsonValue = dashboard !== null
            ? dashboard
            : { error: dashboardError ?? "dashboard_load_failed" };
          const html = await renderPortalSSR(env, identityResult.identity, initialData, nonce);
          return htmlResponse(html);
        }
      }
    } catch {
      // fall through to unauthenticated shell
    }
    const html = await renderPortalSSR(env, { email: "", userId: "", domain: "", litellmUserId: "", role: "none" }, null, nonce);
    return htmlResponse(html);
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

  // Client-error endpoint: no auth required, rate-limited per session
  if (request.method === "POST" && url.pathname === "/api/_internal/client-error") {
    return handleClientError(request, env);
  }

  const apiStart = Date.now();
  const auth = await authenticateRequest(request, env);
  if (!auth.ok) {
    recordMetric(env, {
      route: url.pathname,
      status: auth.status,
      latencyMs: Date.now() - apiStart,
      upstreamMs: 0,
      role: "none",
      cacheHit: false,
    });
    return jsonResponse({ error: auth.error }, auth.status);
  }

  try {
    const identityResult = await resolveIdentity(env, auth.principal);
    if (!identityResult.ok) {
      recordMetric(env, {
        route: url.pathname,
        status: identityResult.status,
        latencyMs: Date.now() - apiStart,
        upstreamMs: 0,
        role: "none",
        cacheHit: false,
      });
      return jsonResponse({ error: identityResult.error }, identityResult.status);
    }

    if (url.pathname.startsWith("/api/admin/")) {
      recordAudit(env, {
        actor: identityResult.identity.email,
        action: url.pathname,
        target: url.search ? url.search.slice(1) : "",
        ip: request.headers.get("cf-connecting-ip") ?? "unknown",
        ts: new Date().toISOString(),
      });
    }

    const upstreamStart = Date.now();
    const response = await routeApiRequest(request, env, identityResult.identity);
    recordMetric(env, {
      route: url.pathname,
      status: response.status,
      latencyMs: Date.now() - apiStart,
      upstreamMs: Date.now() - upstreamStart,
      role: identityResult.identity.role,
      cacheHit: false,
    });
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : "internal_error";
    const status = message === "litellm_config_missing" ? 500 : 502;
    recordMetric(env, {
      route: url.pathname,
      status,
      latencyMs: Date.now() - apiStart,
      upstreamMs: 0,
      role: "none",
      cacheHit: false,
    });
    return jsonResponse({ error: message }, status);
  }
}

async function handleClientError(request: Request, env: LiteLLMPortalEnv): Promise<Response> {
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  let payload: ClientErrorPayload;
  try {
    payload = await request.json() as ClientErrorPayload;
  } catch {
    return jsonResponse({ error: "invalid_json" }, 400);
  }
  if (!Array.isArray(payload?.events) || payload.events.length === 0) {
    return jsonResponse({ error: "events_required" }, 400);
  }

  const firstEvent = payload.events[0];
  const sessionId = typeof firstEvent?.sessionId === "string" ? firstEvent.sessionId : "unknown";

  if (!checkClientErrorRateLimit(sessionId)) {
    recordAudit(env, {
      actor: `session:${sessionId}`,
      action: "client_error_rate_limited",
      target: "",
      ip,
      ts: new Date().toISOString(),
    });
    return jsonResponse({ error: "rate_limited" }, 429);
  }

  for (const event of payload.events) {
    if (typeof event?.message === "string" && typeof event?.sessionId === "string") {
      recordClientError(env, {
        message: event.message,
        stack: typeof event.stack === "string" ? event.stack : undefined,
        sessionId: event.sessionId,
        ts: typeof event.ts === "string" ? event.ts : new Date().toISOString(),
      }, ip);
    }
  }

  return jsonResponse({ ok: true });
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
    return jsonResponse(await loadDashboard(env, identity));
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

  if (request.method === "DELETE" && url.pathname.startsWith("/api/keys/")) {
    const encodedKeyId = url.pathname.slice("/api/keys/".length);
    let keyId = "";
    try {
      keyId = decodeURIComponent(encodedKeyId).trim();
    } catch {
      return jsonResponse({ error: "key_id_required" }, 400);
    }
    if (!keyId) {
      return jsonResponse({ error: "key_id_required" }, 400);
    }

    const user = await resolveLiteLLMUser(env, identity.email);
    if (!user.found) {
      return jsonResponse({ error: "user_not_found" }, 400);
    }

    const keyList = await listUserKeys(env, user.userId);
    const key = keyList.keys.find((item) => item.id === keyId);
    if (key === undefined) {
      return jsonResponse({ error: "key_not_found" }, 404);
    }

    await deleteKey(env, key, identity.email);
    return new Response(null, { status: 204, headers: securityHeaders() });
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
    if (url.pathname === "/api/admin/summary") {
      return adminSummary(request, env);
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
