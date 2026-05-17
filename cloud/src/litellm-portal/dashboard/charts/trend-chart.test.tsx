/**
 * @vitest-environment happy-dom
 */
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { TrendChart } from "./trend-chart";

afterEach(cleanup);

describe("TrendChart aria (§A.1, OQ2 — added; it had none)", () => {
  it("the chart container exposes role=img + the injected localized aria-label", () => {
    const { container } = render(
      <TrendChart
        series={[{ name: "Tokens", points: [[1, 2]] }]}
        ariaLabel="Token 用量趋势图，时间范围为 近 30 天，共 1 个 day 粒度数据点。"
      />,
    );
    const el = container.querySelector('[data-chart="trend"]') as HTMLElement;
    expect(el).not.toBeNull();
    expect(el.getAttribute("role")).toBe("img");
    expect(el.getAttribute("aria-label")).toBe("Token 用量趋势图，时间范围为 近 30 天，共 1 个 day 粒度数据点。");
  });

  it("the empty branch carries no chart aria (legitimately no data)", () => {
    const { container } = render(<TrendChart series={[]} />);
    expect(container.querySelector('[data-chart="trend"]')).toBeNull();
  });
});
