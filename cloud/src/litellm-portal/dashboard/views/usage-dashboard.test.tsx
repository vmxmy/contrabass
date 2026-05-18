/**
 * @vitest-environment happy-dom
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@lingui/react";
import { setupI18n } from "../../i18n/setup";
import { UsageDashboard } from "./usage-dashboard";
import { ME_QUERY_KEY } from "../../hooks/use-me";
import { PREFERENCES_QUERY_KEY } from "../../hooks/use-preferences";
import type { Me, UserPreferences } from "../../schemas";

const i18n = setupI18n("zh-CN");

const preferences: UserPreferences = {
  theme: "auto",
  defaultTab: "user",
  defaultUsageWindow: "30d",
  language: "auto",
  density: "comfortable",
  notifications: {
    budgetThresholdEnabled: true,
    budgetThreshold: 0.8,
    keyExpirySoon: true,
    keyCreation: true,
  },
};

const meUser: Me = {
  email: "user@example.com",
  userId: "user@example.com",
  company: "Acme",
  domain: "example.com",
  role: "user",
};

const meAdmin: Me = { ...meUser, role: "admin" };

const SELF = {
  available: true,
  empty: false,
  scope: "self",
  window: "30d",
  grain: "day",
  grainFallback: false,
  timezone: "Asia/Shanghai",
  kpi: {
    spend: { current: 45.2, previous: 40, deltaPct: 13 },
    requests: { current: 312, previous: null, deltaPct: null },
    totalTokens: { current: 1000, previous: 900, deltaPct: 11 },
  },
  trend: [{ startMs: 1, label: "05-01", totalTokens: 10, requests: 2, spend: 1 }],
  models: [{ model: "gpt", spend: 1, totalTokens: 10, requests: 2 }],
};

const GLOBAL = {
  available: true,
  empty: false,
  scope: "global",
  window: "30d",
  grain: "day",
  grainFallback: false,
  timezone: "Asia/Shanghai",
  kpi: {
    spend: { current: 128.5, previous: 110, deltaPct: 16 },
    requests: { current: 1247, previous: 1000, deltaPct: 24 },
    totalTokens: { current: 5000, previous: 4000, deltaPct: 25 },
  },
  trend: [{ startMs: 1, label: "05-01", totalTokens: 10, requests: 2, spend: 1 }],
  models: [{ model: "gpt", spend: 1, totalTokens: 10, requests: 2 }],
  perUser: [{ userId: "u1", points: [{ startMs: 1, spend: 5 }] }],
  summary: { userCount: 10, adminCount: 2, teamCount: 3, totalSpend: 128.5, totalBudget: 300, riskCount: 1, sampled: false },
};

function wrap(ui: React.ReactElement, me: Me = meAdmin, prefs: UserPreferences = preferences) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(ME_QUERY_KEY, me);
  qc.setQueryData(PREFERENCES_QUERY_KEY, prefs);
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider i18n={i18n}>{ui}</I18nProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("UsageDashboard", () => {
  it("renders self usage by default", async () => {
    globalThis.fetch = vi.fn(async () => Response.json(SELF)) as typeof fetch;

    const { getByText } = wrap(<UsageDashboard />);

    await waitFor(() => expect(getByText("$45.20")).toBeTruthy());
    expect(getByText("Token 消耗趋势")).toBeTruthy();
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/usage/overview?window=30d", {
      headers: { "content-type": "application/json" },
    });
  });

  it("only shows the global scope switch for admins", async () => {
    globalThis.fetch = vi.fn(async () => Response.json(SELF)) as typeof fetch;

    const admin = wrap(<UsageDashboard />, meAdmin);
    await waitFor(() => expect(admin.getByText("个人")).toBeTruthy());
    expect(admin.getByText("全局")).toBeTruthy();
    admin.unmount();

    const user = wrap(<UsageDashboard />, meUser);
    await waitFor(() => expect(user.getByText("$45.20")).toBeTruthy());
    expect(user.queryByText("全局")).toBeNull();
  });

  it("passes a non-empty localized aria-label into the rendered TrendChart (§A.1)", async () => {
    globalThis.fetch = vi.fn(async () => Response.json(SELF)) as typeof fetch;

    const { container, getByText } = wrap(<UsageDashboard />, meUser);

    await waitFor(() => expect(getByText("$45.20")).toBeTruthy());
    const chart = container.querySelector('[data-chart="trend"]') as HTMLElement;
    expect(chart).not.toBeNull();
    expect(chart.getAttribute("role")).toBe("img");
    const label = chart.getAttribute("aria-label") ?? "";
    expect(label.length).toBeGreaterThan(0);
    expect(label).toContain("30d");
    expect(label).toContain("day");
  });

  it("switches admins to global panels", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes("/api/admin/users")) {
        return Response.json({
          users: [{ userId: "u1", email: "u1@example.com", spend: 5, maxBudget: 10, teamIds: [], role: "internal_user" }],
          totalCount: 1,
          page: 1,
          size: 50,
        });
      }
      if (url.includes("/api/admin/usage/overview")) return Response.json(GLOBAL);
      return Response.json(SELF);
    }) as typeof fetch;

    const { getByText } = wrap(<UsageDashboard />);

    await waitFor(() => expect(getByText("个人")).toBeTruthy());
    fireEvent.click(getByText("全局"));

    await waitFor(() => expect(getByText("团队消费趋势")).toBeTruthy());
    expect(getByText("告警面板")).toBeTruthy();
    expect(getByText("用户消费排行")).toBeTruthy();
    expect(getByText("用户明细")).toBeTruthy();
  });
});
