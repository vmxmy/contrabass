import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const src = readFileSync("src/litellm-portal/tenant-portal/routes.tsx", "utf8");

describe("F5/D9 dead MemberForbidden default branch removed", () => {
  it("createTenantPortalRoutes no longer falls back to MemberForbidden", () => {
    expect(src).not.toContain("spec.component ?? MemberForbidden");
  });
});
