/**
 * @vitest-environment happy-dom
 */
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { I18nProvider } from "@lingui/react";
import { setupI18n } from "../i18n/setup";
import { DensityProvider } from "../components/density";
import { PanelCard } from "./panel-card";

const i18n = setupI18n("zh-CN");
const wrap = (ui: React.ReactElement) =>
  render(<I18nProvider i18n={i18n}>{ui}</I18nProvider>);
afterEach(cleanup);

describe("PanelCard — frame & header", () => {
  it("renders children inside the card body when state is ready (default)", () => {
    const { container } = wrap(
      <PanelCard title="API Keys">
        <p>hello-body</p>
      </PanelCard>,
    );
    expect(screen.getByText("hello-body")).toBeTruthy();
    expect(container.querySelector("[data-panel-card]")).not.toBeNull();
    expect(container.querySelector("[data-panel-card-body]")).not.toBeNull();
  });

  it("renders a header with the string title", () => {
    wrap(<PanelCard title="用量概览">x</PanelCard>);
    expect(screen.getByText("用量概览")).toBeTruthy();
  });

  it("omits the header entirely when no title/icon/actions are given", () => {
    const { container } = wrap(<PanelCard>only-body</PanelCard>);
    expect(container.querySelector("[data-panel-card-header]")).toBeNull();
    expect(screen.getByText("only-body")).toBeTruthy();
  });

  it("renders subtitle, icon and actions in the header", () => {
    wrap(
      <PanelCard
        title="标题"
        subtitle="副标题"
        icon={<svg data-testid="ic" />}
        actions={<button type="button">新建</button>}
      >
        b
      </PanelCard>,
    );
    expect(screen.getByText("副标题")).toBeTruthy();
    expect(screen.getByTestId("ic")).toBeTruthy();
    expect(screen.getByRole("button", { name: "新建" })).toBeTruthy();
  });

  it("uses the chrome inherited from the legacy Panel (rounded-xl + border-kumo-line + bg-kumo-base) and imposes NO outer margin", () => {
    const { container } = wrap(<PanelCard title="t">b</PanelCard>);
    const card = container.querySelector("[data-panel-card]") as HTMLElement;
    expect(card.className).toContain("rounded-xl");
    expect(card.className).toContain("border-kumo-line");
    expect(card.className).toContain("bg-kumo-base");
    expect(card.className).not.toMatch(/(^|\s)mb-\d/);
  });
});

describe("PanelCard — density-driven body padding (S4)", () => {
  it("uses comfortable padding p-6 by default (no DensityProvider)", () => {
    const { container } = wrap(<PanelCard title="t">b</PanelCard>);
    const body = container.querySelector(
      "[data-panel-card-body]",
    ) as HTMLElement;
    expect(body.className).toContain("p-6");
  });

  it("uses compact padding p-4 under DensityProvider density=compact", () => {
    const { container } = wrap(
      <DensityProvider density="compact">
        <PanelCard title="t">b</PanelCard>
      </DensityProvider>,
    );
    const body = container.querySelector(
      "[data-panel-card-body]",
    ) as HTMLElement;
    expect(body.className).toContain("p-4");
    expect(body.className).not.toContain("p-6");
  });

  it("applies NO body padding class when padded={false}", () => {
    const { container } = wrap(
      <PanelCard title="t" padded={false}>
        b
      </PanelCard>,
    );
    const body = container.querySelector(
      "[data-panel-card-body]",
    ) as HTMLElement;
    expect(body.className).not.toContain("p-6");
    expect(body.className).not.toContain("p-4");
  });
});
