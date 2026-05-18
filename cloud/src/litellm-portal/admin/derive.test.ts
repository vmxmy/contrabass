import { afterEach, describe, expect, it, vi } from "vitest";
import { text, deriveHealthSummary, relativeTime } from "./derive";

afterEach(() => vi.restoreAllMocks());

describe("text", () => {
  it("returns — for null / undefined / empty string", () => {
    expect(text(null)).toBe("—");
    expect(text(undefined)).toBe("—");
    expect(text("")).toBe("—");
  });
  it("stringifies present values", () => {
    expect(text("a")).toBe("a");
    expect(text(0)).toBe("0");
  });
});

describe("deriveHealthSummary", () => {
  it("danger tone when over-budget and riskCount>=10", () => {
    const r = deriveHealthSummary({ overBudgetTeamCount: 2, riskCount: 10 });
    expect(r.tone).toBe("danger");
    expect(r.message).toContain("2 个团队超预算");
  });
  it("warning tone when over-budget and riskCount<10", () => {
    expect(deriveHealthSummary({ overBudgetUserCount: 1, riskCount: 1 }).tone).toBe("warning");
  });
  it("warning with unmanaged roles when risk but no over-budget", () => {
    const r = deriveHealthSummary({ riskCount: 3, unmanagedRoleCount: 2 });
    expect(r.tone).toBe("warning");
    expect(r.message).toContain("2 个未映射角色");
  });
  it("success when all clear", () => {
    expect(deriveHealthSummary({})).toEqual({ message: "系统正常", tone: "success" });
  });
});

describe("relativeTime", () => {
  it("just now for <60s / future / invalid", () => {
    const now = 1_000_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    expect(relativeTime(new Date(now - 5_000).toISOString())).toBe("just now");
    expect(relativeTime(new Date(now + 5_000).toISOString())).toBe("just now");
    expect(relativeTime("not-a-date")).toBe("just now");
  });
  it("m/h/d ago buckets", () => {
    const now = 1_000_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    expect(relativeTime(new Date(now - 5 * 60_000).toISOString())).toBe("5m ago");
    expect(relativeTime(new Date(now - 3 * 3_600_000).toISOString())).toBe("3h ago");
    expect(relativeTime(new Date(now - 2 * 86_400_000).toISOString())).toBe("2d ago");
  });
});
