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
