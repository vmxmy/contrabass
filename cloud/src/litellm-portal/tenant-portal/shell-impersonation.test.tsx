/**
 * @vitest-environment happy-dom
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
vi.mock("@cloudflare/kumo/components/toast", () => ({ Toasty: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("../ops-console/hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ops-console/hooks")>();
  return { ...actual, useStopImpersonation: () => ({ mutate: vi.fn(), isPending: false }) };
});
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setupI18n } from "../i18n/setup";
import type { PortalIdentity } from "../types";
import { TenantPortalShell } from "./shell";

const i18n = setupI18n("zh-CN");

function renderWithI18n(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider i18n={i18n}>{ui}</I18nProvider>
    </QueryClientProvider>,
  );
}

const baseIdentity: PortalIdentity = {
  email: "user@example.com",
  userId: "u-1",
  domain: "example.com",
  litellmUserId: "u-1",
  role: "user",
  tenantRole: "member",
  tenantTeamId: "t1",
};

const brand = { name: "Acme", logoUrl: null, primaryColor: null };

afterEach(cleanup);

describe("TenantPortalShell impersonation banner", () => {
  it("renders an ARIA-alert banner with an exit control when impersonating", () => {
    renderWithI18n(
      <TenantPortalShell
        identity={baseIdentity}
        brand={brand}
        impersonation={{ realActor: "o@x.com", effectiveTeamId: "t1" }}
      >
        <div>child</div>
      </TenantPortalShell>,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toBeTruthy();
    expect(screen.getByText(/退出代操作/)).toBeTruthy();
  });

  it("renders no impersonation alert banner when impersonation is null", () => {
    renderWithI18n(
      <TenantPortalShell identity={baseIdentity} brand={brand} impersonation={null}>
        <div>child</div>
      </TenantPortalShell>,
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders no impersonation alert banner when impersonation is omitted", () => {
    renderWithI18n(
      <TenantPortalShell identity={baseIdentity} brand={brand}>
        <div>child</div>
      </TenantPortalShell>,
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
