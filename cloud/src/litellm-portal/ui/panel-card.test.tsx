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

describe("PanelCard — four content states render inside the frame (S3-C)", () => {
  it("state=loading renders the skeleton and NOT children", () => {
    const { container } = wrap(
      <PanelCard title="t" state={{ kind: "loading", lines: 3 }}>
        <p>should-not-show</p>
      </PanelCard>,
    );
    expect(container.querySelector("[data-panel-skeleton]")).not.toBeNull();
    expect(
      container.querySelectorAll("[data-panel-skeleton-line]").length,
    ).toBe(3);
    expect(screen.queryByText("should-not-show")).toBeNull();
  });

  it("state=empty renders PanelEmpty with title/description/action", () => {
    wrap(
      <PanelCard
        title="t"
        state={{
          kind: "empty",
          title: "暂无密钥",
          description: "去创建一个",
          action: <a href="/x">创建</a>,
        }}
      >
        c
      </PanelCard>,
    );
    expect(screen.getByText("暂无密钥")).toBeTruthy();
    expect(screen.getByText("去创建一个")).toBeTruthy();
    expect(screen.getByRole("link", { name: "创建" })).toBeTruthy();
  });

  it("state=error uses the card title as the error title and never leaks a non-catalog raw message (§F.3)", () => {
    // PanelCard renders the title in BOTH the header and (when state=error)
    // the PanelError banner — that is the intended contract (the card title
    // IS the error title). Assert it precisely inside the error region rather
    // than with a page-wide getByText, which would (correctly) find two nodes.
    const { container } = wrap(
      <PanelCard
        title="加载失败"
        state={{ kind: "error", error: new Error("Failed to fetch") }}
      >
        c
      </PanelCard>,
    );
    const errRegion = container.querySelector("[data-panel-error]");
    expect(errRegion).not.toBeNull();
    expect(errRegion?.textContent).toContain("加载失败");
    expect(container.textContent).not.toContain("Failed to fetch");
    expect(container.textContent).toContain("网络请求失败");
  });

  it("state=error falls back to a default title when card has no title", () => {
    wrap(
      <PanelCard state={{ kind: "error", error: new Error("boom") }}>
        c
      </PanelCard>,
    );
    expect(screen.getByText("加载失败")).toBeTruthy();
  });

  it("state=inlineLoading renders the labelled Kumo loader", () => {
    wrap(
      <PanelCard
        title="t"
        state={{ kind: "inlineLoading", label: "正在加载" }}
      >
        c
      </PanelCard>,
    );
    expect(screen.getByLabelText("正在加载")).toBeTruthy();
  });
});
