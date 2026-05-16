/**
 * @vitest-environment happy-dom
 */
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { KpiBand } from "./kpi-band";
import { AlertPanel } from "./alert-panel";
import { UserTable } from "./user-table";

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

describe("AlertPanel", () => {
  it("renders status dots + text, no tint pills", () => {
    const { container, getByText } = render(
      <AlertPanel alerts={[{ tone: "danger", title: "配额预警", text: "已用 70.7%" }]} />,
    );
    expect(getByText("配额预警")).toBeTruthy();
    expect(container.querySelector("[data-dot='danger']")).toBeTruthy();
  });
  it("renders nothing when no alerts", () => {
    const { container } = render(<AlertPanel alerts={[]} />);
    expect(container.firstChild).toBeNull();
  });
});

describe("UserTable", () => {
  it("calls onSelect with userId and maxBudget on row click", () => {
    let picked: { userId: string; maxBudget: number | null } | null = null;
    const { getByText } = render(
      <UserTable
        rows={[{ userId: "u1", email: "u1@x.com", spend: 5, maxBudget: 10, role: "user" }]}
        onSelect={(p) => { picked = p; }}
      />,
    );
    getByText("u1@x.com").click();
    expect(picked).toEqual({ userId: "u1", maxBudget: 10 });
  });
});
