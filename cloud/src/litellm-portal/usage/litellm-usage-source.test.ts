import { describe, it, expect, vi, beforeEach } from "vitest";
import { LiteLLMUsageSource } from "./litellm-usage-source";
import type { LiteLLMPortalEnv } from "../types";

const env = { LITELLM_BASE_URL: "https://l.test", LITELLM_MASTER_KEY: "k" } as unknown as LiteLLMPortalEnv;
const day = (d: string, spend: number, reqs: number) => ({
  date: d, metrics: { spend, api_requests: reqs, total_tokens: reqs * 2 },
  breakdown: { models: { gpt: { metrics: { spend, api_requests: reqs, total_tokens: reqs * 2 } } } },
});
function mockFetch(bodyOrStatus: unknown, status = 200) {
  globalThis.fetch = vi.fn().mockResolvedValue(
    new Response(typeof bodyOrStatus === "number" ? "" : JSON.stringify(bodyOrStatus),
      { status: typeof bodyOrStatus === "number" ? bodyOrStatus : status }));
}

describe("LiteLLMUsageSource", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("self KPI splits current vs previous by date", async () => {
    const now = Date.parse("2026-05-16T10:00:00+08:00");
    mockFetch({ results: [day("2026-05-15", 5, 50), day("2026-05-16", 7, 70)] });
    const src = new LiteLLMUsageSource(env, now);
    const k = await src.queryKpiWithDelta({
      scope: { kind: "user", userId: "laoxu" },
      currentFromMs: now - 86400000, currentToMs: now,
      previousFromMs: now - 2 * 86400000, previousToMs: now - 86400000,
    });
    expect(k.current.spend).toBe(7);
    expect(k.previous.spend).toBe(5);
    expect(vi.mocked(globalThis.fetch).mock.calls[0][0]).toContain("/user/daily/activity?");
    expect(vi.mocked(globalThis.fetch).mock.calls[0][0]).toContain("user_id=laoxu");
  });

  it("queryModelBreakdown excludes models with zero requests", async () => {
    // #given a day whose breakdown has a used model and an unused (0-request) model
    const body = { results: [{
      date: "2026-05-16",
      metrics: { spend: 5, api_requests: 50, total_tokens: 100 },
      breakdown: { models: {
        "gpt-5.5": { metrics: { spend: 5, api_requests: 50, total_tokens: 100 } },
        "glm-zero": { metrics: { spend: 0, api_requests: 0, total_tokens: 0 } },
      } },
    }] };
    const now = Date.parse("2026-05-16T23:00:00+08:00");
    mockFetch(body);
    const src = new LiteLLMUsageSource(env, now);
    // #when
    const models = await src.queryModelBreakdown({
      scope: { kind: "user", userId: "u" },
      fromMs: now - 86400000,
      toMs: now,
    });
    // #then the zero-request model is filtered out
    expect(models.map((m) => m.model)).toEqual(["gpt-5.5"]);
  });

  it("global scope hits /aggregated (no user_id)", async () => {
    mockFetch({ results: [day("2026-05-16", 9, 90)] });
    const src = new LiteLLMUsageSource(env, Date.now());
    await src.queryModelBreakdown({ scope: { kind: "global" }, fromMs: Date.now() - 86400000, toMs: Date.now() });
    const url = vi.mocked(globalThis.fetch).mock.calls[0][0] as string;
    expect(url).toContain("/user/daily/activity/aggregated");
    expect(url).not.toContain("user_id=");
  });

  it("coalesces concurrent identical fetches (origin called once)", async () => {
    mockFetch({ results: [day("2026-05-16", 1, 1)] });
    const src = new LiteLLMUsageSource(env, Date.now());
    const s = { kind: "user" as const, userId: "u" };
    const w = { currentFromMs: 0, currentToMs: 1, previousFromMs: 0, previousToMs: 0 };
    await Promise.all([src.queryKpiWithDelta({ scope: s, ...w }), src.queryKpiWithDelta({ scope: s, ...w })]);
    expect(vi.mocked(globalThis.fetch).mock.calls.length).toBe(1);
  });

  it("5xx/timeout → unavailable sentinel (caller maps to available:false)", async () => {
    mockFetch(503);
    const src = new LiteLLMUsageSource(env, Date.now());
    await expect(
      src.queryKpiWithDelta({ scope: { kind: "user", userId: "u" }, currentFromMs: 0, currentToMs: 1, previousFromMs: 0, previousToMs: 0 }),
    ).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("4xx / no data → empty (not error)", async () => {
    mockFetch({ results: [] });
    const src = new LiteLLMUsageSource(env, Date.now());
    const k = await src.queryKpiWithDelta({ scope: { kind: "user", userId: "u" }, currentFromMs: 0, currentToMs: 1, previousFromMs: 0, previousToMs: 0 });
    expect(k.current.spend).toBe(0);
    const ts = await src.queryTimeseries({ scope: { kind: "user", userId: "u" }, grain: "day", fromMs: 0, toMs: 1 });
    expect(ts).toEqual([]);
  });

  it("explicit 4xx LiteLLMRequestError → empty (not error)", async () => {
    mockFetch(404);
    const src = new LiteLLMUsageSource(env, Date.now());
    const k = await src.queryKpiWithDelta({ scope: { kind: "user", userId: "u" }, currentFromMs: 0, currentToMs: 1, previousFromMs: 0, previousToMs: 0 });
    expect(k.current.spend).toBe(0);
  });

  it("previousFromMs=0 sentinel does not widen the fetch start_date", async () => {
    const now = Date.parse("2026-05-16T10:00:00+08:00");
    mockFetch({ results: [] });
    const src = new LiteLLMUsageSource(env, now);
    await src.queryKpiWithDelta({ scope: { kind: "user", userId: "u" }, currentFromMs: now - 86400000, currentToMs: now, previousFromMs: 0, previousToMs: 0 });
    const url = vi.mocked(globalThis.fetch).mock.calls[0][0] as string;
    expect(url).toContain("start_date=2026-05-15"); // NOT 1970
  });
});
