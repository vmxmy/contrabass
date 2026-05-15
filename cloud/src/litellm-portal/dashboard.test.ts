import { describe, it, expect } from "vitest";
import { parseDashboardRequest, toUsageScope } from "./dashboard";

describe("parseDashboardRequest", () => {
  it("defaults window=30d, auto grain=day", () => {
    const r = parseDashboardRequest(new URL("https://x/api/usage/overview"));
    expect(r).toEqual({ ok: true, window: "30d", grain: "day", grainFallback: false });
  });

  it("accepts 24h with auto hour grain", () => {
    const r = parseDashboardRequest(new URL("https://x/api/usage/overview?window=24h"));
    expect(r).toEqual({ ok: true, window: "24h", grain: "hour", grainFallback: false });
  });

  it("rejects unsupported window with 400 body", () => {
    const r = parseDashboardRequest(new URL("https://x/o?window=90d"));
    expect(r).toEqual({
      ok: false,
      body: { error: "unsupported_usage_window", allowed: ["24h", "48h", "7d", "30d"] },
    });
  });

  it("incompatible explicit grain falls back to auto with flag", () => {
    const r = parseDashboardRequest(new URL("https://x/o?window=24h&grain=day"));
    expect(r).toEqual({ ok: true, window: "24h", grain: "hour", grainFallback: true });
  });

  it("toUsageScope maps self/member to user, global to global", () => {
    expect(toUsageScope({ kind: "self", userId: "u1" })).toEqual({ kind: "user", userId: "u1" });
    expect(toUsageScope({ kind: "member", userId: "m1" })).toEqual({ kind: "user", userId: "m1" });
    expect(toUsageScope({ kind: "global" })).toEqual({ kind: "global" });
  });
});
