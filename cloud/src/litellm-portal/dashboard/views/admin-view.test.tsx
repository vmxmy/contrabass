/**
 * @vitest-environment happy-dom
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AdminView } from "./admin-view";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const GLOBAL = {
  available: true, empty: false, scope: "global", window: "7d", grain: "day",
  grainFallback: false, timezone: "Asia/Shanghai",
  kpi: { spend: { current: 128.5, previous: 110, deltaPct: 16 },
         requests: { current: 1247, previous: 1000, deltaPct: 24 },
         totalTokens: { current: 5000, previous: 4000, deltaPct: 25 } },
  trend: [{ startMs: 1, label: "05-01", totalTokens: 10, requests: 2, spend: 1 }],
  models: [{ model: "gpt", spend: 1, totalTokens: 10, requests: 2 }],
  perUser: [{ userId: "u1", points: [{ startMs: 1, spend: 5 }] }],
  summary: { userCount: 10, adminCount: 2, teamCount: 3, totalSpend: 128.5, totalBudget: 300, riskCount: 1, sampled: false },
};

describe("AdminView", () => {
  it("renders summary KPI + perUser trend (global scope)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(GLOBAL), { status: 200 }));
    const { getByText } = wrap(<AdminView />);
    await waitFor(() => expect(getByText("$128.50")).toBeTruthy());
    expect(getByText("团队消费趋势")).toBeTruthy();
  });
});
