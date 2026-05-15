import type { LiteLLMPortalEnv } from "./types";
import { jsonResponse, roundCurrency, sumDefinedNumbers } from "./utils";
import { listAllUsers, listAllTeams, listAuditEvents, publicTeam } from "./litellm";

const ADMIN_SUMMARY_PAGE_SIZE = 100;

function sanitizeIntParam(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

function isAdminRole(role: string | null): boolean {
  return role === "proxy_admin" || role === "proxy_admin_viewer";
}

function isManagedRole(role: string | null): boolean {
  return (
    role === "proxy_admin" ||
    role === "proxy_admin_viewer" ||
    role === "internal_user" ||
    role === "internal_user_viewer" ||
    role === "team" ||
    role === "customer"
  );
}

export async function adminListUsers(request: Request, env: LiteLLMPortalEnv): Promise<Response> {
  const url = new URL(request.url);
  const page = sanitizeIntParam(url.searchParams.get("page"), 1);
  const size = sanitizeIntParam(url.searchParams.get("size"), 50);
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

export async function adminSummary(request: Request, env: LiteLLMPortalEnv): Promise<Response> {
  try {
    const [userPage, teams] = await Promise.all([
      listAllUsers(env, { page: 1, size: ADMIN_SUMMARY_PAGE_SIZE }),
      listAllTeams(env),
    ]);
    const users = userPage.users;
    const sampledUserCount = users.length;
    const limited = userPage.totalCount > sampledUserCount;
    const overBudgetUserCount = users.filter(
      (user) => user.maxBudget != null && Number(user.spend || 0) >= user.maxBudget,
    ).length;
    const overBudgetTeamCount = teams.filter(
      (team) => team.maxBudget != null && Number(team.spend || 0) >= team.maxBudget,
    ).length;
    const noTeamUserCount = users.filter((user) => user.teamIds.length === 0).length;
    const unmanagedRoleCount = users.filter((user) => !isManagedRole(user.role)).length;

    return jsonResponse({
      userCount: userPage.totalCount,
      sampledUserCount,
      limited,
      teamCount: teams.length,
      adminCount: users.filter((user) => isAdminRole(user.role)).length,
      unmanagedRoleCount,
      noTeamUserCount,
      overBudgetUserCount,
      overBudgetTeamCount,
      riskCount: overBudgetUserCount + overBudgetTeamCount + unmanagedRoleCount,
      totalSpend: roundCurrency(users.reduce((sum, user) => sum + Number(user.spend || 0), 0)),
      teamSpend: roundCurrency(teams.reduce((sum, team) => sum + Number(team.spend || 0), 0)),
      totalBudget: sumDefinedNumbers([...users.map((user) => user.maxBudget), ...teams.map((team) => team.maxBudget)]),
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
  const page = sanitizeIntParam(url.searchParams.get("page"), 1);
  const size = sanitizeIntParam(url.searchParams.get("size"), 50);
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
