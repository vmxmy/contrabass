/**
 * @vitest-environment happy-dom
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

// Mock the tenant-portal hooks — test behavior, not network.
// importOriginal so TENANT_WEBHOOK_QUERY_KEY etc. pass through.
vi.mock("../hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hooks")>();
  return {
    ...actual,
    useTenantWebhook: vi.fn(),
  };
});

import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setupI18n } from "../../i18n/setup";
import { ME_QUERY_KEY } from "../../hooks/use-me";
import { DASHBOARD_QUERY_KEY } from "../../hooks/use-dashboard";
import { TENANT_WEBHOOK_QUERY_KEY } from "../hooks";
import { useTenantWebhook } from "../hooks";
import type { Me, Dashboard, TeamAlertWebhookResult } from "../../schemas";
import { TenantOverviewScreen } from "./overview";

const i18n = setupI18n("zh-CN");

const mockedUseTenantWebhook = vi.mocked(useTenantWebhook);

const sampleWebhookConfigured: TeamAlertWebhookResult = {
  teamId: "team-1",
  url: "https://hooks.example.com/notify",
  updatedAt: "2024-06-01T12:00:00Z",
};

const sampleWebhookEmpty: TeamAlertWebhookResult = {
  teamId: "team-1",
  url: null,
  updatedAt: null,
};

const sampleDashboard: Dashboard = {
  me: { email: "admin@example.com" },
  user: { litellmUserId: "u-admin-1", totalSpend: 42.5, maxBudget: 200 },
  summary: {
    recentSpend: 10.0,
    keyBudget: null,
    availableModelCount: 5,
    keyCount: 3,
    teamCount: 1,
    totalTokens: 12345,
    requestCount: 88,
  },
  models: { models: ["gpt-4", "gpt-3.5-turbo"], source: "team" },
  teams: [
    {
      id: "team-1",
      alias: "Acme Team",
      models: ["gpt-4"],
      spend: 42.5,
      maxBudget: 200,
      tpmLimit: null,
      rpmLimit: null,
    },
  ],
  keys: {
    totalCount: 3,
    items: [
      {
        id: "key-1",
        alias: "prod-key",
        displayKey: "sk-lit...abc",
        models: [],
        spend: 5,
        maxBudget: 50,
        expiresAt: null,
      },
    ],
  },
  usage: { available: true },
};

function renderWithProviders(
  ui: React.ReactElement,
  me?: Partial<Me>,
  dashboard?: Partial<Dashboard>,
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const meData: Me = {
    email: "admin@example.com",
    userId: "u-admin-1",
    company: "Acme Corp",
    domain: "example.com",
    role: "user",
    tenantRole: "tenant_admin",
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

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("TenantOverviewScreen — tenant_admin with configured webhook", () => {
  beforeEach(() => {
    mockedUseTenantWebhook.mockReturnValue({
      data: sampleWebhookConfigured,
      isLoading: false,
      isError: false,
      error: null,
    } as ReturnType<typeof useTenantWebhook>);
  });

  it("renders the overview root container", () => {
    renderWithProviders(<TenantOverviewScreen />, undefined, sampleDashboard);
    expect(document.querySelector("#tenant-overview-root")).not.toBeNull();
  });

  it("renders the team identity (company name) from seeded me data", () => {
    renderWithProviders(<TenantOverviewScreen />, undefined, sampleDashboard);
    // Brand/team name tile shows company
    expect(screen.queryByText(/Acme Corp/)).not.toBeNull();
  });

  it("renders this-cycle spend from seeded dashboard (BudgetBadge 正常 when <80%)", () => {
    renderWithProviders(<TenantOverviewScreen />, undefined, sampleDashboard);
    // spend=42.5, maxBudget=200 → ratio 0.2125 → tone=success
    // The spend meter tile must render spend value — queryAllByText handles multiple matches
    expect(screen.queryAllByText(/42/).length).toBeGreaterThan(0);
  });

  it("renders webhook status as configured when url is set", () => {
    renderWithProviders(<TenantOverviewScreen />, undefined, sampleDashboard);
    // Must show "已配置" or the configured URL or a positive indicator
    expect(
      screen.queryByText(/已配置|configured/i) ??
      screen.queryByText(/hooks\.example\.com/) ??
      document.querySelector("[data-webhook-status='configured']"),
    ).not.toBeNull();
  });

  it("renders top-models/recent activity tile with seeded model data", () => {
    renderWithProviders(<TenantOverviewScreen />, undefined, sampleDashboard);
    // Models from dashboard — at least one model or count visible
    expect(
      screen.queryByText(/gpt-4/i) ?? screen.queryByText(/模型|models/i),
    ).not.toBeNull();
  });
});

describe("TenantOverviewScreen — tenant_admin with unconfigured webhook", () => {
  beforeEach(() => {
    mockedUseTenantWebhook.mockReturnValue({
      data: sampleWebhookEmpty,
      isLoading: false,
      isError: false,
      error: null,
    } as ReturnType<typeof useTenantWebhook>);
  });

  it("renders webhook status as not configured when url is null", () => {
    renderWithProviders(<TenantOverviewScreen />, undefined, sampleDashboard);
    // Must show "未配置" or empty state indicator
    expect(
      screen.queryByText(/未配置|not.*configured|no.*webhook/i) ??
      document.querySelector("[data-webhook-status='none']"),
    ).not.toBeNull();
  });
});

describe("TenantOverviewScreen — member variant (adminOnly:false)", () => {
  beforeEach(() => {
    mockedUseTenantWebhook.mockReturnValue({
      data: sampleWebhookConfigured,
      isLoading: false,
      isError: false,
      error: null,
    } as ReturnType<typeof useTenantWebhook>);
  });

  it("does NOT render the webhook status tile for a member", () => {
    renderWithProviders(
      <TenantOverviewScreen />,
      { tenantRole: "member", tenantTeamId: "team-1" },
      sampleDashboard,
    );
    // Webhook status tile (team-only) must be absent
    expect(document.querySelector("#tenant-overview-webhook-tile")).toBeNull();
  });

  it("renders the personal spend/keys tile for a member", () => {
    renderWithProviders(
      <TenantOverviewScreen />,
      { tenantRole: "member", tenantTeamId: "team-1" },
      sampleDashboard,
    );
    // Personal spend tile must be present for all roles
    expect(document.querySelector("#tenant-overview-root")).not.toBeNull();
    // Personal spend is seeded: totalSpend=42.5 → shows value
    expect(screen.queryAllByText(/42/).length).toBeGreaterThan(0);
  });

  it("does NOT render the team budget ring tile for a member", () => {
    renderWithProviders(
      <TenantOverviewScreen />,
      { tenantRole: "member", tenantTeamId: "team-1" },
      sampleDashboard,
    );
    // Team budget tile is hidden for members
    expect(document.querySelector("#tenant-overview-team-budget-tile")).toBeNull();
  });
});

// Regression: TENANT_WEBHOOK_QUERY_KEY is importable
describe("hooks contract", () => {
  it("TENANT_WEBHOOK_QUERY_KEY is exported from hooks", () => {
    expect(TENANT_WEBHOOK_QUERY_KEY).toEqual(["tenant", "alert-webhook"]);
  });
});
