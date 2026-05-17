/**
 * @vitest-environment happy-dom
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@cloudflare/kumo/components/toast", () => ({
  Toasty: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("../../hooks/use-admin-audit", () => ({
  useAdminAudit: () => ({
    data: {
      events: [
        {
          id: "ev-1",
          createdAt: "2026-05-17T00:00:00Z",
          action: "ops_impersonation_start",
          actorUserId: null,
          actorUserEmail: "o@x.com",
          objectType: "team",
          objectId: "t1",
        },
      ],
      totalCount: 1,
      page: 1,
      size: 50,
    },
    isLoading: false,
    isError: false,
    error: null,
  }),
}));
vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({}),
}));

import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setupI18n } from "../../i18n/setup";
import { ME_QUERY_KEY } from "../../hooks/use-me";
import { DensityProvider } from "../../components/density";
import type { Me } from "../../schemas";
import { OpsAuditScreen } from "./audit";

const i18n = setupI18n("zh-CN");
const owner: Me = { email: "o@x.com", userId: "u1", company: "C", domain: "x.com", role: "admin", tenantRole: null, tenantTeamId: null };

function renderScreen() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(ME_QUERY_KEY, owner);
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider i18n={i18n}><OpsAuditScreen /></I18nProvider>
    </QueryClientProvider>,
  );
}
afterEach(() => cleanup());

describe("OpsAuditScreen", () => {
  it("renders the audit feed with a detail link per event", () => {
    renderScreen();
    expect(screen.getByText(/ops_impersonation_start/)).toBeTruthy();
    const link = screen.getByRole("link", { name: /详情/ });
    expect(link.getAttribute("href")).toContain("/ops/audit/ev-1");
  });

  it("applies the compact cell density to the table under DensityProvider compact (§F.1)", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(ME_QUERY_KEY, owner);
    const { container } = render(
      <QueryClientProvider client={qc}>
        <I18nProvider i18n={i18n}>
          <DensityProvider density="compact">
            <OpsAuditScreen />
          </DensityProvider>
        </I18nProvider>
      </QueryClientProvider>,
    );
    const cell = container.querySelector("td");
    expect(cell?.className).toContain("px-3");
    expect(cell?.className).toContain("py-1.5");
  });
});
