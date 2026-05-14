import { litellmFetch, teamInfoRecord, numberField } from "../litellm";
import { readJson } from "../utils";
import type { LiteLLMPortalEnv } from "../types";

/** Minimal IndexDO surface we need. Inline to avoid pulling cloudflare:workers into tests. */
type IndexDOStub = {
  listTeams(): Promise<Array<{ id: string; alias: string }>>;
};

/** Minimal TeamConfigDO surface we need. Inline to avoid pulling cloudflare:workers into tests. */
type TeamConfigDOStub = {
  putSpend(snapshot: { teamId: string; currentSpend: number; maxBudget: number | null; fetchedAt: string }): Promise<void>;
  recordSpendError(reason: string): Promise<void>;
};

/** Result summary of one spend-snapshot cron tick. */
export type SpendSnapshotTickResult = {
  scannedTeams: number;
  refreshedTeams: number;
  errors: Array<{ teamId: string; reason: string }>;
};

/** Run one tick of the per-minute spend mirror.
 *
 *  Reads IndexDO.listTeams() and iterates each team. For each team, fetches
 *  /team/info from LiteLLM and writes a SpendSnapshot to TeamConfigDO.putSpend.
 *  Per-team failures do NOT abort the loop — the error is recorded on
 *  TeamConfigDO.recordSpendError and pushed to the result errors array.
 *
 *  Defensive: returns gracefully if bindings are unset or IndexDO is empty.
 *  Throws nothing the scheduled() invoker can't catch. */
export async function runSpendSnapshotTick(env: LiteLLMPortalEnv): Promise<SpendSnapshotTickResult> {
  if (!env.INDEX_DO) {
    return { scannedTeams: 0, refreshedTeams: 0, errors: [{ teamId: "(global)", reason: "INDEX_DO binding not configured" }] };
  }
  if (!env.TEAM_CONFIG_DO) {
    return { scannedTeams: 0, refreshedTeams: 0, errors: [{ teamId: "(global)", reason: "TEAM_CONFIG_DO binding not configured" }] };
  }

  const idxStub = env.INDEX_DO.get(env.INDEX_DO.idFromName("index")) as unknown as IndexDOStub;
  const teams = await idxStub.listTeams();
  const errors: Array<{ teamId: string; reason: string }> = [];
  let refreshedTeams = 0;

  for (const team of teams) {
    try {
      const response = await litellmFetch(env, `/team/info?team_id=${encodeURIComponent(team.id)}`);
      const body = await readJson(response);
      const rec = teamInfoRecord(body) ?? (body as Record<string, unknown>);

      const currentSpend = numberField(rec, "spend") ?? 0;
      const maxBudget = numberField(rec, "max_budget") ?? numberField(rec, "maxBudget") ?? null;

      const stub = env.TEAM_CONFIG_DO.get(env.TEAM_CONFIG_DO.idFromName(team.id)) as unknown as TeamConfigDOStub;
      await stub.putSpend({
        teamId: team.id,
        currentSpend,
        maxBudget,
        fetchedAt: new Date().toISOString(),
      });
      refreshedTeams++;
    } catch (err) {
      const reason = err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
      errors.push({ teamId: team.id, reason });
      try {
        const stub = env.TEAM_CONFIG_DO.get(env.TEAM_CONFIG_DO.idFromName(team.id)) as unknown as TeamConfigDOStub;
        await stub.recordSpendError(reason);
      } catch {
        // Suppress secondary failures.
      }
    }
  }

  return { scannedTeams: teams.length, refreshedTeams, errors };
}
