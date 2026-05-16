/**
 * @vitest-environment happy-dom
 *
 * Unit tests for admin UI components:
 *   - AdminStatusHeader (section 1)
 *   - AccountCell (section 4.1)
 *   - TopModelsPanel (section 3.3)
 *   - AdminAuditFeed empty state (section 6.1)
 *   - AdminTeamsTable ModelChips overflow (section 4.3)
 */
import React from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { axe } from "vitest-axe";
import { toHaveNoViolations } from "vitest-axe/matchers";

beforeAll(() => {
  expect.extend({ toHaveNoViolations });
});

async function expectNoAxe(container: HTMLElement) {
  const results = await axe(container);
  expect(results).toHaveNoViolations();
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@cloudflare/kumo/components/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("@cloudflare/kumo/components/chart", async () => {
  const ReactModule = await import("react");
  return {
    ChartPalette: { categorical: () => "#4290F0" },
    TimeseriesChart: ({ ariaDescription }: { ariaDescription?: string }) =>
      ReactModule.createElement("div", { "data-testid": "kumo-timeseries-chart", role: "img", "aria-label": ariaDescription }),
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete window.__PORTAL_CONFIG;
});

// ---------------------------------------------------------------------------
// AdminStatusHeader
// ---------------------------------------------------------------------------

import { AdminStatusHeader, AccountCell, TopModelsPanel, AdminAuditFeed, AdminTeamsTable } from "./admin-components";
import type { UsageTimeseries } from "./chart";

describe("AdminStatusHeader", () => {
  it("shows success summary when all clear", async () => {
    const summary = {
      riskCount: 0,
      overBudgetTeamCount: 0,
      overBudgetUserCount: 0,
      unmanagedRoleCount: 0,
      noTeamUserCount: 0,
      limited: false,
    };
    const { container } = render(<AdminStatusHeader summary={summary} />);
    expect(screen.getByText("系统正常")).not.toBeNull();
    expect(screen.getByText("只读")).not.toBeNull();
    expect(screen.getByText("仅管理员可见")).not.toBeNull();
    await expectNoAxe(container);
  });

  it("shows warning summary when over-budget teams exist", () => {
    const summary = {
      riskCount: 3,
      overBudgetTeamCount: 2,
      overBudgetUserCount: 1,
      unmanagedRoleCount: 0,
      noTeamUserCount: 0,
      limited: false,
    };
    render(<AdminStatusHeader summary={summary} />);
    expect(screen.getByText(/2 个团队超预算/)).not.toBeNull();
    expect(screen.getByText(/1 个用户超预算/)).not.toBeNull();
  });

  it("shows warning summary with unmanaged roles when risk but no over-budget", () => {
    const summary = {
      riskCount: 5,
      overBudgetTeamCount: 0,
      overBudgetUserCount: 0,
      unmanagedRoleCount: 3,
      noTeamUserCount: 2,
      limited: false,
    };
    render(<AdminStatusHeader summary={summary} />);
    expect(screen.getByText(/3 个未映射角色/)).not.toBeNull();
    expect(screen.getByText(/2 个用户未关联团队/)).not.toBeNull();
  });

  it("shows sample-view badge when limited=true", () => {
    const summary = { limited: true, riskCount: 0 };
    render(<AdminStatusHeader summary={summary} />);
    expect(screen.getByText("样本视图")).not.toBeNull();
  });

  it("shows read-only badge always", async () => {
    const { container } = render(<AdminStatusHeader summary={{}} />);
    expect(screen.getByText("只读")).not.toBeNull();
    await expectNoAxe(container);
  });

  it("shows skeleton when loading", () => {
    render(<AdminStatusHeader summary={{}} loading />);
    // Loading state: no health message rendered
    expect(screen.queryByText("系统正常")).toBeNull();
    // Badges should still be visible
    expect(screen.getByText("只读")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AccountCell
// ---------------------------------------------------------------------------

describe("AccountCell", () => {
  it("shows email as primary when email is present", async () => {
    const { container } = render(<AccountCell email="alice@example.com" userId="uid-123" />);
    expect(screen.getByText("alice@example.com")).not.toBeNull();
    // userId shown as secondary
    expect(screen.getByText("uid-123")).not.toBeNull();
    await expectNoAxe(container);
  });

  it("shows userId with no-email badge when email is missing", async () => {
    const { container } = render(<AccountCell email={null} userId="uid-456" />);
    expect(screen.getByText("uid-456")).not.toBeNull();
    expect(screen.getByText("无邮箱")).not.toBeNull();
    await expectNoAxe(container);
  });

  it("shows empty string email as missing", () => {
    render(<AccountCell email="" userId="uid-789" />);
    expect(screen.getByText("uid-789")).not.toBeNull();
    expect(screen.getByText("无邮箱")).not.toBeNull();
  });

  it("shows (unknown) when both email and userId are absent", async () => {
    const { container } = render(<AccountCell email={null} userId={null} />);
    expect(screen.getByText("(unknown)")).not.toBeNull();
    expect(screen.queryByText("无邮箱")).toBeNull();
    await expectNoAxe(container);
  });

  it("does not render — for missing email (spec requirement)", () => {
    render(<AccountCell email={null} userId={null} />);
    expect(screen.queryByText("—")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TopModelsPanel
// ---------------------------------------------------------------------------

const topModelsData: UsageTimeseries = {
  available: true,
  grain: "day",
  window: "30d",
  windowLabel: "近 30 天",
  start: "2024-01-01T00:00:00.000Z",
  end: "2024-01-30T23:59:59.999Z",
  source: "user_daily_activity",
  timezone: "Asia/Shanghai",
  limited: false,
  maxPages: null,
  buckets: [],
  totals: { totalTokens: 0, promptTokens: 0, completionTokens: 0, requests: 0, spend: 0 },
  topModels: [
    { model: "gpt-4o", spend: 6.0, totalTokens: 6000, requests: 60 },
    { model: "gpt-4o-mini", spend: 3.0, totalTokens: 3000, requests: 30 },
    { model: "deepseek-v3", spend: 1.0, totalTokens: 1000, requests: 10 },
  ],
};

describe("TopModelsPanel", () => {
  it("renders rank badges, share, and spend for each model", async () => {
    const { container } = render(<TopModelsPanel data={topModelsData} loading={false} />);
    // Rank badges
    expect(screen.getByText("#1")).not.toBeNull();
    expect(screen.getByText("#2")).not.toBeNull();
    expect(screen.getByText("#3")).not.toBeNull();
    // Model names
    expect(screen.getByText("gpt-4o")).not.toBeNull();
    expect(screen.getByText("gpt-4o-mini")).not.toBeNull();
    // Share: gpt-4o has 60% of 10 total spend
    expect(screen.getByText(/60\.0%/)).not.toBeNull();
    await expectNoAxe(container);
  });

  it("shows empty state when no models", () => {
    const emptyData = { ...topModelsData, topModels: [] };
    render(<TopModelsPanel data={emptyData} loading={false} />);
    expect(screen.getByText("暂无模型用量拆分。")).not.toBeNull();
  });

  it("shows loading skeleton when loading=true", () => {
    render(<TopModelsPanel data={null} loading />);
    // No model names or ranks shown
    expect(screen.queryByText("#1")).toBeNull();
    expect(screen.queryByText("gpt-4o")).toBeNull();
  });

  it("shows empty state when data is null and not loading", () => {
    render(<TopModelsPanel data={null} loading={false} />);
    expect(screen.getByText("暂无模型用量拆分。")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AdminAuditFeed — empty state
// ---------------------------------------------------------------------------

describe("AdminAuditFeed — empty state", () => {
  it("shows explanatory copy instead of bare 暂无审计日志", async () => {
    globalThis.fetch = vi.fn(async () => Response.json({
      events: [],
      totalCount: 0,
      page: 1,
      size: 50,
    })) as typeof fetch;

    const { container } = render(<AdminAuditFeed />);

    await waitFor(() => {
      // Must include the explanatory sentence
      expect(screen.queryByText(/admin 写操作开启后此处会出现条目/)).not.toBeNull();
    });

    // The standalone "暂无审计日志" string may be used as title but NOT as sole content
    // The description must also be present
    expect(screen.queryByText(/admin 写操作开启后此处会出现条目/)).not.toBeNull();
    await expectNoAxe(container);
  });
});

// ---------------------------------------------------------------------------
// AdminTeamsTable — ModelChips overflow
// ---------------------------------------------------------------------------

describe("AdminTeamsTable — model chips overflow", () => {
  it("shows +N badge when team has more than 3 models", async () => {
    globalThis.fetch = vi.fn(async () => Response.json({
      teams: [{
        id: "team-1",
        alias: "Platform",
        models: ["gpt-4o", "gpt-4o-mini", "deepseek-v3", "claude-3-5-sonnet", "llama-3"],
        spend: 5,
        tpmLimit: null,
        rpmLimit: null,
      }],
    })) as typeof fetch;

    const { container } = render(<AdminTeamsTable />);

    await waitFor(() => {
      expect(screen.queryByText("gpt-4o")).not.toBeNull();
      expect(screen.queryByText("gpt-4o-mini")).not.toBeNull();
      expect(screen.queryByText("deepseek-v3")).not.toBeNull();
      // Overflow badge shows "+2 更多"
      expect(screen.queryByText("+2 更多")).not.toBeNull();
      // Overflow models NOT shown as visible chips
      expect(screen.queryByText("claude-3-5-sonnet")).toBeNull();
      expect(screen.queryByText("llama-3")).toBeNull();
    });
    await expectNoAxe(container);
  });

  it("shows all models as chips when count <= 3", async () => {
    globalThis.fetch = vi.fn(async () => Response.json({
      teams: [{
        id: "team-2",
        alias: "Small",
        models: ["gpt-4o", "deepseek-v3"],
        spend: 1,
        tpmLimit: null,
        rpmLimit: null,
      }],
    })) as typeof fetch;

    render(<AdminTeamsTable />);

    await waitFor(() => {
      expect(screen.queryByText("gpt-4o")).not.toBeNull();
      expect(screen.queryByText("deepseek-v3")).not.toBeNull();
      expect(screen.queryByText(/\+\d+ 更多/)).toBeNull();
    });
  });
});
