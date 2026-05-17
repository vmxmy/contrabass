import { describe, expect, it } from "vitest";
import { buildChartAriaDescription } from "./build-chart-aria";

describe("buildChartAriaDescription (§A.1, OQ2)", () => {
  it("is a pure locale-driven template (en variant differs from zh)", () => {
    const zh = buildChartAriaDescription(
      { windowLabel: "近 30 天", points: 12, grain: "day" },
      { template: "Token 用量趋势图，时间范围为 {window}，共 {points} 个 {grain} 粒度数据点。" },
    );
    const en = buildChartAriaDescription(
      { windowLabel: "Last 30 days", points: 12, grain: "day" },
      { template: "Token usage trend chart, range {window}, {points} {grain}-grain data points." },
    );
    expect(zh).toBe("Token 用量趋势图，时间范围为 近 30 天，共 12 个 day 粒度数据点。");
    expect(en).toBe("Token usage trend chart, range Last 30 days, 12 day-grain data points.");
    expect(en).not.toContain("用量趋势图");
  });

  it("missing placeholders are left literal (no throw on a partial template)", () => {
    expect(
      buildChartAriaDescription({ windowLabel: "W", points: 1, grain: "g" }, { template: "no slots" }),
    ).toBe("no slots");
  });
});
