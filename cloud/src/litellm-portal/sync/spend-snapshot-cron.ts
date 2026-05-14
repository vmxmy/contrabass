import type { LiteLLMPortalEnv } from "../types";

/** Minimal IndexDO surface we need. Inline to avoid pulling cloudflare:workers into tests. */
type IndexDOStub = {
  listTeams(): Promise<Array<{ id: string; alias: string }>>;
};

/** Result summary of one spend-snapshot cron tick. */
export type SpendSnapshotTickResult = {
  scannedTeams: number;
  refreshedTeams: number;
  errors: Array<{ teamId: string; reason: string }>;
};

/** Run one tick of the per-minute spend mirror.
 *
 *  Reads IndexDO.teams:list and iterates teams. Per-team fetch of
 *  /team/info from LiteLLM and writeback to TeamConfigDO.putSpend will be
 *  implemented in T-5.3 (PDCSOT-40). For now, this stub returns the team
 *  count and writes zero spend snapshots.
 *
 *  Defensive: returns gracefully if bindings are unset or IndexDO is empty.
 *  Throws nothing the scheduled() invoker can't catch. */
export async function runSpendSnapshotTick(env: LiteLLMPortalEnv): Promise<SpendSnapshotTickResult> {
  if (!env.INDEX_DO) {
    return { scannedTeams: 0, refreshedTeams: 0, errors: [{ teamId: "(global)", reason: "INDEX_DO binding not configured" }] };
  }
  const idxStub = env.INDEX_DO.get(env.INDEX_DO.idFromName("index")) as unknown as IndexDOStub;
  const teams = await idxStub.listTeams();
  // T-5.3 / PDCSOT-40 will fill the per-team /team/info + putSpend loop here.
  return { scannedTeams: teams.length, refreshedTeams: 0, errors: [] };
}
