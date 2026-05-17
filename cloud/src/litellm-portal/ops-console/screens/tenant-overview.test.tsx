/**
 * @vitest-environment happy-dom
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@cloudflare/kumo/components/toast", () => ({
  Toasty: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("../hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hooks")>();
  return { ...actual, useOpsTenants: vi.fn() };
});

import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setupI18n } from "../../i18n/setup";
import { ME_QUERY_KEY } from "../../hooks/use-me";
import { useOpsTenants } from "../hooks";
import { DensityProvider } from "../../components/density";
import type { Me } from "../../schemas";
import { OpsTenantOverviewScreen } from "./tenant-overview";

const i18n = setupI18n("zh-CN");
const owner: Me = { email: "o@x.com", userId: "u1", company: "C", domain: "x.com", role: "admin", tenantRole: null, tenantTeamId: null };

function renderScreen() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(ME_QUERY_KEY, owner);
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider i18n={i18n}><OpsTenantOverviewScreen /></I18nProvider>
    </QueryClientProvider>,
  );
}
afterEach(() => cleanup());

describe("OpsTenantOverviewScreen", () => {
  it("renders a row per tenant with member count + budget", () => {
    (useOpsTenants as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      data: { tenants: [{ teamId: "t1", alias: "Acme", memberCount: 3, cycleSpend: 12, maxBudget: 100, alertWebhookConfigured: true, billingPeriodsCount: 2 }] },
      isLoading: false, isError: false, error: null,
    });
    renderScreen();
    expect(screen.getByText(/Acme/)).toBeTruthy();
    expect(screen.getByText(/3/)).toBeTruthy();
  });

  it("renders Empty when no tenants", () => {
    (useOpsTenants as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      data: { tenants: [] }, isLoading: false, isError: false, error: null,
    });
    renderScreen();
    expect(screen.getByText(/暂无租户/)).toBeTruthy();
  });

  it("renders the unified PanelError on a failed request (§A.2)", () => {
    (useOpsTenants as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      data: undefined, isLoading: false, isError: true, error: new Error("boom"),
    });
    const { container } = renderScreen();
    expect(container.querySelector("[data-panel-error]")).not.toBeNull();
  });

  it("applies the compact cell density to the table under DensityProvider compact (§F.1)", () => {
    (useOpsTenants as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      data: { tenants: [{ teamId: "t1", alias: "Acme", memberCount: 3, cycleSpend: 12, maxBudget: 100, alertWebhookConfigured: true, billingPeriodsCount: 2 }] },
      isLoading: false, isError: false, error: null,
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(ME_QUERY_KEY, owner);
    const { container } = render(
      <QueryClientProvider client={qc}>
        <I18nProvider i18n={i18n}>
          <DensityProvider density="compact">
            <OpsTenantOverviewScreen />
          </DensityProvider>
        </I18nProvider>
      </QueryClientProvider>,
    );
    const cell = container.querySelector("td");
    expect(cell?.className).toContain("px-3");
    expect(cell?.className).toContain("py-1.5");
  });
});
