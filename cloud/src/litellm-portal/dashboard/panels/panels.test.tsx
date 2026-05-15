/**
 * @vitest-environment happy-dom
 */
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { KpiBand } from "./kpi-band";
import { RecentTable } from "./recent-table";

afterEach(cleanup);

describe("KpiBand", () => {
  const kpi = {
    spend: { current: 45.2, previous: 40, deltaPct: 13 },
    requests: { current: 312, previous: null, deltaPct: null },
    totalTokens: { current: 1000, previous: 900, deltaPct: 11 },
  };
  it("renders three metrics and tabular values", () => {
    const { getByText } = render(<KpiBand kpi={kpi} />);
    expect(getByText("$45.20")).toBeTruthy();
    expect(getByText("312")).toBeTruthy();
  });
  it("shows — when deltaPct is null", () => {
    const { getAllByText } = render(<KpiBand kpi={kpi} />);
    expect(getAllByText("—").length).toBeGreaterThan(0);
  });
});

describe("RecentTable", () => {
  it("empty state", () => {
    const { getByText } = render(<RecentTable rows={[]} />);
    expect(getByText("暂无记录")).toBeTruthy();
  });
  it("renders rows without a status column", () => {
    const { container, queryByText } = render(
      <RecentTable rows={[{ tsMs: 0, model: "gpt", totalTokens: 10, spend: 0.03 }]} />,
    );
    expect(container.querySelectorAll("tbody tr").length).toBe(1);
    expect(queryByText("状态")).toBeNull();
  });
});
