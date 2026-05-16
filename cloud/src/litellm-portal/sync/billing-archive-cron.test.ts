import { describe, it, expect, vi, beforeEach } from "vitest";
import { runMonthlyBillingArchive } from "./billing-archive-cron";
import type { LiteLLMPortalEnv } from "../types";

type R2Stub = {
  head: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
};

function makeR2Stub(overrides: Partial<R2Stub> = {}): R2Stub {
  return {
    head: vi.fn().mockResolvedValue(null),
    put: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(null),
    list: vi.fn().mockResolvedValue({ objects: [] }),
    ...overrides,
  };
}

function makeEnv(
  teams: Array<{ id: string; alias: string }>,
  r2: R2Stub | undefined,
): LiteLLMPortalEnv {
  const idx = { listTeams: vi.fn().mockResolvedValue(teams) };
  return {
    LITELLM_BASE_URL: "https://litellm.test",
    LITELLM_MASTER_KEY: "test-key",
    INDEX_DO: {
      idFromName: (_n: string) => ({ name: _n }),
      get: () => idx,
    } as unknown,
    BILLING_ARCHIVE_R2: r2 as unknown,
  } as unknown as LiteLLMPortalEnv;
}

/** A LiteLLM /team/daily/activity body with one day, one model. */
function activityBody(model: string, spend: number, requests: number, tokens: number) {
  return {
    results: [
      {
        date: "2026-04-15",
        metrics: { spend, api_requests: requests, total_tokens: tokens },
        breakdown: {
          models: {
            [model]: { metrics: { spend, api_requests: requests, total_tokens: tokens } },
          },
        },
      },
    ],
  };
}

describe("runMonthlyBillingArchive", () => {
  // 2026-05-17 → previous full month is April 2026.
  const NOW = new Date("2026-05-17T03:00:00.000Z");

  beforeEach(() => vi.restoreAllMocks());

  it("empty team list → header-only CSV, written, teams 0", async () => {
    const r2 = makeR2Stub();
    const env = makeEnv([], r2);
    const result = await runMonthlyBillingArchive(env, NOW);

    expect(result.yearMonth).toBe("2026-04");
    expect(result.objectKey).toBe("billing/2026/04.csv");
    expect(result.teams).toBe(0);
    expect(result.written).toBe(true);
    expect(result.errors).toEqual([]);
    expect(r2.put).toHaveBeenCalledOnce();
    const [key, csv] = r2.put.mock.calls[0];
    expect(key).toBe("billing/2026/04.csv");
    expect(csv).toBe(
      "team_id,team_alias,period_start,period_end,total_spend_usd,total_requests,total_tokens,top_model,top_model_spend_usd,generated_at",
    );
  });

  it("2 teams happy path → exact CSV with RFC-4180 quoted alias", async () => {
    const r2 = makeR2Stub();
    const env = makeEnv(
      [
        { id: "t1", alias: "Acme, Inc." },
        { id: "t2", alias: "beta" },
      ],
      r2,
    );
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      const teamId = url.match(/team_ids=([^&]+)/)?.[1];
      const body =
        teamId === "t1"
          ? activityBody("gpt-4", 12.5, 100, 5000)
          : activityBody("claude", 7.25, 40, 2000);
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    });

    const result = await runMonthlyBillingArchive(env, NOW);
    expect(result.teams).toBe(2);
    expect(result.written).toBe(true);
    expect(result.errors).toEqual([]);

    const csv = r2.put.mock.calls[0][1] as string;
    const lines = csv.split("\n");
    expect(lines).toHaveLength(3);
    const gen = lines[1].split(",").slice(-1)[0];
    expect(lines[0]).toBe(
      "team_id,team_alias,period_start,period_end,total_spend_usd,total_requests,total_tokens,top_model,top_model_spend_usd,generated_at",
    );
    expect(lines[1]).toBe(
      `t1,"Acme, Inc.",2026-04-01,2026-04-30,12.500000,100,5000,gpt-4,12.500000,${gen}`,
    );
    expect(lines[2]).toBe(
      `t2,beta,2026-04-01,2026-04-30,7.250000,40,2000,claude,7.250000,${gen}`,
    );
  });

  it("per-team 5xx → error captured, loop continues, that team row all zeros", async () => {
    const r2 = makeR2Stub();
    const env = makeEnv(
      [
        { id: "t1", alias: "a" },
        { id: "t2", alias: "b" },
      ],
      r2,
    );
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      const teamId = url.match(/team_ids=([^&]+)/)?.[1];
      if (teamId === "t1") return Promise.resolve(new Response("boom", { status: 503 }));
      return Promise.resolve(
        new Response(JSON.stringify(activityBody("gpt-4", 3, 9, 99)), { status: 200 }),
      );
    });

    const result = await runMonthlyBillingArchive(env, NOW);
    expect(result.teams).toBe(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].teamId).toBe("t1");
    expect(result.errors[0].reason).toContain("503");

    const lines = (r2.put.mock.calls[0][1] as string).split("\n");
    const gen = lines[1].split(",").slice(-1)[0];
    expect(lines[1]).toBe(`t1,a,2026-04-01,2026-04-30,0.000000,0,0,,0.000000,${gen}`);
    expect(lines[2]).toBe(`t2,b,2026-04-01,2026-04-30,3.000000,9,99,gpt-4,3.000000,${gen}`);
  });

  it("existing object → idempotent skip, put NOT called", async () => {
    const r2 = makeR2Stub({ head: vi.fn().mockResolvedValue({ key: "billing/2026/04.csv" }) });
    const env = makeEnv([{ id: "t1", alias: "a" }], r2);

    const result = await runMonthlyBillingArchive(env, NOW);
    expect(result.written).toBe(false);
    expect(result.teams).toBe(0);
    expect(r2.put).not.toHaveBeenCalled();
  });

  it("missing BILLING_ARCHIVE_R2 → early return, no throw", async () => {
    const env = makeEnv([{ id: "t1", alias: "a" }], undefined);
    const result = await runMonthlyBillingArchive(env, NOW);
    expect(result.written).toBe(false);
    expect(result.teams).toBe(0);
    expect(result.errors[0].reason).toContain("BILLING_ARCHIVE_R2");
  });
});
