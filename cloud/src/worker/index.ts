import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";

import { configParseError, isConfigParseError, renderWorkflowConfig } from "../config/parser";
import type { ConfigValidationDetail } from "../config/parser";
import type { EventArchiveMessage } from "../queues/events-archive";
import { PROTOCOL_VERSION_CURRENT } from "../workerproto/v1";
import type {
  WorkerRefreshRequest,
  WorkerRefreshResponse,
  WorkerRegisterRequest,
  WorkerRegisterResponse,
} from "../workerproto/v1";

export type Env = {
  ARTIFACTS_BUCKET?: R2Bucket;
  CONTROL_PLANE_DB?: D1Database;
  EVENTS_ARCHIVE_BUCKET: R2Bucket;
  EVENTS_ARCHIVE_QUEUE: Queue<EventArchiveMessage>;
  ISSUE_RUN: DurableObjectNamespace;
  TEAM_COORDINATOR: DurableObjectNamespace;
  CONTRABASS_DASHBOARD_ORIGIN?: string;
  CONTRABASS_WORKER_SESSION_TOKENS?: string;
  CONTRABASS_DASHBOARD_SESSION_TOKENS?: string;
  CONTRABASS_WORKER_TOKEN_SECRET?: string;
  CONTRABASS_CONFIG_BOUND_SECRETS?: string;
  CONTRABASS_CONFIG_LIQUID_CONTEXT?: string;
  CONTRABASS_DASHBOARD_SESSION_SECRET?: string;
  CONTRABASS_GITHUB_CLIENT_ID?: string;
  CONTRABASS_GITHUB_CLIENT_SECRET?: string;
  CONTRABASS_GITHUB_AUTHORIZE_URL?: string;
  CONTRABASS_GITHUB_TOKEN_URL?: string;
  CONTRABASS_GITHUB_USER_URL?: string;
};

type AuthPrincipalKind = "bearer" | "dashboard-session";

export type AuthPrincipal = {
  kind: AuthPrincipalKind;
  token: string;
} | {
  kind: "bearer";
  token: string;
  teamId: string;
  workerId: string;
  issued: true;
} | {
  kind: "dashboard-session";
  token: string;
  githubId: number;
  githubLogin: string;
  issued: true;
};

type WorkerRouterEnv = {
  Bindings: Env;
  Variables: {
    principal: AuthPrincipal;
  };
};

const DASHBOARD_SESSION_COOKIE_NAME = "contrabass_session";
const DASHBOARD_OAUTH_STATE_COOKIE_NAME = "contrabass_oauth_state";
const SESSION_TOKEN_TTL_MS = 60 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DASHBOARD_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const HEARTBEAT_INTERVAL_SEC = 20;
const LEASE_SEC = 60;
const SUPPORTED_PROTOCOL_VERSIONS = [PROTOCOL_VERSION_CURRENT] as const;
const API_VERSION_HEADER = "X-Contrabass-Api-Version";

export const workerRouter = new Hono<WorkerRouterEnv>();

workerRouter.use("*", apiVersionHeaderMiddleware());
workerRouter.use("/v1/*", authMiddleware());

workerRouter.get("/v1/auth/github/login", startGitHubOAuth);
workerRouter.get("/v1/auth/github/callback", completeGitHubOAuth);

workerRouter.get("/v1/teams/:teamId/board", (context) => {
  return forwardTeamCoordinatorRequest(context, "/board");
});

workerRouter.post("/v1/teams/:teamId/board/*", forwardTeamCoordinatorBoardPostRequest);
workerRouter.post("/v1/teams/:teamId/config", createTeamConfig);
workerRouter.post("/v1/teams/:teamId/config/:version/activate", activateTeamConfigVersion);
workerRouter.get("/v1/teams/:teamId/config/diff", getTeamConfigDiff);
workerRouter.get("/v1/teams/:teamId/config/:hash", getTeamConfigByHash);

workerRouter.post("/v1/workers/register", registerWorker);
workerRouter.post("/v1/workers/refresh", refreshWorkerSession);
workerRouter.post("/v1/workers/enroll", enrollWorker);

workerRouter.post("/v1/runs/:runId/ack", (context) => {
  return forwardIssueRunRequest(context, "/ack");
});
workerRouter.post("/v1/runs/:runId/heartbeat", (context) => {
  return forwardIssueRunRequest(context, "/heartbeat");
});
workerRouter.post("/v1/runs/:runId/events", (context) => {
  return forwardIssueRunRequest(context, "/events");
});
workerRouter.post("/v1/runs/:runId/complete", (context) => {
  return forwardIssueRunRequest(context, "/complete");
});

workerRouter.get("/v1/workers/:workerId/dispatch", longPollWorkerDispatch);
workerRouter.get("/v1/workers/:workerId/dispatch-ws", websocketWorkerDispatch);

workerRouter.get("/v1/teams/:teamId/subscribe", (context) => {
  return forwardTeamCoordinatorRequest(context, "/subscribe");
});

workerRouter.notFound(() => {
  return errorResponse("not_found", 404);
});

export async function handleWorkerRequest(request: Request, env: Env): Promise<Response> {
  return workerRouter.fetch(request, env);
}

function apiVersionHeaderMiddleware(): MiddlewareHandler<WorkerRouterEnv> {
  return async (context, next) => {
    await next();
    context.header(API_VERSION_HEADER, PROTOCOL_VERSION_CURRENT);
  };
}

function authMiddleware(): MiddlewareHandler<WorkerRouterEnv> {
  return async (context, next) => {
    if (isPublicWorkerAuthRoute(context.req.raw)) {
      await next();
      return;
    }

    const principal = await validateAuthPrincipal(context.req.raw, context.env);
    if (principal === undefined) {
      return errorResponse("unauthorized", 401);
    }

    context.set("principal", principal);
    await next();
  };
}

export async function validateAuthPrincipal(request: Request, env: Env): Promise<AuthPrincipal | undefined> {
  const bearerToken = extractBearerToken(request.headers.get("authorization"));
  const issuedSession = bearerToken === undefined ? undefined : await validateIssuedSessionToken(bearerToken, env);
  if (bearerToken !== undefined && issuedSession !== undefined) {
    return {
      kind: "bearer",
      token: bearerToken,
      teamId: issuedSession.teamId,
      workerId: issuedSession.workerId,
      issued: true,
    };
  }
  if (bearerToken !== undefined && isConfiguredToken(bearerToken, env.CONTRABASS_WORKER_SESSION_TOKENS)) {
    return { kind: "bearer", token: bearerToken };
  }

  const sessionToken = extractDashboardSessionCookie(request.headers.get("cookie"));
  if (sessionToken !== undefined) {
    const issuedDashboardSession = await validateDashboardSessionToken(sessionToken, env);
    if (issuedDashboardSession !== undefined) {
      return {
        kind: "dashboard-session",
        token: sessionToken,
        githubId: issuedDashboardSession.githubId,
        githubLogin: issuedDashboardSession.githubLogin,
        issued: true,
      };
    }
    if (isConfiguredToken(sessionToken, env.CONTRABASS_DASHBOARD_SESSION_TOKENS)) {
      return { kind: "dashboard-session", token: sessionToken };
    }
  }

  return undefined;
}

async function startGitHubOAuth(context: Context<WorkerRouterEnv>): Promise<Response> {
  const clientId = context.env.CONTRABASS_GITHUB_CLIENT_ID?.trim();
  if (clientId === undefined || clientId.length === 0 || dashboardSessionSigningSecret(context.env) === undefined) {
    return jsonResponse({ error: "oauth_config_missing" }, 500);
  }

  const requestUrl = new URL(context.req.raw.url);
  const nonce = await randomTokenPart(24);
  const next = dashboardRedirectTarget(context.env, requestUrl.searchParams.get("next"));
  const state = await issueOAuthStateToken(context.env, nonce, next, Date.now() + OAUTH_STATE_TTL_MS);
  const redirectUri = `${requestUrl.origin}/v1/auth/github/callback`;
  const authorizeUrl = new URL(context.env.CONTRABASS_GITHUB_AUTHORIZE_URL ?? "https://github.com/login/oauth/authorize");
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("scope", "read:user");
  authorizeUrl.searchParams.set("state", state);

  return redirectResponse(authorizeUrl.toString(), 302, [
    serializeCookie(DASHBOARD_OAUTH_STATE_COOKIE_NAME, nonce, {
      httpOnly: true,
      path: "/v1/auth/github/callback",
      sameSite: "Lax",
      secure: requestUrl.protocol === "https:",
      maxAge: Math.floor(OAUTH_STATE_TTL_MS / 1000),
    }),
  ]);
}

async function completeGitHubOAuth(context: Context<WorkerRouterEnv>): Promise<Response> {
  const requestUrl = new URL(context.req.raw.url);
  const code = requestUrl.searchParams.get("code")?.trim();
  const state = requestUrl.searchParams.get("state")?.trim();
  if (code === undefined || code.length === 0 || state === undefined || state.length === 0) {
    return jsonResponse({ error: "oauth_invalid_callback" }, 400);
  }

  const statePayload = await validateOAuthStateToken(state, context.env);
  const stateCookie = extractNamedCookie(context.req.raw.headers.get("cookie"), DASHBOARD_OAUTH_STATE_COOKIE_NAME);
  if (statePayload === undefined || stateCookie === undefined || !timingSafeEqual(stateCookie, statePayload.nonce)) {
    return jsonResponse({ error: "oauth_state_invalid" }, 401);
  }

  const githubUser = await exchangeGitHubOAuthCode(context.env, code, `${requestUrl.origin}/v1/auth/github/callback`);
  if (githubUser === undefined) {
    return jsonResponse({ error: "oauth_exchange_failed" }, 401);
  }

  const expiresAt = Date.now() + DASHBOARD_SESSION_TTL_MS;
  const sessionToken = await issueDashboardSessionToken(context.env, githubUser, expiresAt);
  const cookies = [
    serializeCookie(DASHBOARD_SESSION_COOKIE_NAME, sessionToken, {
      httpOnly: true,
      path: "/",
      sameSite: "Lax",
      secure: requestUrl.protocol === "https:",
      maxAge: Math.floor(DASHBOARD_SESSION_TTL_MS / 1000),
    }),
    serializeCookie(DASHBOARD_OAUTH_STATE_COOKIE_NAME, "", {
      httpOnly: true,
      path: "/v1/auth/github/callback",
      sameSite: "Lax",
      secure: requestUrl.protocol === "https:",
      maxAge: 0,
    }),
  ];

  return redirectResponse(statePayload.next, 302, cookies);
}

async function registerWorker(context: Context<WorkerRouterEnv>): Promise<Response> {
  const body = await readObjectBody(context.req.raw);
  const request = parseRegisterRequest(body);
  if (request === undefined) {
    return errorResponse("invalid_request", 400);
  }
  if (!request.supported_protocol_versions.includes(PROTOCOL_VERSION_CURRENT)) {
    return protocolVersionUnsupportedResponse();
  }
  if (!await teamExists(context.env, request.teamId)) {
    return errorResponse("team_forbidden", 403);
  }
  if (workerTokenSigningSecret(context.env) === undefined) {
    return workerTokenConfigErrorResponse();
  }

  const coordinatorResponse = await forwardWorkerRegistration(context, request);
  if (!coordinatorResponse.ok) {
    return normalizeForwardedErrorResponse(coordinatorResponse);
  }

  const now = Date.now();
  const sessionTokenExpiresAt = now + SESSION_TOKEN_TTL_MS;
  const [sessionToken, refreshToken] = await Promise.all([
    issueSessionToken(context.env, request.teamId, request.workerId, sessionTokenExpiresAt),
    randomBearerToken("cbr"),
  ]);
  await persistRefreshToken(context.env, request, refreshToken, now + REFRESH_TOKEN_TTL_MS);

  return jsonResponse({
    sessionToken,
    sessionTokenExpiresAt,
    refreshToken,
    dispatchChannel: dispatchChannel(context.req.raw, request.workerId),
    heartbeatIntervalSec: HEARTBEAT_INTERVAL_SEC,
    leaseSec: LEASE_SEC,
    protocol_version: PROTOCOL_VERSION_CURRENT,
  } satisfies WorkerRegisterResponse, 200);
}

async function refreshWorkerSession(context: Context<WorkerRouterEnv>): Promise<Response> {
  const body = await readObjectBody(context.req.raw);
  const request = parseRefreshRequest(body);
  if (request === undefined) {
    return errorResponse("refresh_invalid", 401);
  }

  const enrollment = await findEnrollmentByRefreshToken(context.env, request.refreshToken);
  if (enrollment === undefined) {
    return errorResponse("refresh_invalid", 401);
  }
  if (enrollment.revoked_at !== null) {
    return errorResponse("refresh_revoked", 401);
  }
  if (enrollment.refresh_token_expires_at === null || isPastIsoTime(enrollment.refresh_token_expires_at)) {
    return errorResponse("refresh_expired", 401);
  }
  if (enrollment.worker_id === null) {
    return errorResponse("refresh_invalid", 401);
  }

  if (workerTokenSigningSecret(context.env) === undefined) {
    return workerTokenConfigErrorResponse();
  }

  await context.env.CONTROL_PLANE_DB?.prepare(
    "UPDATE worker_enrollments SET last_refreshed_at = ? WHERE enrollment_id = ?",
  ).bind(new Date().toISOString(), enrollment.enrollment_id).run();

  const expiresAt = Date.now() + SESSION_TOKEN_TTL_MS;
  const sessionToken = await issueSessionToken(context.env, enrollment.team_id, enrollment.worker_id, expiresAt);
  return jsonResponse({
    sessionToken,
    expiresAt,
    protocol_version: PROTOCOL_VERSION_CURRENT,
  } satisfies WorkerRefreshResponse, 200);
}

async function enrollWorker(context: Context<WorkerRouterEnv>): Promise<Response> {
  const body = await readObjectBody(context.req.raw);
  if (body === undefined) {
    return errorResponse("enrollment_invalid", 401);
  }
  const code = getStringField(body, "code");
  if (code === undefined) {
    return errorResponse("enrollment_invalid", 401);
  }

  const enrollment = await findEnrollmentByCode(context.env, code);
  if (
    enrollment === undefined
    || enrollment.revoked_at !== null
    || enrollment.redeemed_at !== null
    || isPastIsoTime(enrollment.expires_at)
  ) {
    return errorResponse("enrollment_invalid", 401);
  }

  const workerId = getStringField(body, "workerId")
    ?? getStringField(body, "worker_id")
    ?? enrollment.worker_id
    ?? `worker_${await randomTokenPart(12)}`;
  const refreshToken = await randomBearerToken("cbr");
  const refreshTokenHash = await sha256Hex(refreshToken);
  const refreshTokenExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS).toISOString();
  const redeemedAt = new Date().toISOString();
  const updateResult = await context.env.CONTROL_PLANE_DB?.prepare(`
    UPDATE worker_enrollments
    SET worker_id = ?, refresh_token_hash = ?, redeemed_at = ?, refresh_token_expires_at = ?, last_refreshed_at = ?
    WHERE enrollment_id = ? AND redeemed_at IS NULL AND revoked_at IS NULL AND expires_at > ?
  `).bind(
    workerId,
    refreshTokenHash,
    redeemedAt,
    refreshTokenExpiresAt,
    redeemedAt,
    enrollment.enrollment_id,
    redeemedAt,
  ).run();
  if (updateResult?.meta.changes !== 1) {
    return errorResponse("enrollment_invalid", 401);
  }

  return jsonResponse({
    teamId: enrollment.team_id,
    workerId,
    refreshToken,
    protocol_version: PROTOCOL_VERSION_CURRENT,
  }, 200);
}

async function createTeamConfig(context: Context<WorkerRouterEnv>): Promise<Response> {
  const teamId = (context.req.param("teamId") ?? "").trim();
  if (teamId === "") {
    return errorResponse("invalid_team_id", 400);
  }

  const principal = context.get("principal");
  if ("issued" in principal && principal.teamId !== teamId) {
    return errorResponse("team_forbidden", 403);
  }
  if (context.env.CONTROL_PLANE_DB === undefined) {
    return errorResponse("config_store_unavailable", 500);
  }

  const body = await readObjectBody(context.req.raw);
  const request = parseCreateConfigRequest(body);
  if (request === undefined) {
    return errorResponse("invalid_request", 400);
  }

  let renderedContentYaml: string;
  try {
    renderedContentYaml = renderWorkflowConfig(request.contentYaml, {
      boundSecrets: parseConfiguredTokens(context.env.CONTRABASS_CONFIG_BOUND_SECRETS),
      liquidContext: configLiquidContext(teamId, context.env.CONTRABASS_CONFIG_LIQUID_CONTEXT),
    });
  } catch (error) {
    if (isConfigParseError(error)) {
      return configInvalidResponse(error.details);
    }
    return configInvalidResponse([{ path: "$", message: "invalid workflow config" }]);
  }

  const contentHash = await sha256Hex(renderedContentYaml);
  const existing = await context.env.CONTROL_PLANE_DB.prepare(`
    SELECT version, content_hash
    FROM team_configs
    WHERE team_id = ? AND content_hash = ?
    LIMIT 1
  `).bind(teamId, contentHash).first<{ version: number; content_hash: string }>();
  if (existing !== null) {
    return jsonResponse({
      teamId,
      version: existing.version,
      contentHash: existing.content_hash,
      unchanged: true,
      protocol_version: PROTOCOL_VERSION_CURRENT,
    }, 200);
  }

  const next = await context.env.CONTROL_PLANE_DB.prepare(
    "SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM team_configs WHERE team_id = ?",
  ).bind(teamId).first<{ next_version: number }>();
  const version = next?.next_version ?? 1;
  const createdBy = request.createdBy ?? defaultConfigActor(principal);
  const createdAt = new Date().toISOString();

  await context.env.CONTROL_PLANE_DB.prepare(`
    INSERT INTO team_configs (team_id, version, content_hash, content_yaml, created_by, created_at, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(teamId, version, contentHash, renderedContentYaml, createdBy, createdAt, request.notes ?? "").run();

  return jsonResponse({
    teamId,
    version,
    contentHash,
    unchanged: false,
    protocol_version: PROTOCOL_VERSION_CURRENT,
  }, 201);
}

async function getTeamConfigByHash(context: Context<WorkerRouterEnv>): Promise<Response> {
  const teamId = (context.req.param("teamId") ?? "").trim();
  const hash = (context.req.param("hash") ?? "").trim();
  if (teamId === "") {
    return errorResponse("invalid_team_id", 400);
  }
  if (!isContentHash(hash)) {
    return errorResponse("invalid_config_hash", 400);
  }

  const principal = context.get("principal");
  if ("issued" in principal && principal.teamId !== teamId) {
    return errorResponse("team_forbidden", 403);
  }
  if (context.env.CONTROL_PLANE_DB === undefined) {
    return errorResponse("config_store_unavailable", 500);
  }

  const config = await context.env.CONTROL_PLANE_DB.prepare(`
    SELECT content_yaml
    FROM team_configs
    WHERE team_id = ? AND content_hash = ?
    LIMIT 1
  `).bind(teamId, hash).first<{ content_yaml: string }>();
  if (config === null) {
    return errorResponse("config_not_found", 404);
  }

  return new Response(config.content_yaml, {
    status: 200,
    headers: {
      "Cache-Control": "public, max-age=86400, immutable",
      "Content-Type": "text/yaml; charset=utf-8",
    },
  });
}

async function activateTeamConfigVersion(context: Context<WorkerRouterEnv>): Promise<Response> {
  const teamId = (context.req.param("teamId") ?? "").trim();
  const version = parsePositiveInteger(context.req.param("version") ?? "");
  if (teamId === "") {
    return errorResponse("invalid_team_id", 400);
  }
  if (version === undefined) {
    return errorResponse("invalid_config_version", 400);
  }

  const principal = context.get("principal");
  if ("issued" in principal && principal.teamId !== teamId) {
    return errorResponse("team_forbidden", 403);
  }
  if (context.env.CONTROL_PLANE_DB === undefined) {
    return errorResponse("config_store_unavailable", 500);
  }

  const body = await readOptionalObjectBody(context.req.raw);
  if (body === false) {
    return errorResponse("invalid_request", 400);
  }

  const config = await context.env.CONTROL_PLANE_DB.prepare(`
    SELECT version, content_hash
    FROM team_configs
    WHERE team_id = ? AND version = ?
    LIMIT 1
  `).bind(teamId, version).first<{ version: number; content_hash: string }>();
  if (config === null) {
    return errorResponse("config_not_found", 404);
  }

  const activatedAt = new Date().toISOString();
  const activatedBy = (body === undefined ? undefined : getStringField(body, "activated_by") ?? getStringField(body, "activatedBy"))
    ?? defaultConfigActor(principal);

  await context.env.CONTROL_PLANE_DB.prepare(`
    INSERT INTO team_configs_active (team_id, active_version, active_content_hash, activated_at, activated_by)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(team_id) DO UPDATE SET
      active_version = excluded.active_version,
      active_content_hash = excluded.active_content_hash,
      activated_at = excluded.activated_at,
      activated_by = excluded.activated_by
  `).bind(teamId, config.version, config.content_hash, activatedAt, activatedBy).run();

  const responseBody = {
    teamId,
    activeVersion: config.version,
    activeContentHash: config.content_hash,
    activatedAt,
    activatedBy,
    protocol_version: PROTOCOL_VERSION_CURRENT,
  };
  const notificationResponse = await notifyTeamConfigChanged(context, responseBody);
  if (!notificationResponse.ok) {
    return normalizeForwardedErrorResponse(notificationResponse);
  }

  return jsonResponse(responseBody, 200);
}

async function getTeamConfigDiff(context: Context<WorkerRouterEnv>): Promise<Response> {
  const teamId = (context.req.param("teamId") ?? "").trim();
  if (teamId === "") {
    return errorResponse("invalid_team_id", 400);
  }

  const principal = context.get("principal");
  if ("issued" in principal && principal.teamId !== teamId) {
    return errorResponse("team_forbidden", 403);
  }
  if (context.env.CONTROL_PLANE_DB === undefined) {
    return errorResponse("config_store_unavailable", 500);
  }

  const url = new URL(context.req.raw.url);
  const fromVersion = parseConfigVersionRef(url.searchParams.get("from"));
  const toVersion = parseConfigVersionRef(url.searchParams.get("to"));
  if (fromVersion === undefined || toVersion === undefined) {
    return errorResponse("invalid_config_version", 400);
  }

  const [fromConfig, toConfig] = await Promise.all([
    readConfigVersion(context.env.CONTROL_PLANE_DB, teamId, fromVersion),
    readConfigVersion(context.env.CONTROL_PLANE_DB, teamId, toVersion),
  ]);
  if (fromConfig === undefined || toConfig === undefined) {
    return errorResponse("config_not_found", 404);
  }

  const diff = buildUnifiedDiff({
    fromLabel: `v${fromConfig.version}`,
    fromContent: fromConfig.content_yaml,
    toLabel: `v${toConfig.version}`,
    toContent: toConfig.content_yaml,
  });

  return jsonResponse({
    teamId,
    from: configDiffMetadata(fromConfig),
    to: configDiffMetadata(toConfig),
    changed: fromConfig.content_hash !== toConfig.content_hash,
    diff,
    protocol_version: PROTOCOL_VERSION_CURRENT,
  }, 200);
}

function extractBearerToken(authorization: string | null): string | undefined {
  if (authorization === null) {
    return undefined;
  }

  const match = /^Bearer\s+(.+)$/iu.exec(authorization.trim());
  const token = match?.[1]?.trim();
  return token === undefined || token.length === 0 ? undefined : token;
}

function extractDashboardSessionCookie(cookieHeader: string | null): string | undefined {
  return extractNamedCookie(cookieHeader, DASHBOARD_SESSION_COOKIE_NAME);
}

function extractNamedCookie(cookieHeader: string | null, cookieName: string): string | undefined {
  if (cookieHeader === null) {
    return undefined;
  }

  for (const segment of cookieHeader.split(";")) {
    const [rawName, ...rawValueParts] = segment.trim().split("=");
    const value = rawValueParts.join("=").trim();
    if (rawName === cookieName && value.length > 0) {
      try {
        return decodeURIComponent(value);
      } catch {
        return undefined;
      }
    }
  }

  return undefined;
}

function isConfiguredToken(token: string, configuredTokens: string | undefined): boolean {
  return parseConfiguredTokens(configuredTokens).some((configuredToken) => timingSafeEqual(token, configuredToken));
}

function parseConfiguredTokens(configuredTokens: string | undefined): string[] {
  const raw = configuredTokens?.trim();
  if (raw === undefined || raw.length === 0) {
    return [];
  }

  if (raw.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every((token) => typeof token === "string")) {
        return parsed.map((token) => token.trim()).filter((token) => token.length > 0);
      }
    } catch {
      return [];
    }
    return [];
  }

  return raw.split(/[\s,]+/u).map((token) => token.trim()).filter((token) => token.length > 0);
}

function timingSafeEqual(actual: string, expected: string): boolean {
  const maxLength = Math.max(actual.length, expected.length);
  let diff = actual.length ^ expected.length;
  for (let index = 0; index < maxLength; index += 1) {
    diff |= (actual.charCodeAt(index) || 0) ^ (expected.charCodeAt(index) || 0);
  }
  return diff === 0;
}

function isPublicWorkerAuthRoute(request: Request): boolean {
  const url = new URL(request.url);
  return (request.method === "POST" && (url.pathname === "/v1/workers/refresh" || url.pathname === "/v1/workers/enroll"))
    || (request.method === "GET"
      && (url.pathname === "/v1/auth/github/login" || url.pathname === "/v1/auth/github/callback"));
}

async function forwardWorkerRegistration(
  context: Context<WorkerRouterEnv>,
  request: WorkerRegisterRequest,
): Promise<Response> {
  const headers = new Headers(context.req.raw.headers);
  headers.set("content-type", "application/json");
  headers.set("x-contrabass-team-id", request.teamId);

  const id = context.env.TEAM_COORDINATOR.idFromName(request.teamId);
  const stub = context.env.TEAM_COORDINATOR.get(id);
  return stub.fetch(new Request("https://team-coordinator.internal/workers/register", {
    method: "POST",
    headers,
    body: JSON.stringify({
      ...request,
      kind: request.kind ?? "local",
    }),
  }));
}

async function teamExists(env: Env, teamId: string): Promise<boolean> {
  if (env.CONTROL_PLANE_DB === undefined) {
    return true;
  }

  const row = await env.CONTROL_PLANE_DB.prepare(
    "SELECT team_id FROM team_configs_active WHERE team_id = ? LIMIT 1",
  ).bind(teamId).first<{ team_id: string }>();
  return row !== null;
}

async function persistRefreshToken(
  env: Env,
  request: WorkerRegisterRequest,
  refreshToken: string,
  expiresAt: number,
): Promise<void> {
  if (env.CONTROL_PLANE_DB === undefined) {
    return;
  }

  const now = new Date().toISOString();
  const enrollmentId = `register_${request.teamId}_${request.workerId}_${await randomTokenPart(8)}`;
  await env.CONTROL_PLANE_DB.prepare(`
    INSERT INTO worker_enrollments (
      enrollment_id,
      team_id,
      worker_id,
      code_hash,
      refresh_token_hash,
      created_by,
      expires_at,
      redeemed_at,
      refresh_token_expires_at,
      capabilities,
      worker_version,
      last_refreshed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    enrollmentId,
    request.teamId,
    request.workerId,
    await sha256Hex(`register:${enrollmentId}`),
    await sha256Hex(refreshToken),
    `worker:${request.workerId}`,
    new Date(expiresAt).toISOString(),
    now,
    new Date(expiresAt).toISOString(),
    JSON.stringify(request.capabilities),
    request.version,
    now,
  ).run();
}

function parseRegisterRequest(body: Record<string, unknown> | undefined): WorkerRegisterRequest | undefined {
  if (body === undefined) {
    return undefined;
  }

  const teamId = getStringField(body, "teamId");
  const workerId = getStringField(body, "workerId");
  const capabilities = getStringArrayField(body, "capabilities");
  const maxConcurrency = getPositiveIntegerField(body, "maxConcurrency");
  const version = getStringField(body, "version");
  const supportedProtocolVersions = getStringArrayField(body, "supported_protocol_versions");
  const protocolVersion = body.protocol_version;
  const kind = getWorkerKindField(body);

  if (
    teamId === undefined
    || workerId === undefined
    || capabilities === undefined
    || capabilities.length === 0
    || maxConcurrency === undefined
    || version === undefined
    || supportedProtocolVersions === undefined
    || supportedProtocolVersions.length === 0
    || protocolVersion !== PROTOCOL_VERSION_CURRENT
  ) {
    return undefined;
  }

  return {
    teamId,
    workerId,
    capabilities: capabilities as WorkerRegisterRequest["capabilities"],
    maxConcurrency,
    version,
    supported_protocol_versions: supportedProtocolVersions as WorkerRegisterRequest["supported_protocol_versions"],
    protocol_version: PROTOCOL_VERSION_CURRENT,
    ...(kind === undefined ? {} : { kind }),
  };
}

function parseRefreshRequest(body: Record<string, unknown> | undefined): WorkerRefreshRequest | undefined {
  if (body === undefined) {
    return undefined;
  }

  const refreshToken = getStringField(body, "refreshToken");
  if (refreshToken === undefined || body.protocol_version !== PROTOCOL_VERSION_CURRENT) {
    return undefined;
  }

  return {
    refreshToken,
    protocol_version: PROTOCOL_VERSION_CURRENT,
  };
}

type CreateConfigRequest = {
  contentYaml: string;
  createdBy?: string;
  notes?: string;
};

type ConfigVersionRow = {
  version: number;
  content_hash: string;
  content_yaml: string;
  created_by: string;
  created_at: string;
  notes: string | null;
};

function parseCreateConfigRequest(body: Record<string, unknown> | undefined): CreateConfigRequest | undefined {
  if (body === undefined) {
    return undefined;
  }

  const contentYaml = getStringField(body, "content_yaml") ?? getStringField(body, "contentYaml");
  if (contentYaml === undefined) {
    return undefined;
  }

  return {
    contentYaml,
    createdBy: getStringField(body, "created_by") ?? getStringField(body, "createdBy"),
    notes: getStringField(body, "notes"),
  };
}

function configLiquidContext(teamId: string, rawContext: string | undefined): Record<string, unknown> {
  const defaultTeam = { id: teamId, name: teamId };
  if (rawContext === undefined || rawContext.trim() === "") {
    return { team: defaultTeam };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContext);
  } catch {
    throw configParseError([{ path: "prompt", message: "invalid liquid context" }]);
  }
  if (!isPlainRecord(parsed) || "secrets" in parsed) {
    throw configParseError([{ path: "prompt", message: "invalid liquid context" }]);
  }

  const team = isPlainRecord(parsed.team)
    ? { ...defaultTeam, ...parsed.team }
    : defaultTeam;
  return { ...parsed, team };
}

type EnrollmentRow = {
  enrollment_id: string;
  team_id: string;
  worker_id: string | null;
  expires_at: string;
  redeemed_at: string | null;
  refresh_token_expires_at: string | null;
  revoked_at: string | null;
};

async function findEnrollmentByCode(env: Env, code: string): Promise<EnrollmentRow | undefined> {
  if (env.CONTROL_PLANE_DB === undefined) {
    return undefined;
  }

  const row = await env.CONTROL_PLANE_DB.prepare(`
    SELECT enrollment_id, team_id, worker_id, expires_at, redeemed_at, refresh_token_expires_at, revoked_at
    FROM worker_enrollments
    WHERE code_hash = ?
    LIMIT 1
  `).bind(await sha256Hex(code)).first<EnrollmentRow>();
  return row ?? undefined;
}

async function findEnrollmentByRefreshToken(env: Env, refreshToken: string): Promise<EnrollmentRow | undefined> {
  if (env.CONTROL_PLANE_DB === undefined) {
    return undefined;
  }

  const row = await env.CONTROL_PLANE_DB.prepare(`
    SELECT enrollment_id, team_id, worker_id, expires_at, redeemed_at, refresh_token_expires_at, revoked_at
    FROM worker_enrollments
    WHERE refresh_token_hash = ?
    LIMIT 1
  `).bind(await sha256Hex(refreshToken)).first<EnrollmentRow>();
  return row ?? undefined;
}

function isPastIsoTime(value: string): boolean {
  const parsed = Date.parse(value);
  return !Number.isFinite(parsed) || parsed <= Date.now();
}

function dispatchChannel(request: Request, workerId: string): WorkerRegisterResponse["dispatchChannel"] {
  const url = new URL(request.url);
  const encodedWorkerId = encodeURIComponent(workerId);
  return {
    wsUrl: `${websocketOrigin(url)}/v1/workers/${encodedWorkerId}/dispatch-ws`,
    longPollUrl: `${url.origin}/v1/workers/${encodedWorkerId}/dispatch?wait=25s`,
  };
}

function websocketOrigin(url: URL): string {
  return `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}`;
}

type GitHubOAuthUser = {
  id: number;
  login: string;
};

async function exchangeGitHubOAuthCode(
  env: Env,
  code: string,
  redirectUri: string,
): Promise<GitHubOAuthUser | undefined> {
  const clientId = env.CONTRABASS_GITHUB_CLIENT_ID?.trim();
  const clientSecret = env.CONTRABASS_GITHUB_CLIENT_SECRET?.trim();
  if (clientId === undefined || clientId.length === 0 || clientSecret === undefined || clientSecret.length === 0) {
    return undefined;
  }

  const tokenResponse = await fetch(env.CONTRABASS_GITHUB_TOKEN_URL ?? "https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": "contrabass-cloud",
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!tokenResponse.ok) {
    return undefined;
  }

  const tokenBody = await readJsonObjectResponse(tokenResponse);
  const accessToken = tokenBody === undefined ? undefined : getStringField(tokenBody, "access_token");
  if (accessToken === undefined) {
    return undefined;
  }

  const userResponse = await fetch(env.CONTRABASS_GITHUB_USER_URL ?? "https://api.github.com/user", {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${accessToken}`,
      "user-agent": "contrabass-cloud",
    },
  });
  if (!userResponse.ok) {
    return undefined;
  }

  const userBody = await readJsonObjectResponse(userResponse);
  if (userBody === undefined) {
    return undefined;
  }

  const id = userBody.id;
  const login = getStringField(userBody, "login");
  return typeof id === "number" && Number.isInteger(id) && login !== undefined ? { id, login } : undefined;
}

async function readJsonObjectResponse(response: Response): Promise<Record<string, unknown> | undefined> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return undefined;
  }

  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }
  return body as Record<string, unknown>;
}

function dashboardRedirectTarget(env: Env, next: string | null): string {
  const dashboardOrigin = env.CONTRABASS_DASHBOARD_ORIGIN?.trim();
  const fallback = dashboardOrigin === undefined || dashboardOrigin.length === 0 ? "/" : dashboardOrigin;

  if (next === null || next.trim() === "") {
    return fallback;
  }

  const trimmedNext = next.trim();
  if (trimmedNext.startsWith("/") && !trimmedNext.startsWith("//")) {
    return dashboardOrigin === undefined || dashboardOrigin.length === 0
      ? trimmedNext
      : `${dashboardOrigin}${trimmedNext}`;
  }

  if (dashboardOrigin !== undefined && dashboardOrigin.length > 0) {
    try {
      const nextUrl = new URL(trimmedNext);
      return nextUrl.origin === dashboardOrigin ? nextUrl.toString() : dashboardOrigin;
    } catch {
      return dashboardOrigin;
    }
  }

  return "/";
}

type OAuthStatePayload = {
  nonce: string;
  next: string;
  exp: number;
};

async function issueOAuthStateToken(env: Env, nonce: string, next: string, expiresAt: number): Promise<string> {
  const secret = dashboardSessionSigningSecret(env);
  if (secret === undefined) {
    throw new Error("CONTRABASS_DASHBOARD_SESSION_SECRET is required to issue OAuth state tokens");
  }

  const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ nonce, next, exp: expiresAt })));
  const signature = await hmacSha256Base64Url(secret, payload);
  return `cbo.${payload}.${signature}`;
}

async function validateOAuthStateToken(token: string, env: Env): Promise<OAuthStatePayload | undefined> {
  const secret = dashboardSessionSigningSecret(env);
  if (secret === undefined) {
    return undefined;
  }

  const [prefix, payload, signature] = token.split(".");
  if (prefix !== "cbo" || payload === undefined || signature === undefined) {
    return undefined;
  }

  const expected = await hmacSha256Base64Url(secret, payload);
  if (!timingSafeEqual(signature, expected)) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload)));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const record = parsed as Record<string, unknown>;
    return typeof record.nonce === "string"
      && typeof record.next === "string"
      && typeof record.exp === "number"
      && record.exp > Date.now()
      ? { nonce: record.nonce, next: record.next, exp: record.exp }
      : undefined;
  } catch {
    return undefined;
  }
}

async function issueDashboardSessionToken(
  env: Env,
  user: GitHubOAuthUser,
  expiresAt: number,
): Promise<string> {
  const secret = dashboardSessionSigningSecret(env);
  if (secret === undefined) {
    throw new Error("CONTRABASS_DASHBOARD_SESSION_SECRET is required to issue dashboard session tokens");
  }

  const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify({
    githubId: user.id,
    githubLogin: user.login,
    exp: expiresAt,
  })));
  const signature = await hmacSha256Base64Url(secret, payload);
  return `cbd.${payload}.${signature}`;
}

type DashboardSessionPayload = {
  githubId: number;
  githubLogin: string;
  exp: number;
};

async function validateDashboardSessionToken(token: string, env: Env): Promise<DashboardSessionPayload | undefined> {
  const secret = dashboardSessionSigningSecret(env);
  if (secret === undefined) {
    return undefined;
  }

  const [prefix, payload, signature] = token.split(".");
  if (prefix !== "cbd" || payload === undefined || signature === undefined) {
    return undefined;
  }

  const expected = await hmacSha256Base64Url(secret, payload);
  if (!timingSafeEqual(signature, expected)) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload)));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const record = parsed as Record<string, unknown>;
    return typeof record.githubId === "number"
      && Number.isInteger(record.githubId)
      && typeof record.githubLogin === "string"
      && typeof record.exp === "number"
      && record.exp > Date.now()
      ? { githubId: record.githubId, githubLogin: record.githubLogin, exp: record.exp }
      : undefined;
  } catch {
    return undefined;
  }
}

function dashboardSessionSigningSecret(env: Env): string | undefined {
  const explicit = env.CONTRABASS_DASHBOARD_SESSION_SECRET?.trim();
  if (explicit !== undefined && explicit.length > 0) {
    return explicit;
  }

  const configuredTokens = env.CONTRABASS_DASHBOARD_SESSION_TOKENS?.trim();
  return configuredTokens === undefined || configuredTokens.length === 0 ? undefined : configuredTokens;
}

async function issueSessionToken(env: Env, teamId: string, workerId: string, expiresAt: number): Promise<string> {
  const secret = workerTokenSigningSecret(env);
  if (secret === undefined) {
    throw new Error("CONTRABASS_WORKER_TOKEN_SECRET is required to issue worker session tokens");
  }

  const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify({
    teamId,
    workerId,
    exp: expiresAt,
    protocol_version: PROTOCOL_VERSION_CURRENT,
  })));
  const signature = await hmacSha256Base64Url(secret, payload);
  return `cbs.${payload}.${signature}`;
}

type IssuedSessionPayload = {
  teamId: string;
  workerId: string;
  exp: number;
  protocol_version: string;
};

async function validateIssuedSessionToken(token: string, env: Env): Promise<IssuedSessionPayload | undefined> {
  const secret = workerTokenSigningSecret(env);
  if (secret === undefined) {
    return undefined;
  }

  const [prefix, payload, signature] = token.split(".");
  if (prefix !== "cbs" || payload === undefined || signature === undefined) {
    return undefined;
  }

  const expected = await hmacSha256Base64Url(secret, payload);
  if (!timingSafeEqual(signature, expected)) {
    return undefined;
  }

  const parsed = parseSessionPayload(payload);
  return parsed !== undefined && parsed.exp > Date.now() && parsed.protocol_version === PROTOCOL_VERSION_CURRENT
    ? parsed
    : undefined;
}

function workerTokenSigningSecret(env: Env): string | undefined {
  const explicit = env.CONTRABASS_WORKER_TOKEN_SECRET?.trim();
  if (explicit !== undefined && explicit.length > 0) {
    return explicit;
  }

  const configuredTokens = env.CONTRABASS_WORKER_SESSION_TOKENS?.trim();
  return configuredTokens === undefined || configuredTokens.length === 0 ? undefined : configuredTokens;
}

function workerTokenConfigErrorResponse(): Response {
  return jsonResponse({
    error: "worker_token_secret_missing",
    protocol_version: PROTOCOL_VERSION_CURRENT,
  }, 500);
}

function isContentHash(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
}

function parseConfigVersionRef(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }

  const normalized = value.trim().replace(/^v/iu, "");
  return parsePositiveInteger(normalized);
}

async function readConfigVersion(
  db: D1Database,
  teamId: string,
  version: number,
): Promise<ConfigVersionRow | undefined> {
  const row = await db.prepare(`
    SELECT version, content_hash, content_yaml, created_by, created_at, notes
    FROM team_configs
    WHERE team_id = ? AND version = ?
    LIMIT 1
  `).bind(teamId, version).first<ConfigVersionRow>();
  return row ?? undefined;
}

function configDiffMetadata(row: ConfigVersionRow): Record<string, unknown> {
  return {
    version: row.version,
    contentHash: row.content_hash,
    createdBy: row.created_by,
    createdAt: row.created_at,
    notes: row.notes ?? "",
  };
}

function buildUnifiedDiff(options: {
  fromLabel: string;
  fromContent: string;
  toLabel: string;
  toContent: string;
}): string {
  const fromLines = splitDiffLines(options.fromContent);
  const toLines = splitDiffLines(options.toContent);
  const operations = diffLineOperations(fromLines, toLines);
  const body = operations
    .filter((operation) => operation.kind !== "equal")
    .map((operation) => `${operation.kind === "delete" ? "-" : "+"}${operation.line}`);

  return [
    `--- ${options.fromLabel}`,
    `+++ ${options.toLabel}`,
    ...body,
  ].join("\n");
}

function splitDiffLines(content: string): string[] {
  const lines = content.split("\n");
  return lines.at(-1) === "" ? lines.slice(0, -1) : lines;
}

type DiffLineOperation = {
  kind: "equal" | "delete" | "insert";
  line: string;
};

function diffLineOperations(fromLines: string[], toLines: string[]): DiffLineOperation[] {
  const lcsLengths = Array.from({ length: fromLines.length + 1 }, () => Array<number>(toLines.length + 1).fill(0));
  for (let fromIndex = fromLines.length - 1; fromIndex >= 0; fromIndex -= 1) {
    for (let toIndex = toLines.length - 1; toIndex >= 0; toIndex -= 1) {
      lcsLengths[fromIndex][toIndex] = fromLines[fromIndex] === toLines[toIndex]
        ? lcsLengths[fromIndex + 1][toIndex + 1] + 1
        : Math.max(lcsLengths[fromIndex + 1][toIndex], lcsLengths[fromIndex][toIndex + 1]);
    }
  }

  const operations: DiffLineOperation[] = [];
  let fromIndex = 0;
  let toIndex = 0;
  while (fromIndex < fromLines.length && toIndex < toLines.length) {
    if (fromLines[fromIndex] === toLines[toIndex]) {
      operations.push({ kind: "equal", line: fromLines[fromIndex] });
      fromIndex += 1;
      toIndex += 1;
    } else if (lcsLengths[fromIndex + 1][toIndex] >= lcsLengths[fromIndex][toIndex + 1]) {
      operations.push({ kind: "delete", line: fromLines[fromIndex] });
      fromIndex += 1;
    } else {
      operations.push({ kind: "insert", line: toLines[toIndex] });
      toIndex += 1;
    }
  }
  for (; fromIndex < fromLines.length; fromIndex += 1) {
    operations.push({ kind: "delete", line: fromLines[fromIndex] });
  }
  for (; toIndex < toLines.length; toIndex += 1) {
    operations.push({ kind: "insert", line: toLines[toIndex] });
  }
  return operations;
}

function configInvalidResponse(details: ConfigValidationDetail[]): Response {
  return errorResponse("config_invalid", 400, { details });
}

function defaultConfigActor(principal: AuthPrincipal): string {
  if ("issued" in principal) {
    return `worker:${principal.workerId}`;
  }
  return principal.kind === "dashboard-session" ? "dashboard" : "api";
}

function isIssuedWorkerPrincipal(
  principal: AuthPrincipal,
): principal is Extract<AuthPrincipal, { kind: "bearer"; issued: true }> {
  return principal.kind === "bearer" && "issued" in principal;
}

function parseSessionPayload(payload: string): IssuedSessionPayload | undefined {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload)));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }

    const record = parsed as Record<string, unknown>;
    return typeof record.teamId === "string"
      && typeof record.workerId === "string"
      && typeof record.exp === "number"
      && typeof record.protocol_version === "string"
      ? {
        teamId: record.teamId,
        workerId: record.workerId,
        exp: record.exp,
        protocol_version: record.protocol_version,
      }
      : undefined;
  } catch {
    return undefined;
  }
}

async function hmacSha256Base64Url(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return base64UrlEncode(new Uint8Array(signature));
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function randomBearerToken(prefix: "cbr" | "cbs"): Promise<string> {
  return `${prefix}_${await randomTokenPart(32)}`;
}

async function randomTokenPart(byteLength: number): Promise<string> {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/gu, "+").replace(/_/gu, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function readObjectBody(request: Request): Promise<Record<string, unknown> | undefined> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return undefined;
  }

  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }

  return body as Record<string, unknown>;
}

async function readOptionalObjectBody(request: Request): Promise<Record<string, unknown> | undefined | false> {
  const text = await request.text();
  if (text.trim() === "") {
    return undefined;
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return false;
  }

  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return false;
  }

  return body as Record<string, unknown>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getStringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function getStringArrayField(body: Record<string, unknown>, key: string): string[] | undefined {
  const value = body[key];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    return undefined;
  }
  return value;
}

function getPositiveIntegerField(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key];
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : undefined;
}

function parsePositiveInteger(value: string): number | undefined {
  if (!/^[1-9][0-9]*$/u.test(value)) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function getWorkerKindField(body: Record<string, unknown>): WorkerRegisterRequest["kind"] | undefined {
  const value = body.kind;
  return value === "local" || value === "container" ? value : undefined;
}

async function forwardTeamCoordinatorRequest(
  context: Context<WorkerRouterEnv>,
  coordinatorPath: string,
): Promise<Response> {
  const teamId = (context.req.param("teamId") ?? "").trim();
  if (teamId === "") {
    return errorResponse("invalid_team_id", 400);
  }

  const principal = context.get("principal");
  if (isIssuedWorkerPrincipal(principal) && principal.teamId !== teamId) {
    return errorResponse("team_forbidden", 403);
  }

  const id = context.env.TEAM_COORDINATOR.idFromName(teamId);
  const stub = context.env.TEAM_COORDINATOR.get(id);
  const request = context.req.raw;
  const headers = new Headers(request.headers);
  headers.set("x-contrabass-team-id", teamId);

  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();

  const targetUrl = new URL(`https://team-coordinator.internal${coordinatorPath}`);
  targetUrl.search = new URL(request.url).search;

  return normalizeForwardedErrorResponse(await stub.fetch(new Request(targetUrl, {
    method: request.method,
    headers,
    body,
  })));
}

function forwardTeamCoordinatorBoardPostRequest(context: Context<WorkerRouterEnv>): Promise<Response> | Response {
  const coordinatorPath = teamCoordinatorBoardPostPath(context.req.raw);
  if (coordinatorPath === undefined) {
    return errorResponse("not_found", 404);
  }
  return forwardTeamCoordinatorRequest(context, coordinatorPath);
}

function teamCoordinatorBoardPostPath(request: Request): string | undefined {
  const url = new URL(request.url);
  const match = /^\/v1\/teams\/[^/]+\/board\/(.+)$/u.exec(url.pathname);
  const actionPath = match?.[1];
  if (actionPath === undefined || actionPath.trim() === "") {
    return undefined;
  }
  return `/board/${actionPath}`;
}

async function notifyTeamConfigChanged(
  context: Context<WorkerRouterEnv>,
  payload: Record<string, unknown>,
): Promise<Response> {
  const id = context.env.TEAM_COORDINATOR.idFromName(String(payload.teamId));
  const stub = context.env.TEAM_COORDINATOR.get(id);
  const headers = new Headers(context.req.raw.headers);
  headers.set("content-type", "application/json");
  headers.set("x-contrabass-team-id", String(payload.teamId));

  return stub.fetch(new Request("https://team-coordinator.internal/config-changed", {
    method: "POST",
    headers,
    body: JSON.stringify({
      type: "config-changed",
      ...payload,
    }),
  }));
}

async function forwardIssueRunRequest(
  context: Context<WorkerRouterEnv>,
  issueRunPath: "/ack" | "/heartbeat" | "/events" | "/complete",
): Promise<Response> {
  const runId = (context.req.param("runId") ?? "").trim();
  if (runId === "") {
    return errorResponse("invalid_run_id", 400);
  }

  const teamId = resolveRunForwardTeamId(context);
  if (teamId === undefined) {
    return errorResponse("invalid_team_id", 400);
  }
  if (teamId === false) {
    return errorResponse("team_forbidden", 403);
  }

  const principal = context.get("principal");
  const request = context.req.raw;
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  headers.set("x-contrabass-team-id", teamId);
  headers.set("x-contrabass-run-id", runId);
  if (isIssuedWorkerPrincipal(principal)) {
    headers.set("x-contrabass-worker-id", principal.workerId);
  }

  const issueRef = await lookupIssueRefForRun(context, teamId, runId);
  if (issueRef === undefined) {
    return errorResponse("run_not_found", 404);
  }

  const body = issueRunPath === "/ack" && isIssuedWorkerPrincipal(principal)
    ? await ackBodyWithWorkerId(request, principal.workerId)
    : await request.arrayBuffer();

  const id = context.env.ISSUE_RUN.idFromName(`${teamId}:${issueRef}`);
  const stub = context.env.ISSUE_RUN.get(id);
  return normalizeForwardedErrorResponse(await stub.fetch(new Request(`https://issue-run.internal${issueRunPath}`, {
    method: request.method,
    headers,
    body,
  })));
}

async function longPollWorkerDispatch(context: Context<WorkerRouterEnv>): Promise<Response> {
  const workerId = (context.req.param("workerId") ?? "").trim();
  if (workerId === "") {
    return errorResponse("invalid_worker_id", 400);
  }

  const teamId = resolveWorkerScopedTeamId(context, workerId);
  if (teamId === undefined) {
    return errorResponse("invalid_team_id", 400);
  }
  if (teamId === false) {
    return errorResponse("team_forbidden", 403);
  }

  const id = context.env.TEAM_COORDINATOR.idFromName(teamId);
  const stub = context.env.TEAM_COORDINATOR.get(id);
  const request = context.req.raw;
  const headers = new Headers(request.headers);
  headers.set("x-contrabass-team-id", teamId);
  headers.set("x-contrabass-worker-id", workerId);

  const sourceUrl = new URL(request.url);
  const targetUrl = new URL(`https://team-coordinator.internal/workers/${encodeURIComponent(workerId)}/dispatch`);
  targetUrl.search = sourceUrl.search;

  return normalizeForwardedErrorResponse(await stub.fetch(new Request(targetUrl, {
    method: "GET",
    headers,
  })));
}

async function websocketWorkerDispatch(context: Context<WorkerRouterEnv>): Promise<Response> {
  const workerId = (context.req.param("workerId") ?? "").trim();
  if (workerId === "") {
    return errorResponse("invalid_worker_id", 400);
  }

  const teamId = resolveWorkerScopedTeamId(context, workerId);
  if (teamId === undefined) {
    return errorResponse("invalid_team_id", 400);
  }
  if (teamId === false) {
    return errorResponse("team_forbidden", 403);
  }

  const id = context.env.TEAM_COORDINATOR.idFromName(teamId);
  const stub = context.env.TEAM_COORDINATOR.get(id);
  const request = context.req.raw;
  const headers = new Headers(request.headers);
  headers.set("x-contrabass-team-id", teamId);
  headers.set("x-contrabass-worker-id", workerId);

  const sourceUrl = new URL(request.url);
  const targetUrl = new URL("https://team-coordinator.internal/subscribe");
  targetUrl.search = sourceUrl.search;
  targetUrl.searchParams.set("workerId", workerId);

  return normalizeForwardedErrorResponse(await stub.fetch(new Request(targetUrl, {
    method: "GET",
    headers,
  })));
}

async function lookupIssueRefForRun(
  context: Context<WorkerRouterEnv>,
  teamId: string,
  runId: string,
): Promise<string | undefined> {
  const id = context.env.TEAM_COORDINATOR.idFromName(teamId);
  const stub = context.env.TEAM_COORDINATOR.get(id);
  const headers = new Headers(context.req.raw.headers);
  headers.set("x-contrabass-team-id", teamId);

  const response = await stub.fetch(new Request("https://team-coordinator.internal/board", {
    method: "GET",
    headers,
  }));
  if (!response.ok) {
    return undefined;
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return undefined;
  }

  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }

  const board = (body as Record<string, unknown>).board;
  if (board === null || typeof board !== "object" || Array.isArray(board)) {
    return undefined;
  }

  for (const entries of Object.values(board as Record<string, unknown>)) {
    if (!Array.isArray(entries)) {
      continue;
    }
    for (const entry of entries) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }
      const record = entry as Record<string, unknown>;
      if (record.runId === runId && typeof record.issueRef === "string" && record.issueRef.trim() !== "") {
        return record.issueRef;
      }
    }
  }

  return undefined;
}

function resolveRunForwardTeamId(context: Context<WorkerRouterEnv>): string | false | undefined {
  const principal = context.get("principal");
  const headerTeamId = context.req.raw.headers.get("x-contrabass-team-id")?.trim();
  if (isIssuedWorkerPrincipal(principal)) {
    if (headerTeamId !== undefined && headerTeamId.length > 0 && headerTeamId !== principal.teamId) {
      return false;
    }
    return principal.teamId;
  }

  return headerTeamId === undefined || headerTeamId.length === 0 ? undefined : headerTeamId;
}

function resolveWorkerScopedTeamId(
  context: Context<WorkerRouterEnv>,
  workerId: string,
): string | false | undefined {
  const principal = context.get("principal");
  const headerTeamId = context.req.raw.headers.get("x-contrabass-team-id")?.trim();
  if (isIssuedWorkerPrincipal(principal)) {
    if (workerId !== principal.workerId) {
      return false;
    }
    if (headerTeamId !== undefined && headerTeamId.length > 0 && headerTeamId !== principal.teamId) {
      return false;
    }
    return principal.teamId;
  }

  return headerTeamId === undefined || headerTeamId.length === 0 ? undefined : headerTeamId;
}

async function ackBodyWithWorkerId(request: Request, workerId: string): Promise<string> {
  const body = await readObjectBody(request);
  return JSON.stringify({
    ...(body ?? {}),
    workerId,
  });
}

function notImplemented(): Response {
  return errorResponse("not_implemented", 501);
}

function redirectResponse(location: string, status: 302 | 303, cookies: string[]): Response {
  const headers = new Headers({ location });
  for (const cookie of cookies) {
    headers.append("set-cookie", cookie);
  }
  return new Response(null, { status, headers });
}

type CookieOptions = {
  httpOnly: boolean;
  path: string;
  sameSite: "Lax" | "Strict" | "None";
  secure: boolean;
  maxAge: number;
};

function serializeCookie(name: string, value: string, options: CookieOptions): string {
  const segments = [
    `${name}=${encodeURIComponent(value)}`,
    `Max-Age=${options.maxAge}`,
    `Path=${options.path}`,
    `SameSite=${options.sameSite}`,
  ];
  if (options.httpOnly) {
    segments.push("HttpOnly");
  }
  if (options.secure) {
    segments.push("Secure");
  }
  return segments.join("; ");
}

function jsonResponse(body: Record<string, unknown>, status: number): Response {
  return Response.json(body, { status });
}

function errorResponse(error: string, status: number, fields: Record<string, unknown> = {}): Response {
  return jsonResponse({
    error,
    ...fields,
    protocol_version: PROTOCOL_VERSION_CURRENT,
  }, status);
}

function protocolVersionUnsupportedResponse(): Response {
  return errorResponse("protocol_version_unsupported", 409, { supported: [...SUPPORTED_PROTOCOL_VERSIONS] });
}

async function normalizeForwardedErrorResponse(response: Response): Promise<Response> {
  if (response.status < 400) {
    return response;
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return errorResponse("upstream_error", response.status);
  }

  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return errorResponse("upstream_error", response.status);
  }

  const record = body as Record<string, unknown>;
  if (typeof record.error !== "string" || record.error.trim() === "") {
    return errorResponse("upstream_error", response.status);
  }

  return jsonResponse({
    ...record,
    protocol_version: PROTOCOL_VERSION_CURRENT,
  }, response.status);
}
