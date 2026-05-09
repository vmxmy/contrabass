import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";

import type { EventArchiveMessage } from "../queues/events-archive";

export type Env = {
  ARTIFACTS_BUCKET?: R2Bucket;
  CONTROL_PLANE_DB?: D1Database;
  EVENTS_ARCHIVE_BUCKET: R2Bucket;
  EVENTS_ARCHIVE_QUEUE: Queue<EventArchiveMessage>;
  ISSUE_RUN: DurableObjectNamespace;
  TEAM_COORDINATOR: DurableObjectNamespace;
  CONTRABASS_WORKER_SESSION_TOKENS?: string;
  CONTRABASS_DASHBOARD_SESSION_TOKENS?: string;
};

type AuthPrincipalKind = "bearer" | "dashboard-session";

export type AuthPrincipal = {
  kind: AuthPrincipalKind;
  token: string;
};

type WorkerRouterEnv = {
  Bindings: Env;
  Variables: {
    principal: AuthPrincipal;
  };
};

const DASHBOARD_SESSION_COOKIE_NAME = "contrabass_session";

export const workerRouter = new Hono<WorkerRouterEnv>();

workerRouter.use("/v1/*", authMiddleware());

workerRouter.get("/v1/teams/:teamId/board", (context) => {
  return forwardTeamCoordinatorRequest(context, "/board");
});

workerRouter.post("/v1/teams/:teamId/board/refresh", (context) => {
  return forwardTeamCoordinatorRequest(context, "/board/refresh");
});

workerRouter.post("/v1/workers/register", notImplemented);
workerRouter.post("/v1/workers/refresh", notImplemented);
workerRouter.post("/v1/workers/enroll", notImplemented);

workerRouter.post("/v1/runs/:runId/ack", notImplemented);
workerRouter.post("/v1/runs/:runId/heartbeat", notImplemented);
workerRouter.post("/v1/runs/:runId/events", notImplemented);
workerRouter.post("/v1/runs/:runId/complete", notImplemented);

workerRouter.get("/v1/workers/:workerId/dispatch", notImplemented);
workerRouter.get("/v1/workers/:workerId/dispatch-ws", notImplemented);

workerRouter.get("/v1/teams/:teamId/subscribe", notImplemented);
workerRouter.post("/v1/teams/:teamId/board/reassign-run", notImplemented);
workerRouter.post("/v1/teams/:teamId/board/cancel-run", notImplemented);
workerRouter.post("/v1/teams/:teamId/board/pause", notImplemented);
workerRouter.post("/v1/teams/:teamId/board/resume", notImplemented);

workerRouter.notFound(() => {
  return jsonResponse({ error: "not_found" }, 404);
});

export async function handleWorkerRequest(request: Request, env: Env): Promise<Response> {
  return workerRouter.fetch(request, env);
}

function authMiddleware(): MiddlewareHandler<WorkerRouterEnv> {
  return async (context, next) => {
    const principal = await validateAuthPrincipal(context.req.raw, context.env);
    if (principal === undefined) {
      return jsonResponse({ error: "unauthorized" }, 401);
    }

    context.set("principal", principal);
    await next();
  };
}

export async function validateAuthPrincipal(request: Request, env: Env): Promise<AuthPrincipal | undefined> {
  const bearerToken = extractBearerToken(request.headers.get("authorization"));
  if (bearerToken !== undefined && isConfiguredToken(bearerToken, env.CONTRABASS_WORKER_SESSION_TOKENS)) {
    return { kind: "bearer", token: bearerToken };
  }

  const sessionToken = extractDashboardSessionCookie(request.headers.get("cookie"));
  if (sessionToken !== undefined && isConfiguredToken(sessionToken, env.CONTRABASS_DASHBOARD_SESSION_TOKENS)) {
    return { kind: "dashboard-session", token: sessionToken };
  }

  return undefined;
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
  if (cookieHeader === null) {
    return undefined;
  }

  for (const segment of cookieHeader.split(";")) {
    const [rawName, ...rawValueParts] = segment.trim().split("=");
    const value = rawValueParts.join("=").trim();
    if (rawName === DASHBOARD_SESSION_COOKIE_NAME && value.length > 0) {
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

async function forwardTeamCoordinatorRequest(
  context: Context<WorkerRouterEnv>,
  coordinatorPath: "/board" | "/board/refresh",
): Promise<Response> {
  const teamId = (context.req.param("teamId") ?? "").trim();
  if (teamId === "") {
    return jsonResponse({ error: "invalid_team_id" }, 400);
  }

  const id = context.env.TEAM_COORDINATOR.idFromName(teamId);
  const stub = context.env.TEAM_COORDINATOR.get(id);
  const request = context.req.raw;
  const headers = new Headers(request.headers);
  headers.set("x-contrabass-team-id", teamId);

  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();

  return stub.fetch(new Request(`https://team-coordinator.internal${coordinatorPath}`, {
    method: request.method,
    headers,
    body,
  }));
}

function notImplemented(): Response {
  return jsonResponse({ error: "not_implemented" }, 501);
}

function jsonResponse(body: Record<string, unknown>, status: number): Response {
  return Response.json(body, { status });
}
