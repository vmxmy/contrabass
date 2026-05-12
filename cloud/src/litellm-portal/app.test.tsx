/**
 * @vitest-environment happy-dom
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const toastAddSpy = vi.fn();

vi.mock("@cloudflare/kumo/components/toast", () => ({
  Toasty: ({ children }: { children: React.ReactNode }) => children,
  ToastProvider: ({ children }: { children: React.ReactNode }) => children,
  useKumoToastManager: () => ({
    toasts: [],
    add: toastAddSpy,
    remove: vi.fn(),
    update: vi.fn(),
    promise: vi.fn(),
  }),
}));

vi.mock("@cloudflare/kumo/components/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("@cloudflare/kumo/components/dropdown", async () => {
  const ReactModule = await import("react");
  const DropdownMenu = ({ children }: { children: React.ReactNode }) =>
    ReactModule.createElement("div", { "data-testid": "dropdown-menu" }, children);
  DropdownMenu.Trigger = ({ children, "aria-label": ariaLabel }: { children: React.ReactNode; "aria-label"?: string }) =>
    ReactModule.createElement("div", { role: "button", "aria-label": ariaLabel }, children);
  DropdownMenu.Content = ({ children }: { children: React.ReactNode }) =>
    ReactModule.createElement("div", { role: "menu" }, children);
  DropdownMenu.Item = ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) =>
    ReactModule.createElement("div", { role: "menuitem", onClick }, children);
  return { DropdownMenu };
});

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

vi.mock("@cloudflare/kumo/components/chart", async () => {
  const ReactModule = await import("react");
  return {
    ChartPalette: {
      categorical: () => "#4290F0",
    },
    TimeseriesChart: ({ data, onTimeRangeChange, ariaDescription }: any) =>
      ReactModule.createElement(
        "div",
        {
          "data-testid": "kumo-timeseries-chart",
          "data-series": JSON.stringify(data),
          role: "img",
          "aria-label": ariaDescription,
        },
        ReactModule.createElement(
          "button",
          {
            type: "button",
            onClick: () => onTimeRangeChange?.(
              Date.parse("2024-01-01T00:00:00.000Z"),
              Date.parse("2024-01-08T00:00:00.000Z"),
            ),
          },
          "模拟图表范围",
        ),
      ),
  };
});

import { AdminSection, ApiKeysCard, CreateKeyButton, HeroStats, ModelAccessCard, PortalErrorBanner, PortalTabs, readTabFromHash, UsagePanel } from "./app";
import { UsageChart, type UsageTimeseries } from "./chart";

const originalFetch = globalThis.fetch;

const usageData: UsageTimeseries = {
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
  buckets: [
    { start: "2024-01-01T00:00:00.000Z", end: "2024-01-02T00:00:00.000Z", label: "01-01", totalTokens: 1000, promptTokens: 400, completionTokens: 600, requests: 10, spend: 0.5 },
    { start: "2024-01-02T00:00:00.000Z", end: "2024-01-03T00:00:00.000Z", label: "01-02", totalTokens: 2000, promptTokens: 800, completionTokens: 1200, requests: 20, spend: 1.0 },
  ],
  totals: { totalTokens: 3000, promptTokens: 1200, completionTokens: 1800, requests: 30, spend: 1.5 },
  topModels: [{ model: "gpt-4o-mini", spend: 1.5, totalTokens: 3000, requests: 30 }],
};

function installPortalConfig() {
  window.__PORTAL_CONFIG = {
    usageWindows: {
      minute: [
        { key: "6h", label: "近 6 小时" },
        { key: "24h", label: "近 24 小时" },
      ],
      hour: [
        { key: "24h", label: "近 24 小时" },
        { key: "48h", label: "近 48 小时" },
        { key: "7d", label: "近 7 天" },
      ],
      day: [
        { key: "7d", label: "近 7 天" },
        { key: "30d", label: "近 30 天" },
      ],
      month: [{ key: "12mo", label: "近 12 个月" }],
    },
    defaultUsageWindows: { minute: "6h", hour: "48h", day: "30d", month: "12mo" },
  };
}

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  toastAddSpy.mockClear();
  delete window.__PORTAL_CONFIG;
});

describe("PortalTabs", () => {
  it("uses persona-oriented labels", () => {
    render(<PortalTabs tab="user" onSelect={() => {}} />);
    expect(screen.queryByText("个人视图")).not.toBeNull();
    expect(screen.queryByText("全局管理")).not.toBeNull();
  });

  it("keeps admins on personal view unless #admin is explicit", () => {
    window.history.replaceState(null, "", "/");
    expect(readTabFromHash("admin")).toBe("user");
    window.history.replaceState(null, "", "/#admin");
    expect(readTabFromHash("admin")).toBe("admin");
    window.history.replaceState(null, "", "/#user");
    expect(readTabFromHash("admin")).toBe("user");
  });
});

describe("ModelAccessCard", () => {
  it("expands by default when model count is <= 12", () => {
    render(<ModelAccessCard initialData={{ models: { models: ["gpt-4o", "gpt-4o-mini", "claude-3-5-sonnet"], source: "team" } }} />);
    expect(screen.queryByText("团队可用模型")).not.toBeNull();
    expect(screen.queryByText("gpt-4o")).not.toBeNull();
  });

  it("collapses by default and shows trigger when model count exceeds 12", () => {
    const models = Array.from({ length: 15 }, (_, i) => `model-${i + 1}`);
    render(<ModelAccessCard initialData={{ models: { models, source: "team" } }} />);
    expect(screen.queryByText("团队可用模型")).not.toBeNull();
    expect(screen.queryByText("model-13")).toBeNull();
    expect(screen.queryByText(/展开全部 15 个模型/)).not.toBeNull();
  });

  it("renders initial model list from initialData prop", () => {
    render(<ModelAccessCard initialData={{ models: { models: ["gpt-4o", "deepseek-v3"], source: "configured" } }} />);
    expect(screen.queryByText("gpt-4o")).not.toBeNull();
    expect(screen.queryByText("deepseek-v3")).not.toBeNull();
  });
});

describe("UsageChart", () => {
  it("shows Kumo loader when loading", () => {
    render(<UsageChart data={null} loading />);
    expect(screen.queryByLabelText("正在加载用量图表")).not.toBeNull();
  });

  it("renders chart when usage data is provided", async () => {
    render(<UsageChart data={usageData} />);
    await waitFor(() => {
      expect(screen.queryByTestId("kumo-timeseries-chart")).not.toBeNull();
      expect(screen.queryByText(/峰值/)).not.toBeNull();
    });
    expect(screen.getByTestId("kumo-timeseries-chart").getAttribute("data-series")).toContain("1704067200000");
  });

  it("shows error when error prop is provided", () => {
    render(<UsageChart data={null} error="加载失败" />);
    expect(screen.queryByText("加载失败")).not.toBeNull();
  });
});

describe("UsagePanel", () => {
  it("fetches default usage data and renders one-click time preset controls", async () => {
    installPortalConfig();
    const seen: string[] = [];
    globalThis.fetch = vi.fn(async (input) => {
      seen.push(String(input));
      return Response.json(usageData);
    }) as typeof fetch;

    render(<UsagePanel />);

    expect(screen.queryByRole("group", { name: "时间范围预设" })).not.toBeNull();
    expect(screen.queryByText("时间粒度")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "近 7 天" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "近 30 天" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "自动" })).not.toBeNull();
    expect(screen.queryByText("自动粒度：天")).not.toBeNull();
    await waitFor(() => {
      expect(screen.queryByText(/峰值/)).not.toBeNull();
    });
    expect(seen[0]).toContain("/api/usage/timeseries?grain=day&window=30d");
  });

  it("uses preset auto grain and allows one-click manual grain when valid", async () => {
    installPortalConfig();
    const seen: string[] = [];
    globalThis.fetch = vi.fn(async (input) => {
      seen.push(String(input));
      return Response.json(usageData);
    }) as typeof fetch;

    render(<UsagePanel />);

    await waitFor(() => {
      expect(seen[0]).toContain("grain=day&window=30d");
    });

    const hourButton = screen.getByRole("button", { name: "小时" }) as HTMLButtonElement;
    expect(hourButton.disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "近 7 天" }));
    await waitFor(() => {
      expect(seen.some((url) => url.includes("grain=day&window=7d"))).toBe(true);
    });

    await waitFor(() => {
      expect(hourButton.disabled).toBe(false);
    });
    fireEvent.click(hourButton);
    await waitFor(() => {
      expect(seen.some((url) => url.includes("grain=hour&window=7d"))).toBe(true);
      expect(screen.queryByText("手动粒度：小时")).not.toBeNull();
    });
  });

  it("falls back to auto grain when a manual grain does not support the selected preset", async () => {
    installPortalConfig();
    const seen: string[] = [];
    globalThis.fetch = vi.fn(async (input) => {
      seen.push(String(input));
      return Response.json(usageData);
    }) as typeof fetch;

    render(<UsagePanel />);

    fireEvent.click(screen.getByRole("button", { name: "近 7 天" }));
    const hourButton = screen.getByRole("button", { name: "小时" }) as HTMLButtonElement;
    await waitFor(() => {
      expect(hourButton.disabled).toBe(false);
    });
    fireEvent.click(hourButton);
    await waitFor(() => {
      expect(seen.some((url) => url.includes("grain=hour&window=7d"))).toBe(true);
    });

    fireEvent.click(screen.getByRole("button", { name: "近 30 天" }));
    await waitFor(() => {
      expect(seen.some((url) => url.includes("grain=day&window=30d"))).toBe(true);
      expect(screen.queryByText(/已切回 自动粒度：天/)).not.toBeNull();
    });
  });

  it("syncs Kumo chart native range selection to the nearest usage preset", async () => {
    installPortalConfig();
    const seen: string[] = [];
    globalThis.fetch = vi.fn(async (input) => {
      seen.push(String(input));
      return Response.json(usageData);
    }) as typeof fetch;

    render(<UsagePanel />);

    await waitFor(() => {
      expect(screen.queryByTestId("kumo-timeseries-chart")).not.toBeNull();
    });
    fireEvent.click(screen.getByText("模拟图表范围"));

    await waitFor(() => {
      expect(seen.some((url) => url.includes("grain=day&window=7d"))).toBe(true);
      expect(screen.queryByText(/已按图表选择切换到 近 7 天 · 自动粒度：天/)).not.toBeNull();
    });
  });

  it("renders semantic error state when usage fetch fails", async () => {
    installPortalConfig();
    globalThis.fetch = vi.fn(async () => Response.json({ error: "boom" }, { status: 502 })) as typeof fetch;

    render(<UsagePanel />);

    await waitFor(() => {
      expect(screen.queryByText("用量数据加载失败")).not.toBeNull();
      expect(screen.queryAllByText("boom").length).toBeGreaterThan(0);
    });
  });
});

describe("ApiKeysCard", () => {
  it("renders API keys with clipboard text and collapsible model detail", () => {
    render(<ApiKeysCard initialData={{ keys: { totalCount: 1, items: [
      {
        id: "key-1",
        alias: "primary",
        displayKey: "sk-lit...cret",
        models: ["gpt-4o", "gpt-4o-mini", "deepseek-v3", "text-embedding-3-small"],
        spend: 12.5,
        maxBudget: 20,
        expiresAt: "—",
      },
    ] } }} />);

    expect(screen.queryByText("API Keys")).not.toBeNull();
    expect(screen.queryByText("创建 Key")).not.toBeNull();
    expect(screen.queryByText("primary")).not.toBeNull();
    expect(screen.queryByText("sk-lit...cret")).not.toBeNull();
    expect(screen.queryByText(/展开全部/)).not.toBeNull();
  });

  it("renders model lists for multiple API keys", () => {
    render(<ApiKeysCard initialData={{ keys: { totalCount: 2, items: [
      {
        id: "key-1",
        alias: "team-inherited",
        displayKey: "sk-lit...one1",
        models: ["deepseek-v4-pro", "gpt-5.5"],
        spend: 1,
        maxBudget: 20,
        expiresAt: null,
      },
      {
        id: "key-2",
        alias: "explicit",
        displayKey: "sk-lit...one2",
        models: ["gpt-5.5"],
        spend: 2,
        maxBudget: 20,
        expiresAt: null,
      },
    ] } }} />);

    expect(screen.queryByText("team-inherited")).not.toBeNull();
    expect(screen.queryByText("explicit")).not.toBeNull();
    expect(screen.queryByText("deepseek-v4-pro")).not.toBeNull();
    expect(screen.queryAllByText("gpt-5.5").length).toBe(2);
  });

  it("renders initial keys from initialData prop", () => {
    render(<ApiKeysCard initialData={{ keys: { totalCount: 1, items: [
      { id: "k1", alias: "init-key", displayKey: "sk-lit...init", models: [], spend: 0, maxBudget: null, expiresAt: null },
    ] } }} />);
    expect(screen.queryByText("init-key")).not.toBeNull();
  });

  it("deletes an API key after confirmation", async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 204 })) as typeof fetch;

    render(<ApiKeysCard initialData={{ keys: { totalCount: 1, items: [
      {
        id: "key-1",
        alias: "primary",
        displayKey: "sk-lit...cret",
        models: ["gpt-5.5"],
        spend: 1,
        maxBudget: 20,
        expiresAt: null,
      },
    ] } }} />);
    fireEvent.click(screen.getByText("删除"));

    await waitFor(() => {
      expect(screen.queryByText("删除 API Key？")).not.toBeNull();
    });
    fireEvent.click(screen.getByText("确认删除"));

    await waitFor(() => {
      expect(screen.queryByText("primary")).toBeNull();
    });
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/keys/key-1", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
    });
  });
});

describe("PortalErrorBanner", () => {
  it("renders page errors from initialData prop", () => {
    render(<PortalErrorBanner initialData={{ error: "页面数据加载失败" }} />);
    expect(screen.queryByRole("alert")).not.toBeNull();
    expect(screen.queryAllByText("页面数据加载失败").length).toBeGreaterThan(0);
  });

  it("renders nothing when no error in initialData", () => {
    render(<PortalErrorBanner initialData={null} />);
    expect(screen.queryByRole("alert")).toBeNull();
  });

describe("CreateKeyButton", () => {
  it("renders create key trigger button", () => {
    render(<CreateKeyButton />);
    expect(screen.queryByText("创建 Key")).not.toBeNull();
  });

  it("shows validation error when submitting without alias", async () => {
    globalThis.fetch = vi.fn(async () => Response.json({ models: [] })) as typeof fetch;

    render(<CreateKeyButton />);
    const trigger = screen.getByText("创建 Key");
    fireEvent.click(trigger);

    await waitFor(() => {
      expect(screen.queryByText("创建新 API Key")).not.toBeNull();
    });

    const submitButtons = screen.getAllByText("创建");
    const submitBtn = submitButtons.find((el) => el.closest("button"));
    if (submitBtn) fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(screen.queryByText("请输入 Key 名称")).not.toBeNull();
    });
  });

  it("shows a precise duplicate-name error when key alias already exists", async () => {
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.includes("/api/models")) return Response.json({ models: [] });
      if (url.includes("/api/keys") && (init as RequestInit)?.method === "POST") {
        return Response.json({
          error: "key_alias_conflict",
          keyAlias: "test-key",
          message: "API Key name already exists",
        }, { status: 409 });
      }
      return Response.json({});
    }) as typeof fetch;

    render(<CreateKeyButton />);
    fireEvent.click(screen.getByText("创建 Key"));

    await waitFor(() => {
      expect(screen.queryByText("创建新 API Key")).not.toBeNull();
    });

    const aliasInput = document.getElementById("create-key-alias");
    if (aliasInput) {
      fireEvent.change(aliasInput, { target: { value: "test-key" } });
    }

    const submitButtons = screen.getAllByText("创建");
    const submitBtn = submitButtons.find((el) => el.closest("button"));
    if (submitBtn) fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(screen.queryByText("名称「test-key」已存在，请换一个名称。")).not.toBeNull();
    });
  });

  it("copies the newly created full key with Kumo ClipboardText", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.includes("/api/models")) return Response.json({ models: ["gpt-4o-mini"] });
      if (url.includes("/api/keys") && (init as RequestInit)?.method === "POST") {
        return Response.json({
          rawKey: "sk-new-key-123",
          keyAlias: "test-key",
          expires: null,
          keyId: "tok-new",
        }, { status: 201 });
      }
      return Response.json({});
    }) as typeof fetch;

    render(<CreateKeyButton />);
    fireEvent.click(screen.getByText("创建 Key"));

    await waitFor(() => {
      expect(screen.queryByText("创建新 API Key")).not.toBeNull();
    });

    const aliasInput = document.getElementById("create-key-alias");
    if (aliasInput) {
      fireEvent.change(aliasInput, { target: { value: "test-key" } });
    }

    const submitButtons = screen.getAllByText("创建");
    const submitBtn = submitButtons.find((el) => el.closest("button"));
    if (submitBtn) fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(screen.queryByText("Key 已创建")).not.toBeNull();
    });

    fireEvent.click(screen.getByRole("button", { name: "复制完整 Key" }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("sk-new-key-123");
    });
  });

  it("shows raw key after successful creation", async () => {
    const calls: { method?: string; url: string }[] = [];
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      calls.push({ method: (init as RequestInit)?.method, url });
      if (url.includes("/api/models")) return Response.json({ models: ["gpt-4o-mini"] });
      if (url.includes("/api/keys") && (init as RequestInit)?.method === "POST") {
        return Response.json({
          rawKey: "sk-new-key-123",
          keyAlias: "test-key",
          expires: null,
          keyId: "tok-new",
        }, { status: 201 });
      }
      return Response.json({});
    }) as typeof fetch;

    render(<CreateKeyButton />);
    const trigger = screen.getByText("创建 Key");
    fireEvent.click(trigger);

    await waitFor(() => {
      expect(screen.queryByText("创建新 API Key")).not.toBeNull();
    });

    const aliasInput = document.getElementById("create-key-alias");
    if (aliasInput) {
      fireEvent.change(aliasInput, { target: { value: "test-key" } });
    }

    const submitButtons = screen.getAllByText("创建");
    const submitBtn = submitButtons.find((el) => el.closest("button"));
    if (submitBtn) fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(screen.queryByText("sk-new-key-123")).not.toBeNull();
      expect(screen.queryByText("Key 已创建")).not.toBeNull();
    });
  });
});
});

describe("AdminSection", () => {
  it("AdminUsersTable renders email for each user row", async () => {
    // #given
    installPortalConfig();
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes("/api/admin/users")) {
        return Response.json({
          users: [
            { userId: "u1", email: "alice@gz-zhiyun.com", spend: 1.5, maxBudget: 100, teamIds: [], role: "internal_user" },
            { userId: "u2", email: "bob@gz-zhiyun.com", spend: 2.0, maxBudget: null, teamIds: ["t1"], role: "proxy_admin" },
          ],
          totalCount: 2,
          page: 1,
          size: 50,
        });
      }
      return Response.json({ teams: [], events: [], users: [], buckets: [], totals: {}, topModels: [] });
    }) as typeof fetch;

    // #when
    render(<AdminSection role="admin" />);

    // #then - both email addresses appear as table rows
    await waitFor(() => {
      expect(screen.queryByText("alice@gz-zhiyun.com")).not.toBeNull();
      expect(screen.queryByText("bob@gz-zhiyun.com")).not.toBeNull();
    });
  });

  it("AdminAuditFeed navigates to page 2 when next-page button is clicked", async () => {
    // #given
    installPortalConfig();
    const fetchCalls: string[] = [];
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      fetchCalls.push(url);
      if (url.includes("/api/admin/audit")) {
        const page = new URL(url, "https://portal.test").searchParams.get("page") ?? "1";
        return Response.json({
          events: [
            {
              id: `evt-${page}-1`,
              createdAt: "2026-05-10T10:00:00Z",
              action: "key.create",
              actorUserId: "admin-uid",
              actorUserEmail: "admin@gz-zhiyun.com",
              objectType: "key",
              objectId: `key-p${page}`,
            },
          ],
          totalCount: 100,
          page: Number(page),
          size: 50,
        });
      }
      return Response.json({ teams: [], users: [], buckets: [], totals: {}, topModels: [] });
    }) as typeof fetch;

    // #when
    render(<AdminSection role="admin" />);

    // wait for initial load
    await waitFor(() => {
      expect(screen.queryByText("key.create")).not.toBeNull();
    });

    const auditCallsBefore = fetchCalls.filter((u) => u.includes("/api/admin/audit")).length;

    // click next page button (kumo Pagination renders a button with aria-label)
    const nextButtons = screen.getAllByLabelText("下一页");
    // AdminAuditFeed is the last card; use the last next-page button
    fireEvent.click(nextButtons[nextButtons.length - 1]);

    // #then - a second audit fetch is made with page=2
    await waitFor(() => {
      const auditCallsAfter = fetchCalls.filter((u) => u.includes("/api/admin/audit"));
      expect(auditCallsAfter.length).toBeGreaterThan(auditCallsBefore);
      const page2Call = auditCallsAfter.find((u) => u.includes("page=2"));
      expect(page2Call).toBeDefined();
    });
  });

  it("AdminGlobalUsage switches to hour grain and includes grain=hour in fetch URL", async () => {
    // #given
    installPortalConfig();
    const fetchUrls: string[] = [];
    const globalUsageData = {
      available: true,
      grain: "hour",
      window: "48h",
      windowLabel: "近 48 小时",
      start: "2024-01-01T00:00:00.000Z",
      end: "2024-01-03T00:00:00.000Z",
      source: "spend_logs_v2_global",
      timezone: "Asia/Shanghai",
      limited: false,
      maxPages: null,
      buckets: [
        { start: "2024-01-01T00:00:00.000Z", end: "2024-01-02T00:00:00.000Z", label: "01-01", totalTokens: 120, promptTokens: 50, completionTokens: 70, requests: 3, spend: 0.2 },
      ],
      totals: { totalTokens: 120, promptTokens: 50, completionTokens: 70, requests: 3, spend: 0.2 },
      topModels: [],
    };
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      fetchUrls.push(url);
      if (url.includes("/api/admin/usage/timeseries")) {
        return Response.json(globalUsageData);
      }
      return Response.json({ teams: [], users: [], events: [], totalCount: 0, page: 1, size: 50, buckets: [], totals: {}, topModels: [] });
    }) as typeof fetch;

    // #when
    render(<AdminSection role="admin" />);

    // wait for initial render
    await waitFor(() => {
      expect(screen.queryByText("全局用量趋势")).not.toBeNull();
    });

    // First switch to the "近 7 天" window preset — this window supports hour grain
    // (30d is the default but it only supports day grain, not hour)
    const sevenDayButtons = screen.getAllByText("近 7 天");
    fireEvent.click(sevenDayButtons[sevenDayButtons.length - 1]);

    // wait for the 7d fetch to complete so hour button becomes enabled
    await waitFor(() => {
      expect(fetchUrls.some((u) => u.includes("/api/admin/usage/timeseries") && u.includes("window=7d"))).toBe(true);
    });

    // Now click the "小时" grain button (should be enabled for 7d window)
    const hourButtons = screen.getAllByText("小时");
    const enabledHourButton = hourButtons.find(
      (el) => el.closest("button") && !(el.closest("button") as HTMLButtonElement).disabled,
    );
    expect(enabledHourButton).toBeDefined();
    fireEvent.click(enabledHourButton!);

    // #then - a fetch with grain=hour is made
    await waitFor(() => {
      const hourCall = fetchUrls.find((u) => u.includes("/api/admin/usage/timeseries") && u.includes("grain=hour"));
      expect(hourCall).toBeDefined();
      expect(screen.queryByText("01-01")).not.toBeNull();
    });
  });

  it("renders nothing when role is not admin", () => {
    const { container } = render(<AdminSection role="user" />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when role is none", () => {
    const { container } = render(<AdminSection role="none" />);
    expect(container.firstChild).toBeNull();
  });

  it("renders ⋯ action column and DropdownMenu in users table", async () => {
    installPortalConfig();
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes("/api/admin/users")) {
        return Response.json({
          users: [{ userId: "u1", email: "admin@test.com", spend: 1.5, maxBudget: 100, teamIds: [], role: "proxy_admin" }],
          totalCount: 1,
          page: 1,
          size: 50,
        });
      }
      if (url.includes("/api/admin/summary")) return Response.json({ userCount: 1 });
      if (url.includes("/api/admin/teams")) return Response.json({ teams: [] });
      if (url.includes("/api/admin/audit")) return Response.json({ events: [], totalCount: 0, page: 1, size: 50 });
      if (url.includes("/api/admin/usage/timeseries")) return Response.json({
        available: true, grain: "day", window: "30d", windowLabel: "近 30 天",
        start: "2024-01-01T00:00:00.000Z", end: "2024-01-30T23:59:59.999Z",
        source: "spend_logs_v2_global", timezone: "Asia/Shanghai", limited: false, maxPages: null,
        buckets: [], totals: { totalTokens: 0, promptTokens: 0, completionTokens: 0, requests: 0, spend: 0 },
        topModels: [],
      });
      return Response.json({});
    }) as typeof fetch;

    render(<AdminSection role="admin" />);

    await waitFor(() => {
      expect(screen.queryAllByRole("button", { name: "更多操作" }).length).toBeGreaterThan(0);
    });

    fireEvent.click(screen.getAllByRole("button", { name: "更多操作" })[0]);
    await waitFor(() => {
      expect(screen.queryByText("查看详情")).not.toBeNull();
    });
  });

  it("renders aligned admin dashboard sections when role is admin", async () => {
    installPortalConfig();
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes("/api/admin/users")) {
        return Response.json({
          users: [{ userId: "u1", email: "admin@test.com", spend: 1.5, maxBudget: 100, teamIds: ["t1"], role: "proxy_admin" }],
          totalCount: 1,
          page: 1,
          size: 50,
        });
      }
      if (url.includes("/api/admin/summary")) {
        return Response.json({
          userCount: 1,
          sampledUserCount: 1,
          limited: false,
          teamCount: 1,
          adminCount: 1,
          unmanagedRoleCount: 0,
          noTeamUserCount: 0,
          overBudgetUserCount: 0,
          overBudgetTeamCount: 0,
          riskCount: 0,
          totalSpend: 1.5,
          teamSpend: 0.5,
          totalBudget: 100,
        });
      }
      if (url.includes("/api/admin/teams")) {
        return Response.json({
          teams: [{ id: "t1", alias: "Test Team", models: ["gpt-4o"], spend: 0.5, tpmLimit: null, rpmLimit: null }],
        });
      }
      if (url.includes("/api/admin/audit")) {
        return Response.json({
          events: [],
          totalCount: 0,
          page: 1,
          size: 50,
        });
      }
      if (url.includes("/api/admin/usage/timeseries")) {
        return Response.json({
          available: true,
          grain: "day",
          window: "30d",
          windowLabel: "近 30 天",
          start: "2024-01-01T00:00:00.000Z",
          end: "2024-01-30T23:59:59.999Z",
          source: "spend_logs_v2_global",
          timezone: "Asia/Shanghai",
          limited: false,
          maxPages: null,
          buckets: [],
          totals: { totalTokens: 0, promptTokens: 0, completionTokens: 0, requests: 0, spend: 0 },
          topModels: [],
        });
      }
      return Response.json({});
    }) as typeof fetch;

    render(<AdminSection role="admin" />);

    expect(screen.queryByText("全局管理（只读）")).not.toBeNull();
    await waitFor(() => {
      expect(screen.queryByText("全局账户")).not.toBeNull();
      expect(screen.queryByText("全员账户")).not.toBeNull();
      expect(screen.queryByText("全部团队")).not.toBeNull();
      expect(screen.queryByText("全局用量趋势")).not.toBeNull();
      expect(screen.queryByText("资源与权限")).not.toBeNull();
      expect(screen.queryByText("审计与风险")).not.toBeNull();
      expect(screen.queryByText("审计日志")).not.toBeNull();
    });
  });
});

describe("useToast — CreateKeyButton integration", () => {
  it("fires toast.add with success variant after successful key creation", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes("/api/models")) return Response.json({ models: [] });
      return Response.json({ rawKey: "sk-abc123", keyAlias: "my-key", expires: null, keyId: "kid-1" });
    }) as typeof fetch;

    render(<CreateKeyButton />);
    fireEvent.click(screen.getByRole("button", { name: "创建 Key" }));

    await waitFor(() => {
      expect(screen.queryByText("创建新 API Key")).not.toBeNull();
    });

    const aliasInput = screen.getByLabelText(/名称/) as HTMLInputElement;
    fireEvent.change(aliasInput, { target: { value: "my-key" } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));

    await waitFor(() => {
      expect(toastAddSpy).toHaveBeenCalledWith(
        expect.objectContaining({ variant: "success" }),
      );
    });
  });

  it("fires toast.add with error variant when backend returns 409", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes("/api/models")) return Response.json({ models: [] });
      return new Response(
        JSON.stringify({ error: "key_alias_conflict", keyAlias: "my-key" }),
        { status: 409, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    render(<CreateKeyButton />);
    fireEvent.click(screen.getByRole("button", { name: "创建 Key" }));

    await waitFor(() => {
      expect(screen.queryByText("创建新 API Key")).not.toBeNull();
    });

    const aliasInput = screen.getByLabelText(/名称/) as HTMLInputElement;
    fireEvent.change(aliasInput, { target: { value: "my-key" } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));

    await waitFor(() => {
      expect(toastAddSpy).toHaveBeenCalledWith(
        expect.objectContaining({ variant: "error" }),
      );
    });
  });
});

describe("Tooltip — HeroStats truncated email", () => {
  it("renders email text without title= attribute (Tooltip replaces it)", () => {
    // HeroStats uses <Tooltip> instead of title= for truncated email.
    // The mock passes children through transparently; verify no title attr.
    const { container } = render(
      <HeroStats initialData={{ me: { email: "truncated-long-email@example.com" } }} />,
    );
    const emailEl = container.querySelector("p.truncate");
    expect(emailEl).not.toBeNull();
    expect(emailEl?.getAttribute("title")).toBeNull();
    expect(emailEl?.textContent).toBe("truncated-long-email@example.com");
  });
});

describe("DropdownMenu — AdminUsersTable row actions", () => {
  it("shows 查看详情 menu item after clicking ⋯ trigger", async () => {
    installPortalConfig();
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes("/api/admin/users")) {
        return Response.json({
          users: [{ userId: "u2", email: "user@example.com", spend: 0, maxBudget: null, teamIds: [], role: "proxy_user" }],
          totalCount: 1, page: 1, size: 50,
        });
      }
      if (url.includes("/api/admin/summary")) return Response.json({ userCount: 1 });
      if (url.includes("/api/admin/teams")) return Response.json({ teams: [] });
      if (url.includes("/api/admin/audit")) return Response.json({ events: [], totalCount: 0, page: 1, size: 50 });
      if (url.includes("/api/admin/usage/timeseries")) return Response.json({
        available: true, grain: "day", window: "30d", windowLabel: "近 30 天",
        start: "2024-01-01T00:00:00.000Z", end: "2024-01-30T23:59:59.999Z",
        source: "spend_logs_v2_global", timezone: "Asia/Shanghai", limited: false, maxPages: null,
        buckets: [], totals: { totalTokens: 0, promptTokens: 0, completionTokens: 0, requests: 0, spend: 0 },
        topModels: [],
      });
      return Response.json({});
    }) as typeof fetch;

    render(<AdminSection role="admin" />);

    await waitFor(() => {
      expect(screen.queryAllByRole("button", { name: "更多操作" }).length).toBeGreaterThan(0);
    });

    fireEvent.click(screen.getAllByRole("button", { name: "更多操作" })[0]);

    await waitFor(() => {
      expect(screen.queryByText("查看详情")).not.toBeNull();
    });

    expect(screen.queryByRole("menuitem", { name: "查看详情" })).not.toBeNull();
  });
});
