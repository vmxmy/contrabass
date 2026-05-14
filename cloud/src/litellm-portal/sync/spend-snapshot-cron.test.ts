import { describe, it, expect, vi, beforeEach } from "vitest";
import { runSpendSnapshotTick } from "./spend-snapshot-cron";
import type { LiteLLMPortalEnv } from "../types";

function makeIdxStub(teams: Array<{ id: string; alias: string }>) {
  return {
    listTeams: vi.fn().mockResolvedValue(teams),
  };
}

function makeTeamStub() {
  return {
    putSpend: vi.fn().mockResolvedValue(undefined),
    recordSpendError: vi.fn().mockResolvedValue(undefined),
  };
}

function makeEnv(
  teams: Array<{ id: string; alias: string }>,
  teamStubGetter?: (id: string) => unknown,
): LiteLLMPortalEnv {
  const defaultTeamStub = makeTeamStub();
  const idx = makeIdxStub(teams);
  return {
    LITELLM_BASE_URL: "https://litellm.test",
    LITELLM_MASTER_KEY: "test-key",
    INDEX_DO: {
      idFromName: (_n: string) => ({ name: _n }) as unknown,
      get: () => idx,
    } as unknown,
    TEAM_CONFIG_DO: {
      idFromName: (n: string) => ({ name: n }),
      get: (doId: { name: string }) =>
        teamStubGetter ? teamStubGetter(doId.name) : defaultTeamStub,
    } as unknown,
  } as unknown as LiteLLMPortalEnv;
}

describe("runSpendSnapshotTick", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("empty team list → all-zero result", async () => {
    const env = makeEnv([]);
    const r = await runSpendSnapshotTick(env);
    expect(r).toEqual({ scannedTeams: 0, refreshedTeams: 0, errors: [] });
  });

  it("happy path: 2 teams, both fetched and written", async () => {
    const stubT1 = makeTeamStub();
    const stubT2 = makeTeamStub();
    const env = makeEnv(
      [{ id: "t1", alias: "a" }, { id: "t2", alias: "b" }],
      (id: string) => id === "t1" ? stubT1 : stubT2,
    );
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      const teamId = url.match(/team_id=([^&]+)/)?.[1];
      const spend = teamId === "t1" ? 12.5 : 7.25;
      const max = teamId === "t1" ? 100 : null;
      return Promise.resolve(new Response(JSON.stringify({ team_id: teamId, spend, max_budget: max }), { status: 200 }));
    });
    const r = await runSpendSnapshotTick(env);
    expect(r.scannedTeams).toBe(2);
    expect(r.refreshedTeams).toBe(2);
    expect(r.errors).toEqual([]);
    expect(stubT1.putSpend).toHaveBeenCalledWith(expect.objectContaining({ teamId: "t1", currentSpend: 12.5, maxBudget: 100 }));
    expect(stubT2.putSpend).toHaveBeenCalledWith(expect.objectContaining({ teamId: "t2", currentSpend: 7.25, maxBudget: null }));
  });

  it("per-team failure: loop continues, error captured", async () => {
    const stubT1 = makeTeamStub();
    const stubT2 = makeTeamStub();
    const env = makeEnv(
      [{ id: "t1", alias: "a" }, { id: "t2", alias: "b" }],
      (id: string) => id === "t1" ? stubT1 : stubT2,
    );
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      const teamId = url.match(/team_id=([^&]+)/)?.[1];
      if (teamId === "t1") return Promise.resolve(new Response("oops", { status: 503 }));
      return Promise.resolve(new Response(JSON.stringify({ team_id: "t2", spend: 5, max_budget: 50 }), { status: 200 }));
    });
    const r = await runSpendSnapshotTick(env);
    expect(r.scannedTeams).toBe(2);
    expect(r.refreshedTeams).toBe(1);
    expect(r.errors.length).toBe(1);
    expect(r.errors[0].teamId).toBe("t1");
    expect(stubT1.recordSpendError).toHaveBeenCalled();
    expect(stubT2.putSpend).toHaveBeenCalledOnce();
  });

  it("missing INDEX_DO → global error", async () => {
    const env = { LITELLM_BASE_URL: "x", LITELLM_MASTER_KEY: "x", TEAM_CONFIG_DO: {} } as unknown as LiteLLMPortalEnv;
    const r = await runSpendSnapshotTick(env);
    expect(r.scannedTeams).toBe(0);
    expect(r.errors[0].teamId).toBe("(global)");
    expect(r.errors[0].reason).toContain("INDEX_DO");
  });

  it("missing TEAM_CONFIG_DO → global error", async () => {
    const env = { LITELLM_BASE_URL: "x", LITELLM_MASTER_KEY: "x", INDEX_DO: {} } as unknown as LiteLLMPortalEnv;
    const r = await runSpendSnapshotTick(env);
    expect(r.scannedTeams).toBe(0);
    expect(r.errors[0].teamId).toBe("(global)");
    expect(r.errors[0].reason).toContain("TEAM_CONFIG_DO");
  });
});
