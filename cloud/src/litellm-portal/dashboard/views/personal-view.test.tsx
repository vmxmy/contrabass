/**
 * @vitest-environment happy-dom
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PersonalView } from "./personal-view";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const RESP = {
  available: true, empty: false, scope: "self", window: "7d", grain: "day",
  grainFallback: false, timezone: "Asia/Shanghai",
  kpi: { spend: { current: 45.2, previous: 40, deltaPct: 13 },
         requests: { current: 312, previous: null, deltaPct: null },
         totalTokens: { current: 1000, previous: 900, deltaPct: 11 } },
  trend: [{ startMs: 1, label: "05-01", totalTokens: 10, requests: 2, spend: 1 }],
  models: [{ model: "gpt", spend: 1, totalTokens: 10, requests: 2 }],
};

describe("PersonalView", () => {
  it("renders KPI + panels from /api/usage/overview", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(RESP), { status: 200 }));
    const { getByText } = wrap(<PersonalView />);
    await waitFor(() => expect(getByText("$45.20")).toBeTruthy());
    expect(getByText("消费趋势")).toBeTruthy();
  });

  it("shows syncing placeholder when available=false", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ ...RESP, available: false }), { status: 200 }));
    const { getByText } = wrap(<PersonalView />);
    await waitFor(() => expect(getByText("数据同步中")).toBeTruthy());
  });
});
