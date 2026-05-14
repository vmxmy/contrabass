import type { LiteLLMPortalEnv, LiteLLMTeam } from "../types";
import type { TeamRecord, UserRecord, AuditEvent } from "../durable/schemas";
import type { TeamConfigDO } from "../durable/team-config-do";
import type { IndexDO } from "../durable/index-do";
import { litellmFetch, extractRecords } from "../litellm";
import { readJson } from "../utils";

/** Result summary of the team import phase. */
export type ImportTeamsResult = {
  scannedTeams: number;
  insertedTeams: number;
  errors: Array<{ teamId: string; reason: string }>;
  limited: boolean;
};

const PAGE_CAP = 100;

function toTeamRecord(t: LiteLLMTeam): TeamRecord {
  return {
    id: t.id,
    alias: t.alias ?? t.id,
    models: t.models,
    ...(t.maxBudget != null ? { maxBudget: t.maxBudget } : {}),
    ...(t.tpmLimit != null ? { tpmLimit: t.tpmLimit } : {}),
    ...(t.rpmLimit != null ? { rpmLimit: t.rpmLimit } : {}),
    blocked: t.blocked ?? false,
    ...(t.budgetDuration != null ? { budgetDuration: t.budgetDuration } : {}),
    ...(t.budgetResetAt != null ? { budgetResetAt: t.budgetResetAt } : {}),
  };
}

/** Walk all pages of LiteLLM /team/list and seed:
 *  - One TeamConfigDO per team (via env.TEAM_CONFIG_DO.idFromName(teamId).get(...))
 *  - IndexDO.teams:list summary (id + alias)
 *
 *  Idempotent: rerunning is safe — putTeam overwrites with the latest data,
 *  IndexDO.setTeamsList overwrites the list.
 *
 *  Bounded scan: max 100 pages to avoid runaway iteration. Returns limited=true
 *  if the upstream paginator did not signal end before the cap.
 *
 *  Does NOT mark meta:imported (T-6.4's job). Does NOT call /user/list (T-6.2's job).
 */
export async function importTeams(env: LiteLLMPortalEnv): Promise<ImportTeamsResult> {
  if (!env.TEAM_CONFIG_DO) {
    throw new Error("importTeams: binding TEAM_CONFIG_DO is not configured");
  }
  if (!env.INDEX_DO) {
    throw new Error("importTeams: binding INDEX_DO is not configured");
  }
  if (!env.LITELLM_BASE_URL?.trim()) {
    throw new Error("importTeams: env.LITELLM_BASE_URL is not configured");
  }
  if (!env.LITELLM_MASTER_KEY?.trim()) {
    throw new Error("importTeams: env.LITELLM_MASTER_KEY is not configured");
  }

  const errors: Array<{ teamId: string; reason: string }> = [];
  const teamsList: Array<{ id: string; alias: string }> = [];
  let scannedTeams = 0;
  let insertedTeams = 0;
  let limited = false;

  for (let page = 1; page <= PAGE_CAP; page++) {
    const response = await litellmFetch(env, `/team/list?page=${page}`);
    const body = await readJson(response);
    const records = extractRecords(body);

    if (records.length === 0) {
      break;
    }

    for (const record of records) {
      const teamId =
        (typeof record.team_id === "string" && record.team_id.trim().length > 0
          ? record.team_id.trim()
          : undefined) ??
        (typeof record.id === "string" && record.id.trim().length > 0
          ? record.id.trim()
          : undefined) ??
        "";

      if (teamId === "") {
        errors.push({ teamId: "(unknown)", reason: "team record has no team_id or id field" });
        continue;
      }

      scannedTeams++;

      try {
        const team: LiteLLMTeam = {
          id: teamId,
          alias:
            (typeof record.team_alias === "string" && record.team_alias.trim().length > 0
              ? record.team_alias.trim()
              : null) ??
            (typeof record.alias === "string" && record.alias.trim().length > 0
              ? record.alias.trim()
              : null),
          models: Array.isArray(record.models)
            ? (record.models as unknown[]).filter((m): m is string => typeof m === "string")
            : [],
          spend:
            typeof record.spend === "number" && Number.isFinite(record.spend)
              ? record.spend
              : null,
          maxBudget:
            typeof record.max_budget === "number" && Number.isFinite(record.max_budget)
              ? record.max_budget
              : typeof record.maxBudget === "number" && Number.isFinite(record.maxBudget)
                ? record.maxBudget
                : null,
          tpmLimit:
            typeof record.tpm_limit === "number" && Number.isFinite(record.tpm_limit)
              ? record.tpm_limit
              : typeof record.tpmLimit === "number" && Number.isFinite(record.tpmLimit)
                ? record.tpmLimit
                : null,
          rpmLimit:
            typeof record.rpm_limit === "number" && Number.isFinite(record.rpm_limit)
              ? record.rpm_limit
              : typeof record.rpmLimit === "number" && Number.isFinite(record.rpmLimit)
                ? record.rpmLimit
                : null,
          blocked:
            typeof record.blocked === "boolean" ? record.blocked : null,
          budgetDuration:
            typeof record.budget_duration === "string" &&
            record.budget_duration.trim().length > 0
              ? record.budget_duration.trim()
              : typeof record.budgetDuration === "string" &&
                  record.budgetDuration.trim().length > 0
                ? record.budgetDuration.trim()
                : null,
          budgetResetAt:
            typeof record.budget_reset_at === "string" &&
            record.budget_reset_at.trim().length > 0
              ? record.budget_reset_at.trim()
              : typeof record.budgetResetAt === "string" &&
                  record.budgetResetAt.trim().length > 0
                ? record.budgetResetAt.trim()
                : null,
        };

        const teamRecord = toTeamRecord(team);
        const stub = env.TEAM_CONFIG_DO.get(env.TEAM_CONFIG_DO.idFromName(teamId)) as unknown as TeamConfigDO;
        await stub.putTeam(teamRecord);

        teamsList.push({ id: teamId, alias: teamRecord.alias });
        insertedTeams++;
      } catch (err) {
        errors.push({
          teamId,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (page === PAGE_CAP) {
      limited = true;
    }
  }

  const indexStub = env.INDEX_DO.get(env.INDEX_DO.idFromName("index")) as unknown as IndexDO;
  await indexStub.setTeamsList(teamsList);

  return { scannedTeams, insertedTeams, errors, limited };
}

/** Result summary of the user import phase. */
export type ImportUsersResult = {
  scannedUsers: number;
  insertedUsers: number;
  errors: Array<{ userId: string; reason: string }>;
  limited: boolean;
};

/** Walk all pages of LiteLLM /user/list and seed:
 *  - IndexDO.user:{userId} (the UserRecord)
 *  - IndexDO.email:{lc(email)} (the pointer; written atomically with user via IndexDO.putUser)
 *  - For each user with non-empty teamIds: TeamConfigDO.upsertMember on each referenced team
 *
 *  Idempotent. Bounded scan at 100 pages.
 *
 *  Does NOT apply BOOTSTRAP_ADMIN_EMAILS (T-6.3's job).
 *  Does NOT mark meta:imported (T-6.4's job).
 *
 *  Role mapping (from LiteLLM.role → DO UserRecord.role):
 *    "proxy_admin" | "proxy_admin_viewer"  -> "admin"
 *    everything else (including null/undefined) -> "user"
 */
export async function importUsers(env: LiteLLMPortalEnv): Promise<ImportUsersResult> {
  if (!env.INDEX_DO) {
    throw new Error("importUsers: binding INDEX_DO is not configured");
  }
  if (!env.TEAM_CONFIG_DO) {
    throw new Error("importUsers: binding TEAM_CONFIG_DO is not configured");
  }
  if (!env.LITELLM_BASE_URL?.trim()) {
    throw new Error("importUsers: env.LITELLM_BASE_URL is not configured");
  }
  if (!env.LITELLM_MASTER_KEY?.trim()) {
    throw new Error("importUsers: env.LITELLM_MASTER_KEY is not configured");
  }

  const errors: Array<{ userId: string; reason: string }> = [];
  let scannedUsers = 0;
  let insertedUsers = 0;
  let limited = false;

  const indexStub = env.INDEX_DO.get(env.INDEX_DO.idFromName("index")) as unknown as IndexDO;

  for (let page = 1; page <= PAGE_CAP; page++) {
    const response = await litellmFetch(env, `/user/list?page=${page}`);
    const body = await readJson(response);
    const records = extractRecords(body);

    if (records.length === 0) {
      break;
    }

    for (const record of records) {
      const userId =
        (typeof record.user_id === "string" && record.user_id.trim().length > 0
          ? record.user_id.trim()
          : undefined) ??
        (typeof record.id === "string" && record.id.trim().length > 0
          ? record.id.trim()
          : undefined) ??
        "";

      if (userId === "") {
        errors.push({ userId: "(unknown)", reason: "user record has no user_id or id field" });
        continue;
      }

      scannedUsers++;

      try {
        if (typeof record.email !== "string" || record.email.trim().length === 0) {
          throw new Error("user record has no valid email field");
        }
        const email = record.email.trim();

        const role: "admin" | "user" =
          record.role === "proxy_admin" || record.role === "proxy_admin_viewer" ? "admin" : "user";

        const teamIds: string[] = Array.isArray(record.team_ids)
          ? (record.team_ids as unknown[]).filter((t): t is string => typeof t === "string")
          : Array.isArray(record.teamIds)
            ? (record.teamIds as unknown[]).filter((t): t is string => typeof t === "string")
            : [];

        const maxBudget: number | undefined =
          typeof record.max_budget === "number" && Number.isFinite(record.max_budget)
            ? record.max_budget
            : typeof record.maxBudget === "number" && Number.isFinite(record.maxBudget)
              ? record.maxBudget
              : undefined;

        const rawCreatedAt =
          typeof record.created_at === "string" && record.created_at.trim().length > 0
            ? record.created_at.trim()
            : typeof record.createdAt === "string" && record.createdAt.trim().length > 0
              ? record.createdAt.trim()
              : null;
        const createdAt =
          rawCreatedAt != null && Number.isFinite(new Date(rawCreatedAt).getTime())
            ? rawCreatedAt
            : new Date().toISOString();

        const teamId: string | null = teamIds.length > 0 ? teamIds[0] : null;

        const userRecord: UserRecord = {
          userId,
          email,
          role,
          teamId,
          ...(maxBudget !== undefined ? { maxBudget } : {}),
          createdAt,
        };

        await indexStub.putUser(userRecord);

        for (const tid of teamIds) {
          const teamStub = env.TEAM_CONFIG_DO.get(
            env.TEAM_CONFIG_DO.idFromName(tid),
          ) as unknown as TeamConfigDO;
          await teamStub.upsertMember({ userId, role });
        }

        insertedUsers++;
      } catch (err) {
        errors.push({
          userId,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (page === PAGE_CAP) {
      limited = true;
    }
  }

  return { scannedUsers, insertedUsers, errors, limited };
}

/** Result summary of the bootstrap-admin pass. */
export type ApplyBootstrapAdminsResult = {
  configuredEmails: number;
  promotedToAdmin: number;
  absentFromIndex: string[];
};

/** Walk env.BOOTSTRAP_ADMIN_EMAILS (comma-separated, case-insensitive) and,
 *  for every email already known to IndexDO (from importUsers), set role=admin.
 *
 *  Emails NOT in IndexDO are returned in absentFromIndex — they'll be elevated
 *  at first-login via the magic-link flow (PDCSOT-47 / T-6.6).
 *
 *  Idempotent. Safe to re-run.
 */
export async function applyBootstrapAdmins(env: LiteLLMPortalEnv): Promise<ApplyBootstrapAdminsResult> {
  if (!env.INDEX_DO) {
    throw new Error("applyBootstrapAdmins: binding INDEX_DO is not configured");
  }

  if (!env.BOOTSTRAP_ADMIN_EMAILS?.trim()) {
    return { configuredEmails: 0, promotedToAdmin: 0, absentFromIndex: [] };
  }

  const emails = [
    ...new Set(
      env.BOOTSTRAP_ADMIN_EMAILS.split(",")
        .map((e) => e.trim().toLowerCase())
        .filter((e) => e.length > 0),
    ),
  ];

  const configuredEmails = emails.length;
  let promotedToAdmin = 0;
  const absentFromIndex: string[] = [];

  const idxStub = env.INDEX_DO.get(env.INDEX_DO.idFromName("index")) as unknown as IndexDO;

  for (const email of emails) {
    const user = await idxStub.getUserByEmail(email);

    if (user === null) {
      absentFromIndex.push(email);
      continue;
    }

    if (user.role === "admin") {
      continue;
    }

    const updatedRecord: UserRecord = { ...user, role: "admin" };
    await idxStub.putUser(updatedRecord);
    promotedToAdmin++;
  }

  return { configuredEmails, promotedToAdmin, absentFromIndex };
}

/** Aggregate summary of the one-shot import phase. */
export type ImportFinalizationSummary = {
  /** From importTeams result. */
  teamCount: number;
  /** From importUsers result. */
  userCount: number;
  /** From applyBootstrapAdmins result. */
  bootstrapAdmins: { configured: number; promoted: number; absentFromIndex: number };
  /** Cumulative errors from any prior phase (importTeams + importUsers + applyBootstrapAdmins). */
  errors: Array<{ entityId: string; reason: string }>;
};

/** Mark the one-shot import complete:
 *  - Set IndexDO.meta:imported = true
 *  - Append a single audit:{now}:import event recording the summary
 *
 *  Idempotent: if meta:imported is already true, returns early without
 *  appending a duplicate audit event.
 *
 *  Does NOT call importTeams / importUsers / applyBootstrapAdmins — the
 *  caller (T-6.5 orchestrator) is responsible for sequencing those, then
 *  calling finalizeImport with the aggregated summary.
 */
export async function finalizeImport(
  env: LiteLLMPortalEnv,
  summary: ImportFinalizationSummary,
): Promise<{ alreadyImported: boolean }> {
  if (!env.INDEX_DO) {
    throw new Error("finalizeImport: binding INDEX_DO is not configured");
  }

  const idxStub = env.INDEX_DO.get(env.INDEX_DO.idFromName("index")) as unknown as IndexDO;

  const alreadyImported = await idxStub.isImported();
  if (alreadyImported) {
    return { alreadyImported: true };
  }

  const event: AuditEvent = {
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    actorEmail: "system",
    action: "import",
    entityKind: "deployment",
    entityId: "one-shot-import",
    before: null,
    after: { ...summary },
    reason: `imported ${summary.teamCount} teams, ${summary.userCount} users, promoted ${summary.bootstrapAdmins.promoted} bootstrap admins`,
  };

  await idxStub.appendAudit(event);
  await idxStub.markImported();

  return { alreadyImported: false };
}
