import { describe, it, expect, vi } from "vitest";
import { runUsageRollup, ROLLUP_KEY } from "./usage-rollup";
import type { LiteLLMPortalEnv } from "../types";

function envWith(kv: { put: any }, users: string[], srcSpend: (u: string) => number | "throw") {
  const indexStub = {
    listAllUsers: vi.fn(async () => ({ users: users.map((u) => ({ userId: u, role: "user", maxBudget: 10 })), cursor: undefined })),
  };
  globalThis.fetch = vi.fn(async (url: any) => {
    const uid = new URL(url).searchParams.get("user_id")!;
    const v = srcSpend(uid);
    if (v === "throw") return new Response("", { status: 503 });
    return new Response(JSON.stringify({ results: [{ date: "2026-05-16", metrics: { spend: v, api_requests: 1, total_tokens: 2 }, breakdown: { models: {} } }] }), { status: 200 });
  }) as any;
  return {
    LITELLM_BASE_URL: "https://l.test", LITELLM_MASTER_KEY: "k",
    INDEX_DO: { idFromName: () => ({}), get: () => indexStub },
    USAGE_ROLLUP_KV: kv,
  } as unknown as LiteLLMPortalEnv;
}

type PutFn = (key: string, value: string, opts?: { expirationTtl?: number }) => Promise<void>;

describe("runUsageRollup", () => {
  it("writes per-user windowed rollup to KV", async () => {
    const put = vi.fn<PutFn>(async () => {});
    const env = envWith({ put }, ["laoxu", "jiang"], (u) => (u === "laoxu" ? 5 : 2));
    await runUsageRollup(env);
    expect(put).toHaveBeenCalledTimes(1);
    const [key, json] = put.mock.calls[0];
    expect(key).toBe(ROLLUP_KEY);
    const r = JSON.parse(json);
    expect(r.users.find((x: any) => x.userId === "laoxu").win["30d"].spend).toBe(5);
    expect(typeof r.generatedAt).toBe("string");
  });

  it("skips a failing user, keeps the rest", async () => {
    const put = vi.fn<PutFn>(async () => {});
    const env = envWith({ put }, ["ok", "bad"], (u) => (u === "bad" ? "throw" : 3));
    await runUsageRollup(env);
    const r = JSON.parse(put.mock.calls[0][1]);
    expect(r.users.map((u: any) => u.userId)).toEqual(["ok"]);
  });

  it("does NOT overwrite KV when the whole run fails (roster fetch throws)", async () => {
    const put = vi.fn<PutFn>(async () => {});
    const env = { INDEX_DO: { idFromName: () => ({}), get: () => ({ listAllUsers: vi.fn(async () => { throw new Error("idx down"); }) }) },
      USAGE_ROLLUP_KV: { put }, LITELLM_BASE_URL: "https://l.test", LITELLM_MASTER_KEY: "k" } as unknown as LiteLLMPortalEnv;
    await runUsageRollup(env);
    expect(put).not.toHaveBeenCalled();
  });
});
