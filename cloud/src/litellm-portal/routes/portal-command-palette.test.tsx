/**
 * @vitest-environment happy-dom
 */
import React from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { axe } from "vitest-axe";
import { toHaveNoViolations } from "vitest-axe/matchers";
import { I18nProvider } from "@lingui/react";
import { setupI18n } from "../i18n/setup";

beforeAll(() => {
  expect.extend({ toHaveNoViolations });
});

const navigateSpy = vi.fn();
const i18n = setupI18n("zh-CN");

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ navigate: navigateSpy }),
}));

vi.mock("../hooks/use-admin-users", () => ({
  useAdminUsers: () => ({ data: { users: [{ userId: "u-1", email: "laoxu@example.com" }] } }),
}));

vi.mock("../hooks/use-admin-teams", () => ({
  useAdminTeams: () => ({ data: { teams: [{ id: "team-1", alias: "infra" }] } }),
}));

vi.mock("../hooks/use-admin-audit", () => ({
  useAdminAudit: () => ({
    data: {
      events: [{ id: "evt-1", action: "key.create", actorUserEmail: "ops@example.com", objectType: "key", objectId: "key-1" }],
    },
  }),
}));

type CommandItem = { id: string; title: string; description?: string };
type CommandGroup = { id: string; label: string; items: CommandItem[] };

vi.mock("@cloudflare/kumo/components/command-palette", () => {
  const ReactModule = require("react") as typeof React;
  const PaletteContext = ReactModule.createContext<{ groups: CommandGroup[]; setQuery: (value: string) => void }>({ groups: [], setQuery: () => {} });
  const GroupContext = ReactModule.createContext<CommandGroup | null>(null);

  const Root = ({ open, items, value, onValueChange, children }: React.PropsWithChildren<{ open: boolean; items: CommandGroup[]; value?: string; onValueChange?: (value: string) => void }>) => (
    open ? (
      <PaletteContext.Provider value={{ groups: items, setQuery: onValueChange ?? (() => {}) }}>
        <div role="dialog" aria-label="命令面板" data-value={value}>{children}</div>
      </PaletteContext.Provider>
    ) : null
  );
  const CommandPalette = {
    Root,
    Input: ({ placeholder }: { placeholder?: string }) => {
      const context = ReactModule.useContext(PaletteContext);
      return <input aria-label={placeholder} placeholder={placeholder} onChange={(event) => context.setQuery(event.currentTarget.value)} />;
    },
    List: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
    Results: ({ children }: { children: (group: CommandGroup) => React.ReactNode }) => {
      const context = ReactModule.useContext(PaletteContext);
      return <>{context.groups.map((group) => children(group))}</>;
    },
    Group: ({ items, children }: React.PropsWithChildren<{ items: CommandItem[] }>) => {
      const group = { id: "group", label: "group", items };
      return <GroupContext.Provider value={group}><section>{children}</section></GroupContext.Provider>;
    },
    GroupLabel: ({ children }: React.PropsWithChildren) => <h3>{children}</h3>,
    Items: ({ children }: { children: (item: CommandItem) => React.ReactNode }) => {
      const group = ReactModule.useContext(GroupContext);
      return <>{(group?.items ?? []).map((item) => children(item))}</>;
    },
    ResultItem: ({ title, description, onClick }: { title: string; description?: string; onClick: (event: React.MouseEvent) => void }) => (
      <button type="button" onClick={onClick}>{title}<span>{description}</span></button>
    ),
    Empty: ({ children }: React.PropsWithChildren) => <p>{children}</p>,
    Footer: ({ children }: React.PropsWithChildren) => <footer>{children}</footer>,
  };
  return { CommandPalette };
});


async function expectNoAxe(container: HTMLElement) {
  const results = await axe(container);
  expect(results).toHaveNoViolations();
}

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nProvider i18n={i18n}>{ui}</I18nProvider>);
}

describe("PortalCommandPalette", () => {
  beforeEach(() => {
    cleanup();
    navigateSpy.mockClear();
  });

  it("opens with Cmd/Ctrl+K and filters command groups", async () => {
    const { container } = renderWithI18n(<PortalCommandPalette />);

    expect(screen.queryByRole("dialog", { name: "命令面板" })).toBeNull();
    fireEvent.keyDown(window, { key: "k", metaKey: true });

    expect(screen.getByRole("dialog", { name: "命令面板" })).toBeTruthy();
    expect(screen.getByPlaceholderText("搜索用户、团队、审计事件或操作…")).toBeTruthy();
    expect(screen.getByText("laoxu@example.com")).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText("搜索用户、团队、审计事件或操作…"), { target: { value: "infra" } });
    expect(screen.getByText("infra")).toBeTruthy();
    expect(screen.queryByText("laoxu@example.com")).toBeNull();
    await expectNoAxe(container);
  });
});

import { PortalCommandPalette } from "./portal-command-palette";
