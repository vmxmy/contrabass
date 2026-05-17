/**
 * @vitest-environment happy-dom
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@cloudflare/kumo/components/toast", () => ({
  Toasty: ({ children }: { children: React.ReactNode }) => children,
}));

const startMutate = vi.fn((_v, opts?: { onSuccess?: () => void }) => opts?.onSuccess?.());

vi.mock("../hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hooks")>();
  return {
    ...actual,
    useOpsTenantDetail: vi.fn(),
    useStartImpersonation: () => ({ mutate: startMutate, isPending: false }),
    useOpsSetTenantRole: () => ({ mutate: vi.fn(), isPending: false }),
  };
});

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return { ...actual, useParams: () => ({ teamId: "t1" }) };
});

import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setupI18n } from "../../i18n/setup";
import { ME_QUERY_KEY } from "../../hooks/use-me";
import { useOpsTenantDetail } from "../hooks";
import { DensityProvider } from "../../components/density";
import type { Me } from "../../schemas";
import { OpsTenantDetailScreen } from "./tenant-detail";

const i18n = setupI18n("zh-CN");
const owner: Me = { email: "o@x.com", userId: "u1", company: "C", domain: "x.com", role: "admin", tenantRole: null, tenantTeamId: null };

function renderScreen() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(ME_QUERY_KEY, owner);
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider i18n={i18n}><OpsTenantDetailScreen /></I18nProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  startMutate.mockClear();
});

describe("OpsTenantDetailScreen", () => {
  it("renders members and starts impersonation on enter-tenant", () => {
    (useOpsTenantDetail as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      data: {
        teamId: "t1",
        alias: "Acme",
        maxBudget: 100,
        cycleSpend: 12,
        alertWebhookUrl: "https://hook.example",
        members: [{ userId: "u9", email: "m@x.com", tenantRole: "member", spend: null }],
        billingPeriods: ["2026-04"],
      },
      isLoading: false,
      isError: false,
      error: null,
    });
    renderScreen();
    expect(screen.getByText(/m@x.com/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /进入租户/ }));
    expect(startMutate).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: "t1", reason: expect.any(String) }),
      expect.anything(),
    );
  });

  it("applies the compact cell density to the members table under DensityProvider compact (§F.1)", () => {
    (useOpsTenantDetail as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      data: {
        teamId: "t1",
        alias: "Acme",
        maxBudget: 100,
        cycleSpend: 12,
        alertWebhookUrl: "https://hook.example",
        members: [{ userId: "u9", email: "m@x.com", tenantRole: "member", spend: null }],
        billingPeriods: ["2026-04"],
      },
      isLoading: false,
      isError: false,
      error: null,
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(ME_QUERY_KEY, owner);
    const { container } = render(
      <QueryClientProvider client={qc}>
        <I18nProvider i18n={i18n}>
          <DensityProvider density="compact">
            <OpsTenantDetailScreen />
          </DensityProvider>
        </I18nProvider>
      </QueryClientProvider>,
    );
    const cell = container.querySelector("td");
    expect(cell?.className).toContain("px-3");
    expect(cell?.className).toContain("py-1.5");
  });
});
