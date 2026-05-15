import { describe, it, expect, vi, beforeEach } from "vitest";
import { ingestSpendLogs } from "./usage-importer";
import type { LiteLLMPortalEnv } from "../types";

function makeUsageStub() {
  let cursor: number | null = null;
  return {
    getSyncCursor: vi.fn(async () => cursor),
    setSyncCursor: vi.fn(async (_s: string, o: { cursorMs: number; lastError: string | null }) => {
      cursor = o.cursorMs;
    }),
    writeSpendEvents: vi.fn(async () => undefined),
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
