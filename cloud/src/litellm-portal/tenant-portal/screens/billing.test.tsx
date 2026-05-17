/**
 * @vitest-environment happy-dom
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@cloudflare/kumo/components/toast", () => ({
  Toasty: ({ children }: { children: React.ReactNode }) => children,
  ToastProvider: ({ children }: { children: React.ReactNode }) => children,
  useKumoToastManager: () => ({
    toasts: [],
    add: vi.fn(),
    remove: vi.fn(),
    update: vi.fn(),
    promise: vi.fn(),
  }),
}));

vi.mock("@cloudflare/kumo/components/popover", async () => {
  const ReactModule = await import("react");
  const Popover = ({ children }: { children: React.ReactNode }) =>
    ReactModule.createElement("div", { "data-testid": "popover" }, children);
  Popover.Trigger = ({ render }: { render: React.ReactElement }) => render;
  Popover.Content = ({ children }: { children: React.ReactNode }) =>
    ReactModule.createElement("div", { "data-testid": "popover-content" }, children);
  Popover.Title = ({ children }: { children: React.ReactNode }) =>
    ReactModule.createElement("p", { className: "popover-title" }, children);
  Popover.Description = ({ children }: { children: React.ReactNode }) =>
    ReactModule.createElement("div", { className: "popover-description" }, children);
  Popover.Close = ({ children }: { children: React.ReactNode }) => children;
  return { Popover };
});

// Mock the tenant-portal hooks — test behavior, not network.
// Use importOriginal so non-hook exports (TENANT_BILLING_QUERY_KEY etc.) pass through.
// downloadTenantBilling is spied so screen tests assert the correct period arg
// without re-testing the util's URL/blob/DOM internals (covered by hooks.test.tsx).
vi.mock("../hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hooks")>();
  return {
    ...actual,
    useTenantBillingPeriods: vi.fn(),
    downloadTenantBilling: vi.fn(),
  };
});

import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setupI18n } from "../../i18n/setup";
import { ME_QUERY_KEY } from "../../hooks/use-me";
import type { Me, TenantBillingPeriods } from "../../schemas";
import { TENANT_BILLING_QUERY_KEY } from "../hooks";
import { useTenantBillingPeriods, downloadTenantBilling } from "../hooks";
import { TenantBillingScreen } from "./billing";

const i18n = setupI18n("zh-CN");

const mockedUseTenantBillingPeriods = vi.mocked(useTenantBillingPeriods);
const mockedDownloadTenantBilling = vi.mocked(downloadTenantBilling);

function renderWithProviders(ui: React.ReactElement, me?: Partial<Me>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const meData: Me = {
    email: "admin@example.com",
    userId: "u-admin-1",
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

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const samplePeriods: TenantBillingPeriods = {
  periods: ["2026-04", "2026-03"],
};

const emptyPeriods: TenantBillingPeriods = {
  periods: [],
};

describe("TenantBillingScreen — tenant_admin", () => {
  beforeEach(() => {
    mockedUseTenantBillingPeriods.mockReturnValue({
      data: samplePeriods,
      isLoading: false,
      isError: false,
      error: null,
    } as ReturnType<typeof useTenantBillingPeriods>);
    mockedDownloadTenantBilling.mockResolvedValue(undefined);
  });

  it("renders both billing periods as rows with download buttons", () => {
    renderWithProviders(<TenantBillingScreen />, { tenantRole: "tenant_admin" });

    expect(screen.queryByText("2026-04")).not.toBeNull();
    expect(screen.queryByText("2026-03")).not.toBeNull();
    // Each period has a download button
    const downloadButtons = screen.getAllByRole("button", { name: /下载|download/i });
    expect(downloadButtons.length).toBeGreaterThanOrEqual(2);
  });

  it("calls downloadTenantBilling with exactly the period string when download button is clicked", async () => {
    renderWithProviders(<TenantBillingScreen />, { tenantRole: "tenant_admin" });

    // Find download button for the first period (2026-04)
    const rows = document.querySelectorAll("[data-period]");
    // Fallback: find button near the "2026-04" text
    const periodCell = screen.getByText("2026-04");
    const row = periodCell.closest("tr") ?? periodCell.closest("[data-period]") ?? periodCell.parentElement;
    const downloadBtn = row?.querySelector("button") ?? screen.getAllByRole("button", { name: /下载|download/i })[0];

    await act(async () => {
      fireEvent.click(downloadBtn!);
    });

    expect(mockedDownloadTenantBilling).toHaveBeenCalledWith("2026-04");
    expect(mockedDownloadTenantBilling).toHaveBeenCalledTimes(1);
  });

  it("surfaces an inline error Banner when downloadTenantBilling rejects", async () => {
    mockedDownloadTenantBilling.mockRejectedValueOnce(new Error("billing_archive_not_found"));

    renderWithProviders(<TenantBillingScreen />, { tenantRole: "tenant_admin" });

    const downloadBtn = screen.getAllByRole("button", { name: /下载|download/i })[0];

    await act(async () => {
      fireEvent.click(downloadBtn);
    });

    expect(screen.queryByText("billing_archive_not_found")).not.toBeNull();
  });

  it("clears a stale download error when the next download succeeds", async () => {
    // First download fails
    mockedDownloadTenantBilling.mockRejectedValueOnce(new Error("billing_archive_not_found"));

    renderWithProviders(<TenantBillingScreen />, { tenantRole: "tenant_admin" });

    const downloadBtns = screen.getAllByRole("button", { name: /下载|download/i });

    await act(async () => {
      fireEvent.click(downloadBtns[0]);
    });
    expect(screen.queryByText("billing_archive_not_found")).not.toBeNull();

    // Second download succeeds — stale error must clear
    mockedDownloadTenantBilling.mockResolvedValueOnce(undefined);
    await act(async () => {
      fireEvent.click(downloadBtns[0]);
    });
    expect(screen.queryByText("billing_archive_not_found")).toBeNull();
  });

  it("renders an Empty state when periods list is empty", () => {
    mockedUseTenantBillingPeriods.mockReturnValue({
      data: emptyPeriods,
      isLoading: false,
      isError: false,
      error: null,
    } as ReturnType<typeof useTenantBillingPeriods>);

    renderWithProviders(<TenantBillingScreen />, { tenantRole: "tenant_admin" });

    // Empty component should be shown — no download buttons
    expect(screen.queryAllByRole("button", { name: /下载|download/i })).toHaveLength(0);
    // The billing root is present but shows empty state
    expect(document.querySelector("#tenant-billing-root")).not.toBeNull();
  });

  it("renders loading skeletons when isLoading is true", () => {
    mockedUseTenantBillingPeriods.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      error: null,
    } as ReturnType<typeof useTenantBillingPeriods>);

    const { container } = renderWithProviders(<TenantBillingScreen />, { tenantRole: "tenant_admin" });

    // No download buttons during loading
    expect(screen.queryAllByRole("button", { name: /下载|download/i })).toHaveLength(0);
    expect(document.querySelector("#tenant-billing-root")).not.toBeNull();
    // §A.2: loading state uses the unified PanelSkeleton
    expect(container.querySelector("[data-panel-skeleton]")).not.toBeNull();
  });

  it("renders a Banner error when the query errors", () => {
    mockedUseTenantBillingPeriods.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error("billing_archive_unavailable"),
    } as ReturnType<typeof useTenantBillingPeriods>);

    renderWithProviders(<TenantBillingScreen />, { tenantRole: "tenant_admin" });

    expect(screen.queryByText("billing_archive_unavailable")).not.toBeNull();
  });
});

describe("TenantBillingScreen — non-tenant_admin", () => {
  beforeEach(() => {
    mockedUseTenantBillingPeriods.mockReturnValue({
      data: samplePeriods,
      isLoading: false,
      isError: false,
      error: null,
    } as ReturnType<typeof useTenantBillingPeriods>);
    mockedDownloadTenantBilling.mockResolvedValue(undefined);
  });

  it("renders MemberForbidden (#tenant-forbidden-root) for tenantRole=member", () => {
    renderWithProviders(<TenantBillingScreen />, { tenantRole: "member" });

    expect(document.querySelector("#tenant-forbidden-root")).not.toBeNull();
    expect(document.querySelector("#tenant-billing-root")).toBeNull();
  });

  it("does NOT render billing periods table for tenantRole=member", () => {
    renderWithProviders(<TenantBillingScreen />, { tenantRole: "member" });

    expect(screen.queryByText("2026-04")).toBeNull();
    expect(screen.queryByText("2026-03")).toBeNull();
    expect(screen.queryAllByRole("button", { name: /下载|download/i })).toHaveLength(0);
  });

  it("renders MemberForbidden for null tenantRole", () => {
    renderWithProviders(<TenantBillingScreen />, { tenantRole: null });

    expect(document.querySelector("#tenant-forbidden-root")).not.toBeNull();
  });
});

// Regression: TENANT_BILLING_QUERY_KEY is importable (not a new hook)
describe("hooks contract", () => {
  it("TENANT_BILLING_QUERY_KEY is exported from hooks", () => {
    expect(TENANT_BILLING_QUERY_KEY).toEqual(["tenant", "billing"]);
  });
});
