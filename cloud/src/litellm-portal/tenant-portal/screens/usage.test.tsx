/**
 * @vitest-environment happy-dom
 */
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setupI18n } from "../../i18n/setup";
import { ME_QUERY_KEY } from "../../hooks/use-me";
import type { Me } from "../../schemas";
import { TenantUsageScreen } from "./usage";

const i18n = setupI18n("zh-CN");

function renderWithProviders(ui: React.ReactElement, me?: Partial<Me>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const meData: Me = {
    email: "tenant@example.com",
    userId: "u-tenant-1",
    company: "Acme",
    domain: "example.com",
    role: "user",
    tenantRole: "member",
    tenantTeamId: "team-1",
    ...me,
  };
  qc.setQueryData<Me>(ME_QUERY_KEY, meData);
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider i18n={i18n}>{ui}</I18nProvider>
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe("TenantUsageScreen", () => {
  it("renders the usage dashboard section", () => {
    renderWithProviders(<TenantUsageScreen />);
    expect(screen.queryByRole("region", { name: "用量仪表盘" })).not.toBeNull();
  });

  it("does not show global/scope toggle for a tenant user (role=user)", () => {
    renderWithProviders(<TenantUsageScreen />);
    // The Tabs scope toggle ("个人"/"全局") is rendered only when me.role === "admin".
    // A tenant user has role "user" so the toggle must be absent.
    expect(screen.queryByText(/全局/)).toBeNull();
    expect(screen.queryByText(/个人/)).toBeNull();
  });
});
