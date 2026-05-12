/**
 * @vitest-environment happy-dom
 */
import React from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { axe } from "vitest-axe";
import { toHaveNoViolations } from "vitest-axe/matchers";
import { I18nProvider } from "@lingui/react";
import { setupI18n } from "../../i18n/setup";

beforeAll(() => {
  expect.extend({ toHaveNoViolations });
});

const i18n = setupI18n("zh-CN");
const storage = new Map<string, string>();
Object.defineProperty(window, "localStorage", {
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
    clear: () => storage.clear(),
  },
  configurable: true,
});
let currentPath = "/admin/users";

vi.mock("@tanstack/react-router", () => ({
  Outlet: () => <div data-testid="outlet" />,
  useMatchRoute: () => ({ to }: { to: string; fuzzy?: boolean }) => currentPath.startsWith(to),
}));

vi.mock("../../hooks/use-admin-audit", () => ({
  useAdminAudit: () => ({
    data: {
      events: [
        { id: "event-1", createdAt: new Date().toISOString() },
        { id: "event-2", createdAt: "2020-01-01T00:00:00.000Z" },
      ],
    },
  }),
}));

type SidebarContextValue = { open: boolean; setOpen: (open: boolean) => void };
const SidebarContext = React.createContext<SidebarContextValue | null>(null);

vi.mock("@cloudflare/kumo/components/sidebar", () => {
  const SidebarRoot = ({ children, ...props }: React.PropsWithChildren<React.HTMLAttributes<HTMLElement>>) => <aside {...props}>{children}</aside>;
  const Sidebar = Object.assign(SidebarRoot, {
    Provider: ({ open, onOpenChange, children }: React.PropsWithChildren<{ open: boolean; onOpenChange: (open: boolean) => void }>) => (
      <SidebarContext.Provider value={{ open, setOpen: onOpenChange }}>
        <div data-state={open ? "expanded" : "collapsed"}>{children}</div>
      </SidebarContext.Provider>
    ),
    Header: ({ children }: React.PropsWithChildren) => <header>{children}</header>,
    Content: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
    Group: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
    GroupLabel: ({ children }: React.PropsWithChildren) => <p>{children}</p>,
    Menu: ({ children }: React.PropsWithChildren) => <ul>{children}</ul>,
    MenuItem: ({ children }: React.PropsWithChildren) => <li>{children}</li>,
    MenuButton: ({ active, href, children }: React.PropsWithChildren<{ active?: boolean; href?: string }>) => (
      <a href={href} aria-current={active ? "page" : undefined}>{children}</a>
    ),
    MenuBadge: ({ children, ...props }: React.PropsWithChildren<React.HTMLAttributes<HTMLSpanElement>>) => <span {...props}>{children}</span>,
    Footer: ({ children }: React.PropsWithChildren) => <footer>{children}</footer>,
    Trigger: ({ "aria-label": ariaLabel }: { "aria-label"?: string }) => {
      const context = React.useContext(SidebarContext);
      return <button type="button" aria-label={ariaLabel} onClick={() => context?.setOpen(!context.open)} />;
    },
    Rail: ({ "aria-label": ariaLabel }: { "aria-label"?: string }) => <button type="button" aria-label={ariaLabel} />,
  });
  return { Sidebar };
});

vi.mock("@cloudflare/kumo/components/breadcrumbs", () => {
  const Breadcrumbs = Object.assign(
    ({ children, ...props }: React.PropsWithChildren<React.HTMLAttributes<HTMLElement>>) => <nav {...props}>{children}</nav>,
    {
      Link: ({ href, children }: React.PropsWithChildren<{ href: string }>) => <a href={href}>{children}</a>,
      Current: ({ children }: React.PropsWithChildren) => <span aria-current="page">{children}</span>,
      Separator: () => <span aria-hidden="true">/</span>,
    },
  );
  return { Breadcrumbs };
});

async function expectNoAxe(container: HTMLElement) {
  const results = await axe(container);
  expect(results).toHaveNoViolations();
}

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nProvider i18n={i18n}>{ui}</I18nProvider>);
}

describe("AdminSidebar", () => {
  beforeEach(() => {
    cleanup();
    storage.clear();
    currentPath = "/admin/users";
  });

  it("persists collapsed state and highlights the active route", async () => {
    window.localStorage.setItem(adminSidebarStorageKey, "false");
    const { container } = renderWithI18n(<AdminSidebar />);

    expect(screen.getByLabelText("展开管理员导航")).toBeTruthy();
    expect(screen.getByText("用户").closest("a")?.getAttribute("aria-current")).toBe("page");
    expect(screen.getByLabelText("今日新增 1 条")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("展开管理员导航"));
    expect(window.localStorage.getItem(adminSidebarStorageKey)).toBe("true");
    expect(screen.getByLabelText("折叠管理员导航")).toBeTruthy();
    await expectNoAxe(container);
  });
});

describe("AdminBreadcrumbs", () => {
  beforeEach(() => cleanup());

  it("renders clickable ancestors and current resource", async () => {
    const { container } = renderWithI18n(
      <AdminBreadcrumbs segments={[{ label: "用户", href: "/admin/users" }, { label: "laoxu@example.com" }]} />,
    );

    expect(screen.getByRole("link", { name: "管理员" }).getAttribute("href")).toBe("/admin");
    expect(screen.getByRole("link", { name: "用户" }).getAttribute("href")).toBe("/admin/users");
    expect(screen.getByText("laoxu@example.com").getAttribute("aria-current")).toBe("page");
    await expectNoAxe(container);
  });
});

import { AdminBreadcrumbs, AdminSidebar, adminSidebarStorageKey } from "./navigation";
