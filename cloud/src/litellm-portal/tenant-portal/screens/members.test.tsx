/**
 * @vitest-environment happy-dom
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

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
// Use importOriginal so non-hook exports (TENANT_INVITES_QUERY_KEY etc.) pass through.
const mockMutateSpy = vi.fn();
const mockRevokeMutateSpy = vi.fn();

vi.mock("../hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hooks")>();
  return {
    ...actual,
    useTenantInvites: vi.fn(),
    useCreateTenantInvite: vi.fn(),
    useRevokeTenantInvite: vi.fn(),
  };
});

import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setupI18n } from "../../i18n/setup";
import { ME_QUERY_KEY } from "../../hooks/use-me";
import type { Me, AdminInviteList } from "../../schemas";
import { TENANT_INVITES_QUERY_KEY } from "../hooks";
import { useTenantInvites, useCreateTenantInvite, useRevokeTenantInvite } from "../hooks";
import { TenantMembersScreen } from "./members";

const i18n = setupI18n("zh-CN");

const mockedUseTenantInvites = vi.mocked(useTenantInvites);
const mockedUseCreateTenantInvite = vi.mocked(useCreateTenantInvite);
const mockedUseRevokeTenantInvite = vi.mocked(useRevokeTenantInvite);

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

const sampleInvites: AdminInviteList = {
  invites: [
    {
      email: "alice@example.com",
      teamId: "team-1",
      teamRole: "user",
      status: "pending",
      invitedBy: "admin@example.com",
      createdAt: "2024-01-01T00:00:00Z",
      consumedAt: null,
    },
    {
      email: "bob@example.com",
      teamId: "team-1",
      teamRole: "admin",
      status: "consumed",
      invitedBy: "admin@example.com",
      createdAt: "2024-01-02T00:00:00Z",
      consumedAt: "2024-01-03T00:00:00Z",
    },
  ],
};

describe("TenantMembersScreen — tenant_admin", () => {
  beforeEach(() => {
    mockedUseTenantInvites.mockReturnValue({
      data: sampleInvites,
      isLoading: false,
      isError: false,
      error: null,
    } as ReturnType<typeof useTenantInvites>);
    mockedUseCreateTenantInvite.mockReturnValue({
      mutate: mockMutateSpy,
      isPending: false,
    } as unknown as ReturnType<typeof useCreateTenantInvite>);
    mockedUseRevokeTenantInvite.mockReturnValue({
      mutate: mockRevokeMutateSpy,
      isPending: false,
    } as unknown as ReturnType<typeof useRevokeTenantInvite>);
  });

  it("renders the invites table with email, role, and status for each row", () => {
    renderWithProviders(<TenantMembersScreen />, { tenantRole: "tenant_admin" });

    expect(screen.queryByText("alice@example.com")).not.toBeNull();
    expect(screen.queryByText("bob@example.com")).not.toBeNull();
    // At least one status pill is visible
    expect(screen.queryByText("pending") ?? screen.queryByText("consumed")).not.toBeNull();
  });

  it("calls useCreateTenantInvite mutate with correct payload on form submit", () => {
    renderWithProviders(<TenantMembersScreen />, { tenantRole: "tenant_admin" });

    const emailInput = screen.getByPlaceholderText(/email/i);
    fireEvent.change(emailInput, { target: { value: "newuser@example.com" } });

    const submitButton = screen.getByRole("button", { name: /邀请|发送邀请|invite/i });
    fireEvent.click(submitButton);

    expect(mockMutateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "newuser@example.com",
        teamRole: expect.stringMatching(/admin|user/),
      }),
      expect.anything(),
    );
  });

  it("typed-confirm revoke: wrong email keeps confirm disabled, correct email enables it and fires mutate", () => {
    renderWithProviders(<TenantMembersScreen />, { tenantRole: "tenant_admin" });

    // Click the revoke button for alice
    const revokeButtons = screen.getAllByRole("button", { name: /撤销|revoke/i });
    fireEvent.click(revokeButtons[0]);

    // Dialog should be open — find the confirm input
    const confirmInput = screen.getByPlaceholderText(/alice@example.com/i);
    const confirmButton = screen.getByRole("button", { name: /确认撤销|confirm revoke/i });

    // Wrong email → button disabled
    fireEvent.change(confirmInput, { target: { value: "wrong@example.com" } });
    expect((confirmButton as HTMLButtonElement).disabled).toBe(true);

    // Correct email → button enabled
    fireEvent.change(confirmInput, { target: { value: "alice@example.com" } });
    expect((confirmButton as HTMLButtonElement).disabled).toBe(false);

    // Confirm → revoke mutate called with the email
    fireEvent.click(confirmButton);
    expect(mockRevokeMutateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "alice@example.com",
        confirmEmail: "alice@example.com",
      }),
      expect.anything(),
    );
  });
});

describe("TenantMembersScreen — non-tenant_admin", () => {
  beforeEach(() => {
    mockedUseTenantInvites.mockReturnValue({
      data: sampleInvites,
      isLoading: false,
      isError: false,
      error: null,
    } as ReturnType<typeof useTenantInvites>);
    mockedUseCreateTenantInvite.mockReturnValue({
      mutate: mockMutateSpy,
      isPending: false,
    } as unknown as ReturnType<typeof useCreateTenantInvite>);
    mockedUseRevokeTenantInvite.mockReturnValue({
      mutate: mockRevokeMutateSpy,
      isPending: false,
    } as unknown as ReturnType<typeof useRevokeTenantInvite>);
  });

  it("renders the forbidden state (MemberForbidden) for tenantRole=member", () => {
    renderWithProviders(<TenantMembersScreen />, { tenantRole: "member" });

    expect(document.querySelector("#tenant-forbidden-root")).not.toBeNull();
  });

  it("does NOT render the invites table or create form for tenantRole=member", () => {
    renderWithProviders(<TenantMembersScreen />, { tenantRole: "member" });

    expect(document.querySelector("#tenant-members-root")).toBeNull();
    expect(screen.queryByText("alice@example.com")).toBeNull();
    expect(screen.queryByPlaceholderText(/email/i)).toBeNull();
  });

  it("renders the forbidden state for null tenantRole", () => {
    renderWithProviders(<TenantMembersScreen />, { tenantRole: null });

    expect(document.querySelector("#tenant-forbidden-root")).not.toBeNull();
  });
});

// Regression: TENANT_INVITES_QUERY_KEY is importable (not a new hook)
describe("hooks contract", () => {
  it("TENANT_INVITES_QUERY_KEY is exported from hooks", () => {
    expect(TENANT_INVITES_QUERY_KEY).toEqual(["tenant", "invites"]);
  });
});
