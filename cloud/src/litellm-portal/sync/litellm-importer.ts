import type { LiteLLMPortalEnv, LiteLLMTeam } from "../types";
import type { TeamRecord } from "../durable/schemas";
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
