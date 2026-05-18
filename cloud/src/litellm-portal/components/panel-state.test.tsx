/**
 * @vitest-environment happy-dom
 */
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { I18nProvider } from "@lingui/react";
import { setupI18n } from "../i18n/setup";
import { errorMessage, GENERIC_FALLBACK } from "../errors/error-messages";
import { PanelSkeleton, PanelEmpty, PanelError, PanelLoading } from "./panel-state";

const i18n = setupI18n("zh-CN");
const wrap = (ui: React.ReactElement) =>
  render(<I18nProvider i18n={i18n}>{ui}</I18nProvider>);
afterEach(cleanup);

describe("Panel state contracts (§A.2)", () => {
  it("PanelSkeleton renders exactly `lines` content rows + a title row", () => {
    const { container } = wrap(<PanelSkeleton lines={3} />);
    expect(container.querySelectorAll("[data-panel-skeleton-line]").length).toBe(3);
    expect(container.querySelector("[data-panel-skeleton-title]")).not.toBeNull();
  });

  it("PanelEmpty renders a required title, centered, with optional action", () => {
    wrap(<PanelEmpty title="暂无数据" action={<a href="/x">去配置</a>} />);
    expect(screen.getByText("暂无数据")).toBeTruthy();
    expect(screen.getByRole("link", { name: "去配置" })).toBeTruthy();
  });

  it("PanelError renders the title; non-catalog Error / non-Error → fallback", () => {
    // §F.3 hardening: a non-catalog raw Error message ("boom") is NOT echoed —
    // it resolves to the generic, never-leaking fallback (was previously a leak).
    wrap(<PanelError title="加载失败" error={new Error("boom")} />);
    expect(screen.getByText("加载失败")).toBeTruthy();
    expect(screen.queryByText(/boom/)).toBeNull();
    expect(screen.getByText(/网络请求失败/)).toBeTruthy();
    cleanup();
    wrap(<PanelError title="加载失败" error={"weird" as unknown} />);
    expect(screen.getByText(/网络请求失败/)).toBeTruthy();
  });

  it("PanelError never echoes a non-catalog raw Error message (§F.3 leak guard)", () => {
    wrap(<PanelError title="加载失败" error={new Error("Failed to fetch")} />);
    expect(screen.queryByText(/Failed to fetch/)).toBeNull();
    expect(screen.getByText(/网络请求失败/)).toBeTruthy();
  });

  it("PanelError still localizes a real catalog error-id (regression)", () => {
    // Post-T4d: a "real catalog error-id" is the Lingui defineMessage HASH
    // that errorMessage() now returns (NOT the zh sentence it used to). The
    // §F.3 boundary throws this hash via Error.message; PanelError must
    // resolve it through i18n to the humanized sentence (mirrors
    // error-messages.test.ts asserting i18n._(errorMessage(code))).
    const mappedId = errorMessage("billing_archive_unavailable");
    wrap(<PanelError title="加载失败" error={new Error(mappedId)} />);
    expect(i18n.messages[mappedId]).not.toBeUndefined();
    expect(
      screen.getByText(/账单归档服务暂不可用。请稍后重试；若持续请联系管理员。/),
    ).toBeTruthy();
    expect(screen.queryByText(new RegExp(mappedId))).toBeNull();
    cleanup();
    // The generic fallback id is likewise a real catalog id → localized.
    wrap(<PanelError title="加载失败" error={new Error(GENERIC_FALLBACK.id)} />);
    expect(
      screen.getByText(/操作未完成，请重试；若反复出现请联系管理员。/),
    ).toBeTruthy();
  });

  it("PanelLoading renders an inline Kumo loader with an accessible label", () => {
    wrap(<PanelLoading label="正在加载" />);
    expect(screen.getByLabelText("正在加载")).toBeTruthy();
  });
});
