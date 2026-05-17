/**
 * @vitest-environment happy-dom
 */
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
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
  tenantRole: null,
  tenantTeamId: null,
};

const brand = { name: "Acme", logoUrl: null, primaryColor: null };

afterEach(cleanup);

describe("TenantPortalShell", () => {
  it("shows all six nav items for a tenant_admin", () => {
    const identity: PortalIdentity = {
      ...baseIdentity,
      tenantRole: "tenant_admin",
      tenantTeamId: "team-1",
    };
    renderWithI18n(
      <TenantPortalShell identity={identity} brand={brand}>
        <div>child</div>
      </TenantPortalShell>,
    );

    const nav = within(screen.getByRole("navigation"));
    expect(nav.getByText(/概览/)).toBeTruthy();
    expect(nav.getByText(/用量/)).toBeTruthy();
    expect(nav.getByText(/API Key/)).toBeTruthy();
    expect(nav.getByText(/成员/)).toBeTruthy();
    expect(nav.getByText(/预算/)).toBeTruthy();
    expect(nav.getByText(/账单/)).toBeTruthy();
  });

  it("shows only Overview/Usage/API Key for a member", () => {
    const identity: PortalIdentity = {
      ...baseIdentity,
      tenantRole: "member",
      tenantTeamId: "team-1",
    };
    renderWithI18n(
      <TenantPortalShell identity={identity} brand={brand}>
        <div>child</div>
      </TenantPortalShell>,
    );

    const nav = within(screen.getByRole("navigation"));
    expect(nav.getByText(/概览/)).toBeTruthy();
    expect(nav.getByText(/用量/)).toBeTruthy();
    expect(nav.getByText(/API Key/)).toBeTruthy();
    expect(nav.queryByText(/成员/)).toBeNull();
    expect(nav.queryByText(/预算/)).toBeNull();
    expect(nav.queryByText(/账单/)).toBeNull();
  });

  it("shows a Phase-2 notice and a /manage link for a pure Owner (admin, no tenantTeamId)", () => {
    const identity: PortalIdentity = {
      ...baseIdentity,
      role: "admin",
      tenantRole: null,
      tenantTeamId: null,
    };
    renderWithI18n(
      <TenantPortalShell identity={identity} brand={brand}>
        <div>child</div>
      </TenantPortalShell>,
    );

    expect(screen.getAllByText(/Phase 2/).length).toBeGreaterThan(0);
    expect(screen.queryByRole("navigation")).toBeNull();
    const link = screen.getByRole("link", { name: /管理|Console|控制台/ });
    expect(link.getAttribute("href")).toBe("/manage");
  });
});
