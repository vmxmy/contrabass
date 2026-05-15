/**
 * @vitest-environment happy-dom
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemberOverlay } from "./member-overlay";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const MEMBER_RESP = {
  available: true, empty: false, scope: "member", window: "30d", grain: "day",
  grainFallback: false, timezone: "Asia/Shanghai",
  kpi: { spend: { current: 20.5, previous: 18, deltaPct: 13 },
         requests: { current: 150, previous: 120, deltaPct: 25 },
         totalTokens: { current: 3000, previous: 2500, deltaPct: 20 } },
  trend: [{ startMs: 1000, label: "05-01", totalTokens: 3000, requests: 150, spend: 20.5 }],
  models: [{ model: "gpt-4o", spend: 20.5, totalTokens: 3000, requests: 150 }],
  hourOfDay: Array.from({ length: 24 }, (_, h) => ({ hour: h, totalTokens: h * 10, requests: 0, spend: 0 })),
};

const GLOBAL_RESP = {
  available: true, empty: false, scope: "global", window: "30d", grain: "day",
  grainFallback: false, timezone: "Asia/Shanghai",
  kpi: { spend: { current: 128.5, previous: 110, deltaPct: 16 },
         requests: { current: 1247, previous: 1000, deltaPct: 24 },
         totalTokens: { current: 50000, previous: 40000, deltaPct: 25 } },
  trend: [{ startMs: 1000, label: "05-01", totalTokens: 50000, requests: 1247, spend: 128.5 }],
  models: [{ model: "gpt-4o", spend: 128.5, totalTokens: 50000, requests: 1247 }],
  hourOfDay: Array.from({ length: 24 }, (_, h) => ({ hour: h, totalTokens: 0, requests: 0, spend: 0 })),
  summary: { userCount: 10, adminCount: 2, teamCount: 3, totalSpend: 128.5, totalBudget: 300, riskCount: 1, sampled: false },
};

describe("MemberOverlay", () => {
  it("renders member usage detail with both member and global data (dashed series path)", async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      // First call: member, second call: global
      const resp = callCount === 0 ? MEMBER_RESP : GLOBAL_RESP;
      callCount++;
      return Promise.resolve(new Response(JSON.stringify(resp), { status: 200 }));
    });
    const { getAllByText } = wrap(
      <MemberOverlay userId="user-1" maxBudget={50} onClose={() => {}} />,
    );
    await waitFor(() => expect(getAllByText("user-1 的使用详情").length).toBeGreaterThan(0));
    // KPI data rendered
    await waitFor(() => expect(getAllByText(/\$20\.50/).length).toBeGreaterThan(0));
    // Trend container present (ECharts renders inside data-chart="trend")
    const container = document.querySelector("[data-chart='trend']");
    expect(container).not.toBeNull();
  });

  it("renders member overlay without crashing when global data is unavailable (graceful single-series)", async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/api/admin/usage/overview") && url.includes("member=")) {
        return Promise.resolve(new Response(JSON.stringify(MEMBER_RESP), { status: 200 }));
      }
      // Global fetch fails
      return Promise.resolve(new Response(JSON.stringify({ error: "not_found" }), { status: 404 }));
    });
    const { getAllByText } = wrap(
      <MemberOverlay userId="user-2" maxBudget={null} onClose={() => {}} />,
    );
    await waitFor(() => expect(getAllByText("user-2 的使用详情").length).toBeGreaterThan(0));
    await waitFor(() => expect(getAllByText(/\$20\.50/).length).toBeGreaterThan(0));
    // Component must not crash — trend container still present
    const container = document.querySelector("[data-chart='trend']");
    expect(container).not.toBeNull();
  });

  it("renders member overlay without crashing when global userCount is 0 (graceful single-series)", async () => {
    const globalNoUsers = { ...GLOBAL_RESP, summary: { ...GLOBAL_RESP.summary, userCount: 0 } };
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      const resp = callCount === 0 ? MEMBER_RESP : globalNoUsers;
      callCount++;
      return Promise.resolve(new Response(JSON.stringify(resp), { status: 200 }));
    });
    const { getAllByText } = wrap(
      <MemberOverlay userId="user-3" maxBudget={null} onClose={() => {}} />,
    );
    await waitFor(() => expect(getAllByText("user-3 的使用详情").length).toBeGreaterThan(0));
    await waitFor(() => expect(getAllByText(/\$20\.50/).length).toBeGreaterThan(0));
    const container = document.querySelector("[data-chart='trend']");
    expect(container).not.toBeNull();
  });
});
