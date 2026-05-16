import { describe, it, expect, vi, beforeEach } from "vitest";
import { ingestSpendLogs } from "./usage-importer";
import { refreshDailyActivity, pruneUsageRetention } from "./usage-importer";
import type { LiteLLMPortalEnv } from "../types";

function makeUsageStub() {
  const cursors: Record<string, number | null> = {};
  return {
    getSyncCursor: vi.fn(async (source: string) => cursors[source] ?? null),
    setSyncCursor: vi.fn(async (source: string, o: { cursorMs: number; lastError: string | null }) => {
      cursors[source] = o.cursorMs;
    }),
    writeSpendEvents: vi.fn(async () => undefined),
    resetSpendLogsCursorForMappingMigration: vi.fn(async (v: number) => {
      cursors["spend_logs"] = null;
      cursors["spend_logs_userid_mapping_v"] = v;
    }),
  };
}

function makeEnv(usageStub: unknown): LiteLLMPortalEnv {
  return {
    LITELLM_BASE_URL: "https://litellm.test",
    LITELLM_MASTER_KEY: "k",
    USAGE_DO: {
      idFromName: (n: string) => ({ name: n }),
      get: () => usageStub,
    } as unknown,
  } as unknown as LiteLLMPortalEnv;
}

describe("ingestSpendLogs", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("writes parsed events and advances cursor to max ts", async () => {
    const usage = makeUsageStub();
    const env = makeEnv(usage);
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              request_id: "r1",
              startTime: "2026-05-13T01:00:00",
              user_id: "u1",
              team_id: "t1",
              model: "gpt",
              prompt_tokens: 1,
              completion_tokens: 2,
              total_tokens: 3,
              spend: 0.5,
            },
          ],
          total_pages: 1,
        }),
        { status: 200 },
      ),
    );
    const r = await ingestSpendLogs(env);
    expect(r.ingested).toBe(1);
    expect(usage.writeSpendEvents).toHaveBeenCalledWith([
      expect.objectContaining({ requestId: "r1", userId: "u1", totalTokens: 3, spend: 0.5 }),
    ]);
    expect(usage.setSyncCursor).toHaveBeenCalledWith("spend_logs", expect.objectContaining({ lastError: null }));
  });

  it("records lastError and does not advance cursor on fetch failure", async () => {
    const usage = makeUsageStub();
    const env = makeEnv(usage);
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("boom", { status: 503 }));
    const r = await ingestSpendLogs(env);
    expect(r.ingested).toBe(0);
    expect(r.error).toBeTruthy();
    const lastCall = usage.setSyncCursor.mock.calls.at(-1);
    expect(lastCall?.[1].lastError).toBeTruthy();
  });

  it("returns gracefully when USAGE_DO unset", async () => {
    const r = await ingestSpendLogs({ LITELLM_BASE_URL: "x", LITELLM_MASTER_KEY: "x" } as LiteLLMPortalEnv);
    expect(r.ingested).toBe(0);
    expect(r.error).toContain("USAGE_DO");
  });

  it("paginates across pages until total_pages and ingests all", async () => {
    const usage = makeUsageStub();
    const env = makeEnv(usage);
    let call = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      call += 1;
      const page = call;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [
              {
                request_id: `r${page}`,
                startTime: "2026-05-13T0" + page + ":00:00",
                user_id: "u1",
                team_id: "t",
                model: "gpt",
                prompt_tokens: 1,
                completion_tokens: 1,
                total_tokens: 2,
                spend: 1,
              },
            ],
            total_pages: 3,
          }),
          { status: 200 },
        ),
      );
    });
    const r = await ingestSpendLogs(env);
    expect(r.ingested).toBe(3);
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3);
    expect(usage.writeSpendEvents).toHaveBeenCalledTimes(3);
  });

  it("first-run failure persists floor cursor but next run still re-attempts full backfill window", async () => {
    const usage = makeUsageStub();
    const env = makeEnv(usage);
    globalThis.fetch = vi.fn().mockResolvedValueOnce(new Response("boom", { status: 503 }));
    const r1 = await ingestSpendLogs(env);
    expect(r1.error).toBeTruthy();
    // cursor was persisted (floor ~ now-30d). Next run: window end is still "now",
    // so a successful tick ingests everything in [~30d-5min, now].
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              request_id: "r1",
              startTime: "2026-05-13T01:00:00",
              user_id: "u1",
              team_id: "t",
              model: "gpt",
              prompt_tokens: 1,
              completion_tokens: 1,
              total_tokens: 2,
              spend: 1,
            },
          ],
          total_pages: 1,
        }),
        { status: 200 },
      ),
    );
    const r2 = await ingestSpendLogs(env);
    expect(r2.error).toBeNull();
    expect(r2.ingested).toBe(1);
  });
});

describe("toSpendEvent userId/teamId field resolution", () => {
  beforeEach(() => vi.restoreAllMocks());

  function makeMinimalRecord(overrides: Record<string, unknown>): Record<string, unknown> {
    return {
      request_id: "req-test",
      startTime: "2026-05-13T01:00:00",
      model: "gpt",
      prompt_tokens: 1,
      completion_tokens: 2,
      total_tokens: 3,
      spend: 0.1,
      ...overrides,
    };
  }

  async function extractEvent(overrides: Record<string, unknown>) {
    const usage = makeUsageStub();
    const env = makeEnv(usage);
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [makeMinimalRecord(overrides)], total_pages: 1 }), { status: 200 }),
    );
    await ingestSpendLogs(env);
    const calls = usage.writeSpendEvents.mock.calls as unknown as Array<[Array<{ userId: string; teamId: string }>]>;
    return calls[0]?.[0]?.[0];
  }

  it("(a) resolves userId and teamId from metadata.user_api_key_user_id / metadata.user_api_key_team_id (primary)", async () => {
    const ev = await extractEvent({
      metadata: { user_api_key_user_id: "xu@gz-zhiyun.com", user_api_key_team_id: "team-meta" },
      user_id: "wrong-user",
      team_id: "wrong-team",
    });
    expect(ev?.userId).toBe("xu@gz-zhiyun.com");
    expect(ev?.teamId).toBe("team-meta");
  });

  it("(a2) resolves userId/teamId when metadata is a JSON-encoded STRING (LiteLLM key-auth shape)", async () => {
    const ev = await extractEvent({
      metadata: JSON.stringify({ user_api_key_user_id: "laoxu", user_api_key_team_id: "t1" }),
      user_id: "wrong-user",
      team_id: "wrong-team",
    });
    expect(ev?.userId).toBe("laoxu");
    expect(ev?.teamId).toBe("t1");
  });

  it("(a3) falls back gracefully (no throw) when metadata is an invalid JSON string", async () => {
    const ev = await extractEvent({
      metadata: "{not valid json",
      user_id: "fallback-user",
      team_id: "fallback-team",
    });
    expect(ev?.userId).toBe("fallback-user");
    expect(ev?.teamId).toBe("fallback-team");
  });

  it("(a4) metadata object still works (regression)", async () => {
    const ev = await extractEvent({
      metadata: { user_api_key_user_id: "obj-user", user_api_key_team_id: "obj-team" },
    });
    expect(ev?.userId).toBe("obj-user");
    expect(ev?.teamId).toBe("obj-team");
  });

  it("(b) falls back to top-level user when metadata is absent", async () => {
    const ev = await extractEvent({ user: "user-from-top-level" });
    expect(ev?.userId).toBe("user-from-top-level");
  });

  it("(c) falls back to legacy top-level user_id when metadata and user are absent", async () => {
    const ev = await extractEvent({ user_id: "legacy-user-id" });
    expect(ev?.userId).toBe("legacy-user-id");
  });

  it("(d) resolves to empty string when no user fields are present", async () => {
    const ev = await extractEvent({});
    expect(ev?.userId).toBe("");
    expect(ev?.teamId).toBe("");
  });

  it("metadata.user_api_key_team_id takes priority over top-level team_id", async () => {
    const ev = await extractEvent({
      metadata: { user_api_key_team_id: "meta-team" },
      team_id: "top-level-team",
    });
    expect(ev?.teamId).toBe("meta-team");
  });

  it("dedup key uses the same resolved userId (stable across re-ingest)", async () => {
    const usage = makeUsageStub();
    const env = makeEnv(usage);
    const record = makeMinimalRecord({
      request_id: undefined,
      metadata: { user_api_key_user_id: "stable-user" },
    });
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [record], total_pages: 1 }), { status: 200 }),
    );
    await ingestSpendLogs(env);
    const calls = usage.writeSpendEvents.mock.calls as unknown as Array<[Array<{ requestId: string; userId: string }>]>;
    const ev = calls[0]?.[0]?.[0];
    expect(ev?.requestId).toContain("stable-user");
    expect(ev?.userId).toBe("stable-user");
  });
});

describe("ingestSpendLogs one-time mapping migration sentinel", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("calls resetSpendLogsCursorForMappingMigration with version 3 when sentinel is absent", async () => {
    const usage = makeUsageStub();
    const env = makeEnv(usage);
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [], total_pages: 1 }), { status: 200 }),
    );
    await ingestSpendLogs(env);
    expect(usage.resetSpendLogsCursorForMappingMigration).toHaveBeenCalledOnce();
    expect(usage.resetSpendLogsCursorForMappingMigration).toHaveBeenCalledWith(3);
  });

  it("re-fires the reset once when stored sentinel is the older version 2", async () => {
    const usage = makeUsageStub();
    // Stored sentinel is v2 (the metadata-string fix bumped it to v3).
    await usage.resetSpendLogsCursorForMappingMigration(2);
    usage.resetSpendLogsCursorForMappingMigration.mockClear();

    const env = makeEnv(usage);
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [], total_pages: 1 }), { status: 200 }),
    );
    await ingestSpendLogs(env);
    expect(usage.resetSpendLogsCursorForMappingMigration).toHaveBeenCalledOnce();
    expect(usage.resetSpendLogsCursorForMappingMigration).toHaveBeenCalledWith(3);
  });

  it("does NOT call resetSpendLogsCursorForMappingMigration when sentinel already at version 3 (idempotent)", async () => {
    const usage = makeUsageStub();
    // Pre-seed the sentinel at the current version 3.
    await usage.resetSpendLogsCursorForMappingMigration(3);
    usage.resetSpendLogsCursorForMappingMigration.mockClear();

    const env = makeEnv(usage);
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [], total_pages: 1 }), { status: 200 }),
    );
    await ingestSpendLogs(env);
    expect(usage.resetSpendLogsCursorForMappingMigration).not.toHaveBeenCalled();
  });

  it("does not touch daily_activity cursor during migration reset", async () => {
    const usage = makeUsageStub();
    // Simulate daily_activity cursor already set.
    await usage.setSyncCursor("daily_activity", { cursorMs: 99999, lastError: null });
    usage.setSyncCursor.mockClear();

    const env = makeEnv(usage);
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [], total_pages: 1 }), { status: 200 }),
    );
    await ingestSpendLogs(env);
    // daily_activity cursor must not have been reset.
    const dailyCursorAfter = await usage.getSyncCursor("daily_activity");
    expect(dailyCursorAfter).toBe(99999);
  });
});

function makeDailyStub() {
  let cursor: number | null = null;
  return {
    getSyncCursor: vi.fn(async (_s?: string) => cursor),
    setSyncCursor: vi.fn(async (_s: string, o: { cursorMs: number }) => {
      cursor = o.cursorMs;
    }),
    upsertDailyRows: vi.fn(async () => undefined),
    pruneRetention: vi.fn(async () => undefined),
  };
}

describe("refreshDailyActivity", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("parses real LiteLLM shape: breakdown.models[m].metrics + day.metrics __all__, sends timezone=-480", async () => {
    const stub = makeDailyStub();
    const env = makeEnv(stub);
    let calledUrl = "";
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      calledUrl = url;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            results: [
              {
                date: "2026-05-14",
                metrics: {
                  spend: 5,
                  total_tokens: 100,
                  prompt_tokens: 40,
                  completion_tokens: 60,
                  api_requests: 10,
                  successful_requests: 9,
                  failed_requests: 1,
                },
                breakdown: {
                  models: {
                    gpt: {
                      metrics: {
                        spend: 4,
                        total_tokens: 80,
                        prompt_tokens: 30,
                        completion_tokens: 50,
                        api_requests: 8,
                        successful_requests: 8,
                        failed_requests: 0,
                      },
                    },
                    claude: {
                      metrics: {
                        spend: 1,
                        total_tokens: 20,
                        prompt_tokens: 10,
                        completion_tokens: 10,
                        api_requests: 2,
                        successful_requests: 1,
                        failed_requests: 1,
                      },
                    },
                  },
                },
              },
            ],
            metadata: { total_pages: 1, has_more: false },
          }),
          { status: 200 },
        ),
      );
    });
    const r = await refreshDailyActivity(env);
    expect(r.error).toBeNull();
    expect(calledUrl).toContain("timezone=-480");
    const allCalls = stub.upsertDailyRows.mock.calls as unknown as Array<[Array<Record<string, unknown>>]>;
    const rows = allCalls[0][0];
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          date: "2026-05-14",
          userId: "__global__",
          model: "gpt",
          spend: 4,
          totalTokens: 80,
          requests: 8,
          successRequests: 8,
          failedRequests: 0,
        }),
        expect.objectContaining({
          date: "2026-05-14",
          userId: "__global__",
          model: "claude",
          spend: 1,
          requests: 2,
          successRequests: 1,
          failedRequests: 1,
        }),
        expect.objectContaining({
          date: "2026-05-14",
          userId: "__global__",
          model: "__all__",
          spend: 5,
          totalTokens: 100,
          requests: 10,
          successRequests: 9,
          failedRequests: 1,
        }),
      ]),
    );
  });

  it("first run (no cursor) backfills 365d; sets cursor on success", async () => {
    const stub = makeDailyStub();
    const env = makeEnv(stub);
    let qs = "";
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      qs = url;
      return Promise.resolve(
        new Response(JSON.stringify({ results: [], metadata: { total_pages: 1, has_more: false } }), { status: 200 }),
      );
    });
    const r = await refreshDailyActivity(env);
    expect(r.error).toBeNull();
    // 365d window: start_date should be ~365 days before end_date.
    const start = new Date(decodeURIComponent(qs.match(/start_date=([^&]+)/)![1]));
    const end = new Date(decodeURIComponent(qs.match(/end_date=([^&]+)/)![1]));
    const days = Math.round((end.getTime() - start.getTime()) / 86400000);
    expect(days).toBeGreaterThanOrEqual(364);
    expect(days).toBeLessThanOrEqual(366);
    expect(stub.setSyncCursor).toHaveBeenCalledWith("daily_activity", expect.objectContaining({ lastError: null }));
  });

  it("subsequent run (cursor set) uses short trailing window, not 365d", async () => {
    const stub = makeDailyStub();
    const env = makeEnv(stub);
    await stub.setSyncCursor("daily_activity", { cursorMs: Date.now() });
    let qs = "";
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      qs = url;
      return Promise.resolve(
        new Response(JSON.stringify({ results: [], metadata: { total_pages: 1, has_more: false } }), { status: 200 }),
      );
    });
    await refreshDailyActivity(env);
    const start = new Date(decodeURIComponent(qs.match(/start_date=([^&]+)/)![1]));
    const end = new Date(decodeURIComponent(qs.match(/end_date=([^&]+)/)![1]));
    const days = Math.round((end.getTime() - start.getTime()) / 86400000);
    expect(days).toBeLessThanOrEqual(4);
  });

  it("paginates via metadata.total_pages", async () => {
    const stub = makeDailyStub();
    const env = makeEnv(stub);
    let calls = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      calls += 1;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            results: [
              {
                date: "2026-05-1" + calls,
                metrics: {
                  spend: 1,
                  total_tokens: 1,
                  api_requests: 1,
                  successful_requests: 1,
                  failed_requests: 0,
                },
                breakdown: { models: {} },
              },
            ],
            metadata: { total_pages: 3, has_more: calls < 3 },
          }),
          { status: 200 },
        ),
      );
    });
    const r = await refreshDailyActivity(env);
    expect(calls).toBe(3);
    expect(r.ingested).toBe(3); // one __all__ row per page
  });

  it("first-run fetch failure leaves cursor null (so backfill retries) + error", async () => {
    const stub = makeDailyStub();
    const env = makeEnv(stub);
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("boom", { status: 503 }));
    const r = await refreshDailyActivity(env);
    expect(r.error).toBeTruthy();
    expect(await stub.getSyncCursor("daily_activity")).toBeNull();
    expect(stub.upsertDailyRows).not.toHaveBeenCalled();
  });

  it("empty results → no upsert, ingested 0, error null", async () => {
    const stub = makeDailyStub();
    const env = makeEnv(stub);
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ results: [], metadata: { total_pages: 1, has_more: false } }), { status: 200 }),
      );
    const r = await refreshDailyActivity(env);
    expect(r.ingested).toBe(0);
    expect(r.error).toBeNull();
    expect(stub.upsertDailyRows).not.toHaveBeenCalled();
  });
});

describe("pruneUsageRetention", () => {
  it("calls UsageDO.pruneRetention with now", async () => {
    const stub = makeDailyStub();
    const env = makeEnv(stub);
    await pruneUsageRetention(env);
    expect(stub.pruneRetention).toHaveBeenCalledTimes(1);
  });
});
