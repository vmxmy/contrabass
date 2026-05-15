import { describe, it, expect, vi, afterEach } from "vitest";
import { dashboardUrl } from "./use-dashboard";

afterEach(() => vi.restoreAllMocks());

describe("dashboardUrl", () => {
  it("self scope -> /api/usage/overview with window", () => {
    expect(dashboardUrl({ kind: "self" }, "7d")).toBe("/api/usage/overview?window=7d");
  });
  it("global scope -> /api/admin/usage/overview", () => {
    expect(dashboardUrl({ kind: "global" }, "24h")).toBe("/api/admin/usage/overview?window=24h");
  });
  it("member scope -> admin overview with member param", () => {
    expect(dashboardUrl({ kind: "member", userId: "u1" }, "30d"))
      .toBe("/api/admin/usage/overview?window=30d&member=u1");
  });
});
