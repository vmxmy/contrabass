import { litellmFetch, teamInfoRecord, numberField } from "../litellm";
import { readJson } from "../utils";
import { postAlertWebhook } from "../observability/alert-webhook";
import type { LiteLLMPortalEnv } from "../types";

/** Budget ratio at/over which a per-team webhook alert fires. Fixed (no
 *  tenant-facing config) — the per-user email threshold is separate. */
const BUDGET_ALERT_RATIO = 0.8;

/** Minimal IndexDO surface we need. Inline to avoid pulling cloudflare:workers into tests. */
type IndexDOStub = {
  listTeams(): Promise<Array<{ id: string; alias: string }>>;
};

/** Minimal TeamConfigDO surface we need. Inline to avoid pulling cloudflare:workers into tests. */
type TeamConfigDOStub = {
  putSpend(snapshot: { teamId: string; currentSpend: number; maxBudget: number | null; fetchedAt: string }): Promise<void>;
  recordSpendError(reason: string): Promise<void>;
  getAlertWebhook(): Promise<{ url: string; updatedAt: string; updatedBy: string } | null>;
  hasBudgetAlertForCycle(cycleKey: string): Promise<boolean>;
  markBudgetAlertForCycle(cycleKey: string): Promise<void>;
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

      // Per-team budget webhook alert. Own try/catch so a webhook failure
      // never aborts the snapshot loop (at-least-once: not marked on failure).
      try {
        if (maxBudget != null && maxBudget > 0 && currentSpend / maxBudget >= BUDGET_ALERT_RATIO) {
          const webhook = await stub.getAlertWebhook();
          if (webhook) {
            const cycleKey = new Date().toISOString().slice(0, 7); // YYYY-MM
            if (!(await stub.hasBudgetAlertForCycle(cycleKey))) {
              const res = await postAlertWebhook(webhook.url, {
                type: "budget_threshold",
                teamId: team.id,
                teamAlias: team.alias ?? null,
                currentSpend,
                maxBudget,
                ratio: currentSpend / maxBudget,
                threshold: BUDGET_ALERT_RATIO,
                cycleKey,
                firedAt: new Date().toISOString(),
              });
              if (res.ok) await stub.markBudgetAlertForCycle(cycleKey);
            }
          }
        }
      } catch (alertErr) {
        console.error(`[spend-snapshot] alert webhook failed for ${team.id}:`, alertErr);
      }
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
