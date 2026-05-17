/**
 * @vitest-environment happy-dom
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
vi.mock("@cloudflare/kumo/components/toast", () => ({ Toasty: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("../../../ops-console/hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../ops-console/hooks")>();
  return {
    ...actual,
    useOpsTenantDetail: vi.fn(),
    useStartImpersonation: () => ({ mutate: vi.fn(), isPending: false }),
    useOpsSetTenantRole: () => ({ mutate: vi.fn(), isPending: false }),
  };
});
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return { ...actual, useParams: () => ({ teamId: "t1" }) };
});
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setupI18n } from "../../../i18n/setup";
import { useOpsTenantDetail } from "../../../ops-console/hooks";
import { ManageTeamDetailPage } from "./$teamId.lazy";

const i18n = setupI18n("zh-CN");
afterEach(() => cleanup());

describe("ManageTeamDetailPage (做实)", () => {
  it("renders the real tenant detail, not 待实现", () => {
    (useOpsTenantDetail as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      data: {
        teamId: "t1",
        alias: "acme-team",
        maxBudget: 100,
        cycleSpend: 5,
        alertWebhookUrl: null,
        members: [],
        billingPeriods: [],
      },
      isLoading: false, isError: false, error: null,
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <I18nProvider i18n={i18n}><ManageTeamDetailPage /></I18nProvider>
      </QueryClientProvider>,
    );
    expect(screen.queryByText(/待实现/)).toBeNull();
    expect(screen.getByText(/acme-team/)).toBeTruthy();
  });
});
