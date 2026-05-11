import type { JsonValue, LiteLLMKey, LiteLLMKeyList, LiteLLMTeam, LiteLLMUser, LiteLLMPortalEnv } from "./types";
import { isRecord, nullableRoundCurrency, readJson, roundCurrency, uniqueSorted } from "./utils";

export async function litellmFetch(env: LiteLLMPortalEnv, path: string, init: RequestInit = {}): Promise<Response> {
  const baseUrl = env.LITELLM_BASE_URL?.trim().replace(/\/+$/u, "");
  const masterKey = env.LITELLM_MASTER_KEY?.trim();
  if (!baseUrl || !masterKey) {
    throw new Error("litellm_config_missing");
  }

  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${masterKey}`);
  if (!headers.has("Content-Type") && init.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  if (!response.ok) {
    throw new Error(`litellm_request_failed_${response.status}`);
  }
  return response;
}

export async function listUserKeys(env: LiteLLMPortalEnv, userId: string): Promise<LiteLLMKeyList> {
  const normalizedUserId = userId.trim().toLowerCase();
  try {
    const userInfoResponse = await litellmFetch(env, `/user/info?user_id=${encodeURIComponent(normalizedUserId)}`);
    const userInfo = await readJson(userInfoResponse);
    const userInfoRecords = extractRecords(userInfo)
      .filter((record) => keyBelongsToUser(record, normalizedUserId));
    if (userInfoRecords.length > 0) {
      return {
        keys: userInfoRecords.map((record) => normalizeKey(record, normalizedUserId)),
        totalCount: userInfoRecords.length,
      };
    }
  } catch {
    // Some LiteLLM users are not materialized yet; fall back to /key/list.
  }

  const response = await litellmFetch(env, `/key/list?user_id=${encodeURIComponent(normalizedUserId)}&return_full_object=true`);
  const body = await readJson(response);
  const records = extractRecords(body)
    .filter((record) => keyBelongsToUser(record, normalizedUserId));
  const totalCount = isRecord(body) ? numberField(body, "total_count") ?? records.length : records.length;
  return {
    keys: records.map((record) => normalizeKey(record, normalizedUserId)),
    totalCount,
  };
}

export async function resolveLiteLLMUser(env: LiteLLMPortalEnv, email: string): Promise<LiteLLMUser> {
  const normalizedEmail = email.trim().toLowerCase();
  try {
    const response = await litellmFetch(env, `/user/list?user_email=${encodeURIComponent(normalizedEmail)}`);
    const body = await readJson(response);
    const match = extractRecords(body).find((record) => {
      const userEmail = firstString(record, ["user_email", "userEmail", "email"]);
      return userEmail?.trim().toLowerCase() === normalizedEmail;
    });
    if (match !== undefined) {
      const userId = firstString(match, ["user_id", "userId", "id"]) ?? normalizedEmail;
      return {
        userId,
        email: normalizedEmail,
        spend: roundCurrency(numberField(match, "spend") ?? numberField(match, "total_spend") ?? 0),
        maxBudget: numberField(match, "max_budget") ?? numberField(match, "maxBudget") ?? null,
        teamIds: stringArrayField(match, "teams"),
        role: firstString(match, ["user_role", "userRole", "role"]) ?? null,
        found: true,
        raw: match,
      };
    }
  } catch {
    // Fall back to the email as user_id so older LiteLLM deployments still work.
  }

  return {
    userId: normalizedEmail,
    email: normalizedEmail,
    spend: null,
    maxBudget: null,
    teamIds: [],
    role: null,
    found: false,
    raw: null,
  };
}

export async function readAvailableModels(
  env: LiteLLMPortalEnv,
  user?: LiteLLMUser,
): Promise<{ models: string[]; source: string; teamIds: string[] }> {
  const teamIds = user?.teamIds ?? [];
  const teams = await readUserTeams(env, teamIds);
  return readAvailableModelsFromTeams(env, teamIds, teams);
}

export async function readAvailableModelsFromTeams(
  env: LiteLLMPortalEnv,
  teamIds: string[],
  teams: LiteLLMTeam[],
): Promise<{ models: string[]; source: string; teamIds: string[] }> {
  const configured = configuredAllowedModels(env);
  const teamModels = {
    models: uniqueSorted(teams.flatMap((team) => team.models)),
    teamIds: uniqueSorted(teamIds.map((teamId) => teamId.trim()).filter((teamId) => teamId.length > 0)),
  };
  if (teamModels.models.length > 0) {
    const models = configured.length > 0
      ? teamModels.models.filter((model) => configured.includes(model))
      : teamModels.models;
    return { models, source: "team", teamIds: teamModels.teamIds };
  }

  if (configured.length > 0) {
    return { models: configured, source: "configured", teamIds: teamModels.teamIds };
  }

  const models = await readGlobalAvailableModels(env);
  return {
    models,
    source: teamModels.teamIds.length > 0 ? "team_unrestricted" : "litellm",
    teamIds: teamModels.teamIds,
  };
}

export async function readGlobalAvailableModels(env: LiteLLMPortalEnv): Promise<string[]> {
  const response = await litellmFetch(env, "/v1/models");
  const body = await readJson(response);
  const records = extractRecords(body);
  const models = records
    .map((record) => firstString(record, ["id", "model_name", "modelName", "name"]))
    .filter((model): model is string => model !== undefined);
  return uniqueSorted(models);
}

export async function readUserTeams(env: LiteLLMPortalEnv, teamIds: string[]): Promise<LiteLLMTeam[]> {
  const ids = uniqueSorted(teamIds.map((teamId) => teamId.trim()).filter((teamId) => teamId.length > 0));
  const teams = await Promise.all(
    ids.map(async (teamId) => {
      try {
        const response = await litellmFetch(env, `/team/info?team_id=${encodeURIComponent(teamId)}`);
        const body = await readJson(response);
        const team = teamInfoRecord(body);
        if (team !== undefined) {
          return normalizeTeam(team, teamId);
        }
        return normalizeTeam({ team_id: teamId }, teamId);
      } catch {
        return normalizeTeam({ team_id: teamId }, teamId);
      }
    }),
  );
  return teams;
}

export function normalizeKey(record: Record<string, unknown>, fallbackUserId: string): LiteLLMKey {
  const keyInfo = isRecord(record.key_info) ? record.key_info : {};
  const merged = { ...keyInfo, ...record };
  const rawKey = firstString(merged, ["key", "token", "api_key"]);
  const id = firstString(merged, ["key_hash", "keyHash", "token", "token_id", "id", "key_alias"])
    ?? rawKey
    ?? "unknown";
  const alias = firstString(merged, ["key_alias", "keyAlias", "alias", "key_name"]) ?? null;
  const keyModels = stringArrayField(merged, "models");
  const teamModels = stringArrayField(merged, "team_models");
  return {
    id,
    alias,
    displayKey: rawKey === undefined ? null : maskKey(rawKey),
    userId: firstString(merged, ["user_id", "userId", "user_email", "userEmail"]) ?? fallbackUserId,
    teamId: firstString(merged, ["team_id", "teamId"]) ?? null,
    models: uniqueSorted(keyModels.length > 0 ? keyModels : teamModels),
    spend: roundCurrency(numberField(merged, "spend") ?? numberField(merged, "total_spend") ?? 0),
    maxBudget: numberField(merged, "max_budget") ?? numberField(merged, "maxBudget") ?? null,
    createdAt: firstString(merged, ["created_at", "createdAt"]) ?? null,
    expiresAt: firstString(merged, ["expires", "expires_at", "expiresAt"]) ?? null,
    blocked: booleanField(merged, "blocked") ?? null,
    raw: record,
  };
}

export function normalizeTeam(record: Record<string, unknown>, fallbackTeamId: string): LiteLLMTeam {
  return {
    id: firstString(record, ["team_id", "teamId", "id"]) ?? fallbackTeamId,
    alias: firstString(record, ["team_alias", "teamAlias", "alias"]) ?? null,
    models: uniqueSorted(stringArrayField(record, "models")),
    spend: nullableRoundCurrency(numberField(record, "spend") ?? numberField(record, "total_spend")),
    maxBudget: numberField(record, "max_budget") ?? numberField(record, "maxBudget") ?? null,
    tpmLimit: numberField(record, "tpm_limit") ?? numberField(record, "tpmLimit") ?? null,
    rpmLimit: numberField(record, "rpm_limit") ?? numberField(record, "rpmLimit") ?? null,
    blocked: booleanField(record, "blocked") ?? null,
    budgetDuration: firstString(record, ["budget_duration", "budgetDuration"]) ?? null,
    budgetResetAt: firstString(record, ["budget_reset_at", "budgetResetAt"]) ?? null,
  };
}

export function publicKey(key: LiteLLMKey): Record<string, JsonValue> {
  return {
    id: key.id,
    alias: key.alias,
    displayKey: key.displayKey,
    userId: key.userId,
    teamId: key.teamId,
    models: key.models,
    spend: key.spend,
    maxBudget: key.maxBudget,
    createdAt: key.createdAt,
    expiresAt: key.expiresAt,
    blocked: key.blocked,
  };
}

export function publicTeam(team: LiteLLMTeam): Record<string, JsonValue> {
  return {
    id: team.id,
    alias: team.alias,
    models: team.models,
    spend: team.spend,
    maxBudget: team.maxBudget,
    tpmLimit: team.tpmLimit,
    rpmLimit: team.rpmLimit,
    blocked: team.blocked,
    budgetDuration: team.budgetDuration,
    budgetResetAt: team.budgetResetAt,
  };
}

export function keyBelongsToUser(record: Record<string, unknown>, userId: string): boolean {
  const normalizedUserId = userId.trim().toLowerCase();
  const keyInfo = isRecord(record.key_info) ? record.key_info : {};
  const merged = { ...keyInfo, ...record };
  const explicitUser = firstString(merged, ["user_id", "userId", "user_email", "userEmail"]);
  if (explicitUser !== undefined) {
    return explicitUser.trim().toLowerCase() === normalizedUserId;
  }

  const metadata = merged.metadata;
  if (isRecord(metadata)) {
    const metadataUser = firstString(metadata, ["portal_email", "user_id", "user_email"]);
    if (metadataUser !== undefined) {
      return metadataUser.trim().toLowerCase() === normalizedUserId;
    }
  }

  return false;
}

export function extractRecords(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.filter(isRecord);
  }
  if (!isRecord(value)) {
    return [];
  }

  for (const key of ["keys", "users", "data", "key_info", "results"]) {
    const nested = value[key];
    if (Array.isArray(nested)) {
      return nested.filter(isRecord);
    }
  }
  return [];
}

export function teamInfoRecord(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return isRecord(value.team_info) ? value.team_info : value;
}

export function configuredAllowedModels(env: LiteLLMPortalEnv): string[] {
  return csv(env.LITELLM_ALLOWED_MODELS);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = stringField(record, key);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

export function stringArrayField(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

export function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function booleanField(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

export function numberLikeField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function dateLikeField(record: Record<string, unknown>, keys: string[]): Date | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      const date = new Date(value);
      if (!Number.isNaN(date.getTime())) {
        return date;
      }
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      const date = new Date(value < 10_000_000_000 ? value * 1000 : value);
      if (!Number.isNaN(date.getTime())) {
        return date;
      }
    }
  }
  return undefined;
}

export type CreateKeyParams = {
  keyAlias: string;
  models?: string[];
  maxBudget?: number | null;
  duration?: string | null;
};

export type CreateKeyResult = {
  rawKey: string;
  keyAlias: string | null;
  expires: string | null;
  keyId: string;
};

export async function createKey(
  env: LiteLLMPortalEnv,
  userId: string,
  params: CreateKeyParams,
): Promise<CreateKeyResult> {
  const body: Record<string, unknown> = {
    user_id: userId,
    key_alias: params.keyAlias,
    metadata: { portal_email: userId },
  };
  if (params.models && params.models.length > 0) body.models = params.models;
  if (params.maxBudget != null) body.max_budget = params.maxBudget;
  if (params.duration) body.duration = params.duration;

  const response = await litellmFetch(env, "/key/generate", {
    method: "POST",
    body: JSON.stringify(body),
  });
  const result = await readJson(response);
  if (!isRecord(result)) {
    throw new Error("LiteLLM did not return a key");
  }
  const rawKey = firstString(result, ["key"]) ?? "";
  if (!rawKey) throw new Error("LiteLLM did not return a key");
  return {
    rawKey,
    keyAlias: firstString(result, ["key_alias", "key_alias_name"]) ?? null,
    expires: firstString(result, ["expires"]) ?? null,
    keyId: firstString(result, ["token_id", "key_hash"]) ?? "",
  };
}

export function maskKey(key: string): string {
  if (key.length <= 10) {
    return `${key.slice(0, 2)}...`;
  }
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
}

export function litellmDateTime(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function csv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
