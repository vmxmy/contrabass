/**
 * @vitest-environment happy-dom
 */
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { TrendChart } from "./trend-chart";
import { ModelDonut } from "./model-donut";
import { RankBar } from "./rank-bar";
afterEach(cleanup);

describe("TrendChart", () => {
  it("renders empty state when no series", () => {
    const { getByText } = render(<TrendChart series={[]} />);
    expect(getByText("暂无数据")).toBeTruthy();
  });
  it("renders a chart container when data present", () => {
    const { container } = render(
      <TrendChart series={[{ name: "Tokens", points: [[1, 10], [2, 20]] }]} />,
    );
    expect(container.querySelector("[data-chart='trend']")).toBeTruthy();
  });
});

describe("ModelDonut", () => {
  it("renders empty state when no slices", () => {
    const { getByText } = render(<ModelDonut slices={[]} />);
    expect(getByText("暂无数据")).toBeTruthy();
  });
  it("renders container with slices", () => {
    const { container } = render(
      <ModelDonut slices={[{ model: "gpt", value: 10 }, { model: "claude", value: 5 }]} />,
    );
    expect(container.querySelector("[data-chart='model-donut']")).toBeTruthy();
  });
});

describe("RankBar", () => {
  it("empty state", () => {
    const { getByText } = render(<RankBar rows={[]} />);
    expect(getByText("暂无数据")).toBeTruthy();
  });
  it("renders container", () => {
    const { container } = render(<RankBar rows={[{ label: "u1", value: 9 }]} />);
    expect(container.querySelector("[data-chart='rank-bar']")).toBeTruthy();
  });
});

