import { describe, it, expect } from "vitest";
import { canMigrate } from "./migrate-user-id";
import type { LiteLLMPortalEnv } from "../types";

// These cases short-circuit BEFORE any LiteLLM call, so they need no network:
// the migration gate must fail closed for reserved/empty ids.
const env = {} as LiteLLMPortalEnv;

describe("canMigrate — fail-closed gate (no network paths)", () => {
  it("rejects the reserved special accounts", async () => {
    expect((await canMigrate(env, "admin")).eligible).toBe(false);
    expect((await canMigrate(env, "default_user_id")).reason).toBe("reserved_account");
    expect((await canMigrate(env, "agent-app")).eligible).toBe(false);
  });

  it("rejects an empty user id", async () => {
    expect(await canMigrate(env, "")).toEqual({ eligible: false, reason: "empty_user_id" });
    expect((await canMigrate(env, "   ")).reason).toBe("empty_user_id");
  });
});
