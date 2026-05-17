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
// Use importOriginal so non-hook exports (TENANT_WEBHOOK_QUERY_KEY etc.) pass through.
const mockSetMutateSpy = vi.fn();
const mockClearMutateSpy = vi.fn();

vi.mock("../hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hooks")>();
  return {
    ...actual,
    useTenantWebhook: vi.fn(),
    useSetTenantWebhook: vi.fn(),
    useClearTenantWebhook: vi.fn(),
  };
});

import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setupI18n } from "../../i18n/setup";
import { ME_QUERY_KEY } from "../../hooks/use-me";
import type { Me, TeamAlertWebhookResult } from "../../schemas";
import { TENANT_WEBHOOK_QUERY_KEY } from "../hooks";
import { useTenantWebhook, useSetTenantWebhook, useClearTenantWebhook } from "../hooks";
import { TenantAlertsScreen } from "./alerts";

const i18n = setupI18n("zh-CN");

const mockedUseTenantWebhook = vi.mocked(useTenantWebhook);
const mockedUseSetTenantWebhook = vi.mocked(useSetTenantWebhook);
const mockedUseClearTenantWebhook = vi.mocked(useClearTenantWebhook);

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

const sampleWebhook: TeamAlertWebhookResult = {
  teamId: "team-1",
  url: "https://hooks.example.com/notify",
  updatedAt: "2024-06-01T12:00:00Z",
};

const emptyWebhook: TeamAlertWebhookResult = {
  teamId: "team-1",
  url: null,
  updatedAt: null,
};

describe("TenantAlertsScreen — tenant_admin", () => {
  beforeEach(() => {
    mockedUseTenantWebhook.mockReturnValue({
      data: sampleWebhook,
      isLoading: false,
      isError: false,
      error: null,
    } as ReturnType<typeof useTenantWebhook>);
    mockedUseSetTenantWebhook.mockReturnValue({
      mutate: mockSetMutateSpy,
      isPending: false,
    } as unknown as ReturnType<typeof useSetTenantWebhook>);
    mockedUseClearTenantWebhook.mockReturnValue({
      mutate: mockClearMutateSpy,
      isPending: false,
    } as unknown as ReturnType<typeof useClearTenantWebhook>);
  });

  it("renders the current webhook URL and updatedAt when GET returns data", () => {
    renderWithProviders(<TenantAlertsScreen />, { tenantRole: "tenant_admin" });

    expect(screen.queryByText("https://hooks.example.com/notify")).not.toBeNull();
    expect(screen.queryByText("2024-06-01T12:00:00Z")).not.toBeNull();
  });

  it("loading state uses the unified PanelSkeleton (§A.2)", () => {
    mockedUseTenantWebhook.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useTenantWebhook>);
    const { container } = renderWithProviders(<TenantAlertsScreen />, { tenantRole: "tenant_admin" });
    expect(container.querySelector("[data-panel-skeleton]")).not.toBeNull();
  });

  it("renders an empty state when GET returns null url", () => {
    mockedUseTenantWebhook.mockReturnValue({
      data: emptyWebhook,
      isLoading: false,
      isError: false,
      error: null,
    } as ReturnType<typeof useTenantWebhook>);

    renderWithProviders(<TenantAlertsScreen />, { tenantRole: "tenant_admin" });

    // Form should still be present even when no webhook is configured
    expect(document.querySelector("#tenant-alerts-root")).not.toBeNull();
  });

  it("calls useSetTenantWebhook mutate with exact {reason, url} payload on Save", () => {
    renderWithProviders(<TenantAlertsScreen />, { tenantRole: "tenant_admin" });

    const urlInput = screen.getByRole("textbox", { name: /webhook.*url|告警.*webhook|alert.*webhook/i });
    fireEvent.change(urlInput, { target: { value: "https://new.example.com/alert" } });

    const saveButton = screen.getByRole("button", { name: /保存|save/i });
    fireEvent.click(saveButton);

    expect(mockSetMutateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: expect.any(String),
        url: "https://new.example.com/alert",
      }),
      expect.anything(),
    );
  });

  it("renders server 422 error message inline via Banner on set mutation failure", () => {
    let capturedCallbacks: { onError?: (err: unknown) => void } = {};
    mockSetMutateSpy.mockImplementation((_input: unknown, callbacks?: { onError?: (err: unknown) => void }) => {
      capturedCallbacks = callbacks ?? {};
    });

    renderWithProviders(<TenantAlertsScreen />, { tenantRole: "tenant_admin" });

    const urlInput = screen.getByRole("textbox", { name: /webhook.*url|告警.*webhook|alert.*webhook/i });
    fireEvent.change(urlInput, { target: { value: "http://blocked.example.com" } });

    const saveButton = screen.getByRole("button", { name: /保存|save/i });
    fireEvent.click(saveButton);

    // Simulate server 422 rejection with real error code from SetTeamAlertWebhookBodySchema
    act(() => {
      capturedCallbacks.onError?.(new Error("https_required"));
    });

    expect(screen.queryByText("https_required")).not.toBeNull();
  });

  it("calls useClearTenantWebhook mutate on Clear button click", () => {
    renderWithProviders(<TenantAlertsScreen />, { tenantRole: "tenant_admin" });

    const clearButton = screen.getByRole("button", { name: /清除|clear/i });
    fireEvent.click(clearButton);

    expect(mockClearMutateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: expect.any(String),
      }),
      expect.anything(),
    );
  });

  it("clears stale error Banner when Clear succeeds after a failed Save", () => {
    let savedSetCallbacks: { onError?: (err: unknown) => void } = {};
    let savedClearCallbacks: { onSuccess?: () => void } = {};
    mockSetMutateSpy.mockImplementation((_input: unknown, cbs?: { onError?: (err: unknown) => void }) => {
      savedSetCallbacks = cbs ?? {};
    });
    mockClearMutateSpy.mockImplementation((_input: unknown, cbs?: { onSuccess?: () => void }) => {
      savedClearCallbacks = cbs ?? {};
    });

    renderWithProviders(<TenantAlertsScreen />, { tenantRole: "tenant_admin" });

    // Trigger a Save that the server rejects
    const saveButton = screen.getByRole("button", { name: /保存|save/i });
    fireEvent.click(saveButton);
    act(() => {
      savedSetCallbacks.onError?.(new Error("https_required"));
    });
    expect(screen.queryByText("https_required")).not.toBeNull();

    // Now Clear succeeds — stale error Banner must disappear
    const clearButton = screen.getByRole("button", { name: /清除|clear/i });
    fireEvent.click(clearButton);
    act(() => {
      savedClearCallbacks.onSuccess?.();
    });
    expect(screen.queryByText("https_required")).toBeNull();
  });
});

describe("TenantAlertsScreen — non-tenant_admin", () => {
  beforeEach(() => {
    mockedUseTenantWebhook.mockReturnValue({
      data: sampleWebhook,
      isLoading: false,
      isError: false,
      error: null,
    } as ReturnType<typeof useTenantWebhook>);
    mockedUseSetTenantWebhook.mockReturnValue({
      mutate: mockSetMutateSpy,
      isPending: false,
    } as unknown as ReturnType<typeof useSetTenantWebhook>);
    mockedUseClearTenantWebhook.mockReturnValue({
      mutate: mockClearMutateSpy,
      isPending: false,
    } as unknown as ReturnType<typeof useClearTenantWebhook>);
  });

  it("renders MemberForbidden (#tenant-forbidden-root) for tenantRole=member", () => {
    renderWithProviders(<TenantAlertsScreen />, { tenantRole: "member" });

    expect(document.querySelector("#tenant-forbidden-root")).not.toBeNull();
    expect(document.querySelector("#tenant-alerts-root")).toBeNull();
  });

  it("does NOT render the alerts form for tenantRole=member", () => {
    renderWithProviders(<TenantAlertsScreen />, { tenantRole: "member" });

    expect(screen.queryByRole("textbox", { name: /webhook|alert/i })).toBeNull();
  });

  it("renders MemberForbidden for null tenantRole", () => {
    renderWithProviders(<TenantAlertsScreen />, { tenantRole: null });

    expect(document.querySelector("#tenant-forbidden-root")).not.toBeNull();
  });
});

// Regression: TENANT_WEBHOOK_QUERY_KEY is importable (not a new hook)
describe("hooks contract", () => {
  it("TENANT_WEBHOOK_QUERY_KEY is exported from hooks", () => {
    expect(TENANT_WEBHOOK_QUERY_KEY).toEqual(["tenant", "alert-webhook"]);
  });
});
