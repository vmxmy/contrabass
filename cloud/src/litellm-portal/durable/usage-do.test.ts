import { describe, it, expect } from "vitest";
import { UsageDO } from "./usage-do";
import type { LiteLLMPortalEnv } from "../types";
import { makeTestSqlStorage } from "../../test/sql-storage";

function makeUsageDO() {
  const env = {} as LiteLLMPortalEnv;
  const ctx = { storage: { sql: makeTestSqlStorage() } } as unknown as DurableObjectState;
  return new UsageDO(ctx, env);
}

describe("UsageDO schema", () => {
  it("initializes tables and is idempotent across calls", async () => {
    const obj = makeUsageDO();
    await obj.writeSpendEvents([]);
    await expect(obj.writeSpendEvents([])).resolves.toBeUndefined();
  });
});

describe("UsageDO writeSpendEvents dedupe + cursor", () => {
  it("INSERT OR IGNORE dedupes by requestId across calls", async () => {
    const obj = makeUsageDO();
    const ev = {
      requestId: "r1",
      tsMs: 1000,
      userId: "u1",
      teamId: "t1",
      model: "gpt",
      promptTokens: 1,
      completionTokens: 2,
      totalTokens: 3,
      spend: 0.5,
    };
    await obj.writeSpendEvents([ev]);
    await obj.writeSpendEvents([{ ...ev, spend: 999 }]);
    const recent = await obj.queryRecentEvents({ userId: "u1", limit: 10 });
    expect(recent).toEqual([{ tsMs: 1000, model: "gpt", totalTokens: 3, spend: 0.5 }]);
  });

  it("sync cursor get returns null then round-trips set", async () => {
    const obj = makeUsageDO();
    expect(await obj.getSyncCursor("spend_logs")).toBeNull();
    await obj.setSyncCursor("spend_logs", { cursorMs: 5000, lastError: null });
    expect(await obj.getSyncCursor("spend_logs")).toBe(5000);
  });
});
