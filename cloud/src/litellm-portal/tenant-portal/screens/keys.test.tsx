/**
 * @vitest-environment happy-dom
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@cloudflare/kumo/components/toast", () => ({
  Toasty: ({ children }: { children: React.ReactNode }) => children,
  ToastProvider: ({ children }: { children: React.ReactNode }) => children,
  useKumoToastManager: () => ({
    toasts: [],
    add: vi.fn(),
    remove: vi.fn(),
    update: vi.fn(),
    promise: vi.fn(),
  }),
}));

vi.mock("@cloudflare/kumo/components/popover", async () => {
  const ReactModule = await import("react");
  const Popover = ({ children }: { children: React.ReactNode }) =>
    ReactModule.createElement("div", { "data-testid": "popover" }, children);
  Popover.Trigger = ({ render }: { render: React.ReactElement }) => render;
  Popover.Content = ({ children }: { children: React.ReactNode }) =>
    ReactModule.createElement("div", { "data-testid": "popover-content" }, children);
  Popover.Title = ({ children }: { children: React.ReactNode }) =>
    ReactModule.createElement("p", { className: "popover-title" }, children);
  Popover.Description = ({ children }: { children: React.ReactNode }) =>
    ReactModule.createElement("div", { className: "popover-description" }, children);
  Popover.Close = ({ children }: { children: React.ReactNode }) => children;
  return { Popover };
});
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setupI18n } from "../../i18n/setup";
import { ME_QUERY_KEY } from "../../hooks/use-me";
import { DASHBOARD_QUERY_KEY } from "../../hooks/use-dashboard";
import type { Me, Dashboard } from "../../schemas";
import { TenantKeysScreen } from "./keys";

const i18n = setupI18n("zh-CN");

function renderWithProviders(ui: React.ReactElement, me?: Partial<Me>, dashboard?: Partial<Dashboard>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const meData: Me = {
    email: "tenant@example.com",
    userId: "u-tenant-1",
    company: "Acme",
    domain: "example.com",
    role: "user",
    tenantRole: "member",
    tenantTeamId: "team-1",
    ...me,
  };
  qc.setQueryData<Me>(ME_QUERY_KEY, meData);
  if (dashboard !== undefined) {
    qc.setQueryData<Dashboard>(DASHBOARD_QUERY_KEY, dashboard as Dashboard);
  }
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider i18n={i18n}>{ui}</I18nProvider>
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe("TenantKeysScreen", () => {
  it("renders the API Keys card section heading", () => {
    renderWithProviders(
      <TenantKeysScreen />,
      undefined,
      {
        keys: {
          totalCount: 1,
          items: [
            {
              id: "key-1",
              alias: "my-tenant-key",
              displayKey: "sk-lit...abc",
              models: [],
              spend: 10,
              maxBudget: 100,
              expiresAt: null,
            },
          ],
        },
      },
    );
    expect(screen.queryByText("API Keys")).not.toBeNull();
  });

  it("renders the budget badge for a key with maxBudget set", () => {
    renderWithProviders(
      <TenantKeysScreen />,
      undefined,
      {
        keys: {
          totalCount: 1,
          items: [
            {
              id: "key-budget",
              alias: "budget-key",
              displayKey: "sk-lit...bgt",
              models: [],
              spend: 10,
              maxBudget: 100,
              expiresAt: null,
            },
          ],
        },
      },
    );
    // BudgetBadge renders "正常" when spend < 80% of maxBudget (ratio 0.10
    // here). Scoped to the pill <span class="...ml-2"> because ApiKeysCard
    // also renders "正常" in the budget-detail text — getByText is ambiguous.
    const badge = document.querySelector("span.ml-2");
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe("正常");
  });
});
