/**
 * @vitest-environment happy-dom
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

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

import { ApiKeysCard, CreateKeyButton, ModelAccessCard, PortalErrorBanner, UsagePanel } from "./app";
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
  delete window.__PORTAL_CONFIG;
  delete window.__litellmPortalUsageData;
  delete window.__litellmPortalModelAccess;
  delete window.__litellmPortalKeys;
  delete window.__litellmPortalError;
});

describe("ModelAccessCard", () => {
  it("expands by default when model count is <= 12", () => {
    window.__litellmPortalModelAccess = {
      models: ["gpt-4o", "gpt-4o-mini", "claude-3-5-sonnet"],
      source: "team",
    };
    render(<ModelAccessCard />);
    expect(screen.queryByText("团队可用模型")).not.toBeNull();
    expect(screen.queryByText("gpt-4o")).not.toBeNull();
  });

  it("collapses by default and shows trigger when model count exceeds 12", () => {
    const models = Array.from({ length: 15 }, (_, i) => `model-${i + 1}`);
    window.__litellmPortalModelAccess = { models, source: "team" };
    render(<ModelAccessCard />);
    expect(screen.queryByText("团队可用模型")).not.toBeNull();
    expect(screen.queryByText("model-13")).toBeNull();
    expect(screen.queryByText(/展开全部 15 个模型/)).not.toBeNull();
  });

  it("updates model list when CustomEvent is dispatched", async () => {
    window.__litellmPortalModelAccess = { models: ["gpt-4o"], source: "team" };
    render(<ModelAccessCard />);
    expect(screen.queryByText("gpt-4o")).not.toBeNull();

    window.dispatchEvent(
      new CustomEvent("litellm-portal:models", {
        detail: { models: ["gpt-4o", "deepseek-v3"], source: "configured" },
      }),
    );

    await waitFor(() => {
      expect(screen.queryByText("deepseek-v3")).not.toBeNull();
    });
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
    window.__litellmPortalKeys = [
      {
        id: "key-1",
        alias: "primary",
        displayKey: "sk-lit...cret",
        models: ["gpt-4o", "gpt-4o-mini", "deepseek-v3", "text-embedding-3-small"],
        spend: 12.5,
        maxBudget: 20,
        expiresAt: "—",
      },
    ];

    render(<ApiKeysCard />);

    expect(screen.queryByText("API Keys")).not.toBeNull();
    expect(screen.queryByText("创建 Key")).not.toBeNull();
    expect(screen.queryByText("primary")).not.toBeNull();
    expect(screen.queryByText("sk-lit...cret")).not.toBeNull();
    expect(screen.queryByText(/展开全部/)).not.toBeNull();
  });

  it("renders model lists for multiple API keys", () => {
    window.__litellmPortalKeys = [
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
    ];

    render(<ApiKeysCard />);

    expect(screen.queryByText("team-inherited")).not.toBeNull();
    expect(screen.queryByText("explicit")).not.toBeNull();
    expect(screen.queryByText("deepseek-v4-pro")).not.toBeNull();
    expect(screen.queryAllByText("gpt-5.5").length).toBe(2);
  });

  it("updates keys from CustomEvent", async () => {
    render(<ApiKeysCard />);
    window.dispatchEvent(
      new CustomEvent("litellm-portal:keys", {
        detail: [{ alias: "event-key", displayKey: "sk-lit...vent", models: [], spend: 0, maxBudget: null, expiresAt: null }],
      }),
    );

    await waitFor(() => {
      expect(screen.queryByText("event-key")).not.toBeNull();
    });
  });
});

describe("PortalErrorBanner", () => {
  it("renders page errors from CustomEvent", async () => {
    render(<PortalErrorBanner />);
    window.dispatchEvent(new CustomEvent("litellm-portal:error", { detail: "页面数据加载失败" }));

    await waitFor(() => {
      expect(screen.queryByRole("alert")).not.toBeNull();
      expect(screen.queryAllByText("页面数据加载失败").length).toBeGreaterThan(0);
    });
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
