import type { JsonValue, LiteLLMAuditEvent, LiteLLMKey, LiteLLMKeyList, LiteLLMTeam, LiteLLMUser, LiteLLMPortalEnv } from "./types";
import { isRecord, nullableRoundCurrency, readJson, roundCurrency, uniqueSorted } from "./utils";

export class LiteLLMRequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`litellm_request_failed_${status}`);
    this.name = "LiteLLMRequestError";
  }
}

export class KeyAliasConflictError extends Error {
  constructor(readonly keyAlias: string) {
    super("key_alias_conflict");
    this.name = "KeyAliasConflictError";
  }
}

type DeleteKeyRequestBody =
  | { keys: string[] }
  | { key_aliases: string[] };

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
    throw new LiteLLMRequestError(response.status, await readJson(response));
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
  const merged = mergedKeyRecord(record);
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
  const merged = mergedKeyRecord(record);
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

function mergedKeyRecord(record: Record<string, unknown>): Record<string, unknown> {
  const keyInfo = isRecord(record.key_info) ? record.key_info : {};
  return { ...keyInfo, ...record };
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

  let response: Response;
  try {
    response = await litellmFetch(env, "/key/generate", {
      method: "POST",
      body: JSON.stringify(body),
    });
  } catch (error) {
    if (isKeyAliasConflictError(error, params.keyAlias)) {
      throw new KeyAliasConflictError(params.keyAlias);
    }
    throw error;
  }
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

export async function deleteKey(
  env: LiteLLMPortalEnv,
  key: LiteLLMKey,
  changedBy?: string,
): Promise<void> {
  const headers = new Headers();
  if (changedBy && changedBy.trim().length > 0) {
    headers.set("litellm-changed-by", changedBy.trim());
  }

  await litellmFetch(env, "/key/delete", {
    method: "POST",
    headers,
    body: JSON.stringify(deleteKeyRequestBody(key)),
  });
}

function deleteKeyRequestBody(key: LiteLLMKey): DeleteKeyRequestBody {
  const merged = mergedKeyRecord(key.raw);
  const keyIdentifier = firstString(merged, ["key_hash", "keyHash", "token", "key", "api_key"]);
  if (keyIdentifier !== undefined && keyIdentifier !== key.alias) {
    return { keys: [keyIdentifier] };
  }
  if (key.alias !== null && key.alias.trim().length > 0) {
    return { key_aliases: [key.alias] };
  }
  const fallbackIdentifier = firstString(merged, ["token_id", "id"]) ?? (key.id === "unknown" ? undefined : key.id);
  if (fallbackIdentifier !== undefined) {
    return { keys: [fallbackIdentifier] };
  }
  throw new Error("key_delete_identifier_missing");
}

function isKeyAliasConflictError(error: unknown, keyAlias: string): boolean {
  if (!(error instanceof LiteLLMRequestError)) return false;
  return isKeyAliasConflictResponse(error.status, error.body, keyAlias);
}

function isKeyAliasConflictResponse(status: number, body: unknown, keyAlias: string): boolean {
  const text = errorText(body).toLowerCase();
  const normalizedAlias = keyAlias.trim().toLowerCase();
  const mentionsAlias = /\bkey[_\s-]?alias(?:es)?\b|\balias\b|\bkey\s+name\b/u.test(text)
    || (normalizedAlias.length > 0 && text.includes(normalizedAlias));
  const mentionsConflict = /already\s+(?:exists?|in\s+use)|duplicate|unique|conflict|same\s+name|\bexists?\b/u.test(text);
  return (status === 409 && (text.length === 0 || mentionsAlias || mentionsConflict))
    || (status === 400 && mentionsAlias && mentionsConflict);
}

function errorText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(errorText).join(" ");
  }
  if (!isRecord(value)) return "";
  return Object.entries(value)
    .map(([key, nested]) => `${key} ${errorText(nested)}`)
    .join(" ");
}

export async function updateKeyBlocked(
  env: LiteLLMPortalEnv,
  keyId: string,
  blocked: boolean,
  changedBy?: string,
): Promise<void> {
  const headers = new Headers();
  if (changedBy && changedBy.trim().length > 0) {
    headers.set("litellm-changed-by", changedBy.trim());
  }
  await litellmFetch(env, "/key/update", {
    method: "POST",
    headers,
    body: JSON.stringify({ key: keyId, blocked }),
  });
}

export async function updateTeamLimits(
  env: LiteLLMPortalEnv,
  teamId: string,
  params: { tpmLimit?: number | null; rpmLimit?: number | null; maxBudget?: number | null },
  changedBy?: string,
): Promise<void> {
  const headers = new Headers();
  if (changedBy && changedBy.trim().length > 0) {
    headers.set("litellm-changed-by", changedBy.trim());
  }
  const body: Record<string, unknown> = { team_id: teamId };
  if (params.tpmLimit !== undefined) body.tpm_limit = params.tpmLimit;
  if (params.rpmLimit !== undefined) body.rpm_limit = params.rpmLimit;
  if (params.maxBudget !== undefined) body.max_budget = params.maxBudget;
  await litellmFetch(env, "/team/update", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

export async function updateUser(
  env: LiteLLMPortalEnv,
  userId: string,
  params: { role?: string; maxBudget?: number | null },
  changedBy?: string,
): Promise<void> {
  const headers = new Headers();
  if (changedBy && changedBy.trim().length > 0) {
    headers.set("litellm-changed-by", changedBy.trim());
  }
  const body: Record<string, unknown> = { user_id: userId };
  if (params.role !== undefined) body.user_role = params.role;
  if (params.maxBudget !== undefined) body.max_budget = params.maxBudget;
  await litellmFetch(env, "/user/update", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

export async function deleteKeyById(
  env: LiteLLMPortalEnv,
  keyId: string,
  changedBy?: string,
): Promise<void> {
  const headers = new Headers();
  if (changedBy && changedBy.trim().length > 0) {
    headers.set("litellm-changed-by", changedBy.trim());
  }
  await litellmFetch(env, "/key/delete", {
    method: "POST",
    headers,
    body: JSON.stringify({ keys: [keyId] }),
  });
}

/**
 * Fetch a single key by id (for typed-confirmation checks and audit before/after snapshots).
 * Returns `null` when LiteLLM responds with 404 or a non-record payload.
 */
export async function getKeyInfo(env: LiteLLMPortalEnv, keyId: string): Promise<LiteLLMKey | null> {
  const params = new URLSearchParams({ key: keyId });
  let response: Response;
  try {
    response = await litellmFetch(env, `/key/info?${params.toString()}`);
  } catch (error) {
    if (error instanceof LiteLLMRequestError && error.status === 404) return null;
    throw error;
  }
  const payload = await response.json() as unknown;
  if (!payload || typeof payload !== "object") return null;
  const record = (payload as Record<string, unknown>).info ?? payload;
  if (!record || typeof record !== "object") return null;
  return normalizeKey(record as Record<string, unknown>, keyId);
}

/**
 * Fetch a single team by id for audit before/after snapshots.
 * Returns `null` when LiteLLM responds with 404.
 */
export async function getTeamInfo(env: LiteLLMPortalEnv, teamId: string): Promise<LiteLLMTeam | null> {
  const params = new URLSearchParams({ team_id: teamId });
  let response: Response;
  try {
    response = await litellmFetch(env, `/team/info?${params.toString()}`);
  } catch (error) {
    if (error instanceof LiteLLMRequestError && error.status === 404) return null;
    throw error;
  }
  const payload = await response.json() as unknown;
  if (!payload || typeof payload !== "object") return null;
  const record = teamInfoRecord(payload) ?? (payload as Record<string, unknown>);
  return normalizeTeam(record, teamId);
}

/**
 * Fetch a single user by id for audit before/after snapshots and role/budget context.
 * Returns `null` when LiteLLM responds with 404.
 */
export async function getUserInfo(
  env: LiteLLMPortalEnv,
  userId: string,
): Promise<{ userId: string; role: string | null; maxBudget: number | null } | null> {
  const params = new URLSearchParams({ user_id: userId });
  let response: Response;
  try {
    response = await litellmFetch(env, `/v2/user/info?${params.toString()}`);
  } catch (error) {
    if (error instanceof LiteLLMRequestError && error.status === 404) return null;
    throw error;
  }
  const payload = await response.json() as unknown;
  if (!payload || typeof payload !== "object") return null;
  const record = (payload as Record<string, unknown>).user ?? payload;
  if (!record || typeof record !== "object") return null;
  const r = record as Record<string, unknown>;
  return {
    userId: firstString(r, ["user_id", "userId", "id"]) ?? userId,
    role: firstString(r, ["user_role", "userRole", "role"]) ?? null,
    maxBudget: numberField(r, "max_budget") ?? numberField(r, "maxBudget") ?? null,
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

const ADMIN_PAGE_SIZE_MAX = 100;
const ADMIN_PAGE_SIZE_DEFAULT = 50;

function clampAdminPageSize(size: number | undefined): number {
  const n = typeof size === "number" && Number.isFinite(size) ? Math.floor(size) : ADMIN_PAGE_SIZE_DEFAULT;
  return Math.min(Math.max(n, 1), ADMIN_PAGE_SIZE_MAX);
}

export async function listAllUsers(
  env: LiteLLMPortalEnv,
  opts?: { page?: number; size?: number },
): Promise<{ users: LiteLLMUser[]; totalCount: number; page: number; size: number }> {
  const page = typeof opts?.page === "number" && opts.page >= 1 ? Math.floor(opts.page) : 1;
  const size = clampAdminPageSize(opts?.size);
  const params = new URLSearchParams({
    page: String(page),
    page_size: String(size),
  });
  const response = await litellmFetch(env, `/user/list?${params.toString()}`);
  const body = await readJson(response);
  const records = extractRecords(body);
  const totalCount = isRecord(body)
    ? numberField(body, "total_count") ?? numberField(body, "totalCount") ?? records.length
    : records.length;
  const users: LiteLLMUser[] = records.map((record) => {
    const userId = firstString(record, ["user_id", "userId", "id"]) ?? "";
    const email = firstString(record, ["user_email", "userEmail", "email"]) ?? userId;
    return {
      userId,
      email,
      spend: roundCurrency(numberField(record, "spend") ?? numberField(record, "total_spend") ?? 0),
      maxBudget: numberField(record, "max_budget") ?? numberField(record, "maxBudget") ?? null,
      teamIds: stringArrayField(record, "teams"),
      role: firstString(record, ["user_role", "userRole", "role"]) ?? null,
      found: true,
      raw: record,
    };
  });
  return { users, totalCount, page, size };
}

export async function listAllTeams(env: LiteLLMPortalEnv): Promise<LiteLLMTeam[]> {
  const response = await litellmFetch(env, "/team/list");
  const body = await readJson(response);
  const records = extractRecords(body);
  return records.map((record) => {
    const teamId = firstString(record, ["team_id", "teamId", "id"]) ?? "";
    return normalizeTeam(record, teamId);
  });
}

function normalizeAuditEvent(record: Record<string, unknown>): LiteLLMAuditEvent {
  return {
    id: firstString(record, ["id", "audit_id", "auditId"]) ?? "",
    createdAt: firstString(record, ["created_at", "createdAt", "timestamp"]) ?? null,
    action: firstString(record, ["action", "event", "event_type", "eventType"]) ?? "",
    actorUserId: firstString(record, ["actor_user_id", "actorUserId", "user_id", "userId"]) ?? null,
    actorUserEmail: firstString(record, ["actor_user_email", "actorUserEmail", "user_email", "userEmail"]) ?? null,
    objectType: firstString(record, ["object_type", "objectType", "resource_type", "resourceType"]) ?? null,
    objectId: firstString(record, ["object_id", "objectId", "resource_id", "resourceId"]) ?? null,
  };
}

export async function listAuditEvents(
  env: LiteLLMPortalEnv,
  opts?: { page?: number; size?: number },
): Promise<{ events: LiteLLMAuditEvent[]; totalCount: number; page: number; size: number }> {
  const page = typeof opts?.page === "number" && opts.page >= 1 ? Math.floor(opts.page) : 1;
  const size = clampAdminPageSize(opts?.size);
  const params = new URLSearchParams({
    page: String(page),
    page_size: String(size),
  });
  const response = await litellmFetch(env, `/audit?${params.toString()}`);
  const body = await readJson(response);
  const records = extractRecords(body);
  const totalCount = isRecord(body)
    ? numberField(body, "total_count") ?? numberField(body, "totalCount") ?? records.length
    : records.length;
  const events = records.map(normalizeAuditEvent);
  return { events, totalCount, page, size };
}
