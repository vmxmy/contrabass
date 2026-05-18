import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const shell = readFileSync("src/litellm-portal/tenant-portal/shell.tsx", "utf8");

describe("F3 Phase-2 notice retired", () => {
  it("no longer references the stale Phase 2 copy", () => {
    expect(shell).not.toContain("运营控制台将在 Phase 2 提供");
    expect(shell).not.toContain("Operations Console arrives in Phase 2");
    expect(shell).not.toContain("OwnerPhase2Notice");
  });
  it("offers a valid Ops Console entry pointing to /ops", () => {
    expect(shell).toContain('href="/ops"');
    expect(shell).toContain("OwnerOpsEntry");
    expect(shell).toContain("t`运营控制台`");
  });
  it("the Owner entry is still gated behind isPureOwner only", () => {
    expect(shell).toContain("const owner = isPureOwner(identity)");
    expect(shell).toContain("{owner ? (");
    expect(shell).toContain("<OwnerOpsEntry />");
  });
});
