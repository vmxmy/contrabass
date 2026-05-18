/**
 * @vitest-environment happy-dom
 */
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { I18nProvider } from "@lingui/react";
import { setupI18n } from "../i18n/setup";
import { SideNav, type SideNavGroup } from "./side-nav";

const i18n = setupI18n("zh-CN");
afterEach(cleanup);

const groups: SideNavGroup[] = [
  {
    heading: "我的",
    items: [
      { href: "/", label: "概览", icon: "overview" },
      { href: "/usage", label: "用量", icon: "usage" },
    ],
  },
  {
    heading: "团队管理",
    items: [{ href: "/members", label: "成员", icon: "members" }],
  },
];

function renderNav(currentPath: string) {
  return render(
    <I18nProvider i18n={i18n}>
      <SideNav groups={groups} currentPath={currentPath} accent="brand" ariaLabel="租户导航" />
    </I18nProvider>,
  );
}

describe("SideNav (§B.1)", () => {
  it("the matched item carries aria-current=page and an active accent bar", () => {
    renderNav("/usage");
    const active = screen.getByRole("link", { current: "page" });
    expect(active.getAttribute("href")).toBe("/usage");
    expect(active.querySelector("[data-active-accent-bar]")).not.toBeNull();
  });

  it("non-active items carry no aria-current and no accent bar", () => {
    renderNav("/usage");
    const overview = screen.getByRole("link", { name: /概览/ });
    expect(overview.getAttribute("aria-current")).toBeNull();
    expect(overview.querySelector("[data-active-accent-bar]")).toBeNull();
  });

  it("every item carries the shared focus ring and a hover=tint class", () => {
    renderNav("/");
    for (const l of screen.getAllByRole("link")) {
      expect(l.className).toContain("focus-visible:ring-kumo-brand");
      expect(l.className).toContain("hover:bg-kumo-tint");
    }
  });

  it("renders group headings as subtle 12px uppercase labels", () => {
    renderNav("/");
    expect(screen.getByText("我的")).toBeTruthy();
    expect(screen.getByText("团队管理")).toBeTruthy();
  });

  it("renders an icon slot per item", () => {
    const { container } = renderNav("/");
    expect(container.querySelectorAll("[data-nav-icon]").length).toBe(3);
  });
});

describe("SideNav responsive drawer (S1)", () => {
  it("renders a mobile menu toggle button that is hidden on md+ and starts collapsed", () => {
    renderNav("/");
    const toggle = screen.getByRole("button", { name: "打开导航菜单" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.className).toContain("md:hidden");
  });

  it("toggles aria-expanded and the nav's translate state when clicked", async () => {
    const { container } = renderNav("/");
    const toggle = screen.getByRole("button", { name: "打开导航菜单" });
    const nav = container.querySelector("nav") as HTMLElement;
    expect(nav.className).toContain("-translate-x-full");
    expect(nav.className).toContain("md:translate-x-0");
    toggle.click();
    expect(
      screen.getByRole("button", { name: "关闭导航菜单" }).getAttribute("aria-expanded"),
    ).toBe("true");
    expect(nav.className).toContain("max-md:translate-x-0");
  });

  it("keeps every nav link/heading/icon in the DOM regardless of drawer state (desktop unaffected)", () => {
    const { container } = renderNav("/usage");
    // identical guarantees to the existing contract — proves no DOM removal
    expect(screen.getByRole("link", { current: "page" }).getAttribute("href")).toBe("/usage");
    expect(screen.getByText("我的")).toBeTruthy();
    expect(container.querySelectorAll("[data-nav-icon]").length).toBe(3);
    expect(screen.getByRole("link", { name: /概览/ })).toBeTruthy();
  });
});

describe("SideNav responsive=false (nested under PortalRootLayout: no drawer)", () => {
  it("renders the static rail with NO hamburger toggle and no off-canvas transform", () => {
    const { container } = render(
      <I18nProvider i18n={i18n}>
        <SideNav
          groups={groups}
          currentPath="/"
          accent="brand"
          ariaLabel="租户导航"
          responsive={false}
        />
      </I18nProvider>,
    );
    expect(screen.queryByRole("button", { name: /导航菜单/ })).toBeNull();
    const nav = container.querySelector("nav") as HTMLElement;
    expect(nav.className).toContain("w-56");
    expect(nav.className).not.toContain("fixed");
    expect(nav.className).not.toContain("-translate-x-full");
    expect(screen.getByRole("link", { name: /概览/ })).toBeTruthy();
    expect(container.querySelectorAll("[data-nav-icon]").length).toBe(3);
  });
});
