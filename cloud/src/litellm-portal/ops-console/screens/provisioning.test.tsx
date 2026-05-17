/**
 * @vitest-environment happy-dom
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";

vi.mock("@cloudflare/kumo/components/toast", () => ({ Toasty: ({ children }: { children: React.ReactNode }) => children }));
const createTeamMutate = vi.fn();
const setRoleMutate = vi.fn();
vi.mock("../hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hooks")>();
  return {
    ...actual,
    useOpsCreateTeam: () => ({ mutate: createTeamMutate, isPending: false }),
    useOpsSetTenantRole: () => ({ mutate: setRoleMutate, isPending: false }),
  };
});

import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setupI18n } from "../../i18n/setup";
import { ME_QUERY_KEY } from "../../hooks/use-me";
import type { Me } from "../../schemas";
import { OpsProvisioningScreen } from "./provisioning";

const i18n = setupI18n("zh-CN");
const owner: Me = { email: "o@x.com", userId: "u1", company: "C", domain: "x.com", role: "admin", tenantRole: null, tenantTeamId: null };

function renderScreen() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(ME_QUERY_KEY, owner);
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider i18n={i18n}><OpsProvisioningScreen /></I18nProvider>
    </QueryClientProvider>,
  );
}
afterEach(() => { cleanup(); createTeamMutate.mockReset(); setRoleMutate.mockReset(); });

describe("OpsProvisioningScreen", () => {
  it("submitting the create-team form calls useOpsCreateTeam with alias", () => {
    renderScreen();
    fireEvent.change(screen.getByPlaceholderText(/团队名称/), { target: { value: "Acme" } });
    fireEvent.click(screen.getByRole("button", { name: /创建团队/ }));
    expect(createTeamMutate).toHaveBeenCalledWith(
      expect.objectContaining({ alias: "Acme", reason: expect.any(String) }),
      expect.anything(),
    );
  });

  it("submitting the tenant-role form calls useOpsSetTenantRole", () => {
    renderScreen();
    fireEvent.change(screen.getByPlaceholderText(/团队 ID/), { target: { value: "t1" } });
    fireEvent.change(screen.getByPlaceholderText(/用户 ID/), { target: { value: "u9" } });
    fireEvent.click(screen.getByRole("button", { name: /指派角色/ }));
    expect(setRoleMutate).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: "t1", userId: "u9", tenantRole: expect.any(String), reason: expect.any(String) }),
      expect.anything(),
    );
  });
});
