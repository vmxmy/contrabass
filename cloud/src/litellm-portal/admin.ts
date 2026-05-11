import type { LiteLLMPortalEnv } from "./types";
import { jsonResponse } from "./utils";
import { listAllUsers, listAllTeams, listAuditEvents, publicTeam } from "./litellm";
import { parseUsageTimeseriesRequest, readGlobalUsageTimeseries } from "./timeseries";

function sanitizePageParam(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

function sanitizeSizeParam(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

export async function adminListUsers(request: Request, env: LiteLLMPortalEnv): Promise<Response> {
  const url = new URL(request.url);
  const page = sanitizePageParam(url.searchParams.get("page"), 1);
  const size = sanitizeSizeParam(url.searchParams.get("size"), 50);
  try {
    const result = await listAllUsers(env, { page, size });
    return jsonResponse({
      users: result.users.map((user) => ({
        userId: user.userId,
        email: user.email,
        spend: user.spend,
        maxBudget: user.maxBudget,
        teamIds: user.teamIds,
        role: user.role,
      })),
      totalCount: result.totalCount,
      page: result.page,
      size: result.size,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "internal_error";
    return jsonResponse({ error: message }, message === "litellm_config_missing" ? 500 : 502);
  }
}

export async function adminListTeams(request: Request, env: LiteLLMPortalEnv): Promise<Response> {
  try {
    const teams = await listAllTeams(env);
    return jsonResponse({ teams: teams.map(publicTeam) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "internal_error";
    return jsonResponse({ error: message }, message === "litellm_config_missing" ? 500 : 502);
  }
}

export async function adminListAuditEvents(request: Request, env: LiteLLMPortalEnv): Promise<Response> {
  const url = new URL(request.url);
  const page = sanitizePageParam(url.searchParams.get("page"), 1);
  const size = sanitizeSizeParam(url.searchParams.get("size"), 50);
  try {
    const result = await listAuditEvents(env, { page, size });
    return jsonResponse({
      events: result.events.map((event) => ({
        id: event.id,
        createdAt: event.createdAt,
        action: event.action,
        actorUserId: event.actorUserId,
        actorUserEmail: event.actorUserEmail,
        objectType: event.objectType,
        objectId: event.objectId,
      })),
      totalCount: result.totalCount,
      page: result.page,
      size: result.size,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "internal_error";
    return jsonResponse({ error: message }, message === "litellm_config_missing" ? 500 : 502);
  }
}

export async function adminGlobalUsageTimeseries(request: Request, env: LiteLLMPortalEnv): Promise<Response> {
  const url = new URL(request.url);
  const parsed = parseUsageTimeseriesRequest(url);
  if (!parsed.ok) {
    return jsonResponse(parsed.body, 400);
  }
  try {
    const timeseries = await readGlobalUsageTimeseries(env, parsed.grain, parsed.window);
    return jsonResponse(timeseries);
  } catch (error) {
    const message = error instanceof Error ? error.message : "internal_error";
    return jsonResponse({ error: message }, message === "litellm_config_missing" ? 500 : 502);
  }
}
