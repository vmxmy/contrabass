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
import { RouterProvider } from "@tanstack/react-router";
import { setupI18n } from "../i18n/setup";
import { createPortalRouter, createMemoryHistory } from "../router";
import { AppShell } from "../routes/__root";
import { ME_QUERY_KEY } from "../hooks/use-me";
import type { Me } from "../schemas";

const i18n = setupI18n("zh-CN");

afterEach(cleanup);

// Production-router harness — mirrors tenant-portal/shell.test.tsx /
// ops-console/routes.test.tsx:58-74 EXACTLY, including `await router.load()`.
async function renderTenantAt(path: string, me: Me) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(ME_QUERY_KEY, me);
  const router = createPortalRouter(
    createMemoryHistory({ initialEntries: [path] }),
    { role: me.role },
  );
  await router.load();
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider i18n={i18n}>
        <AppShell queryClient={qc}>
          <RouterProvider router={router} />
        </AppShell>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

const baseMe: Me = {
  email: "user@example.com", userId: "u-1", company: "Acme",
  domain: "example.com", role: "user",
  tenantRole: "member", tenantTeamId: "t1",
};

describe("TenantPortalShell impersonation banner", () => {
  it("renders an ARIA-alert banner with an exit control when impersonating", async () => {
    await renderTenantAt("/usage", {
      ...baseMe,
      impersonation: { realActor: "o@x.com", effectiveTeamId: "t1" },
    });
    const alert = await screen.findByRole("alert");
    expect(alert).toBeTruthy();
    expect(screen.getByText(/退出代操作/)).toBeTruthy();
  });

  it("renders no impersonation alert banner when impersonation is null", async () => {
    await renderTenantAt("/usage", { ...baseMe, impersonation: null });
    await screen.findByRole("navigation");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders no impersonation alert banner when impersonation is omitted", async () => {
    await renderTenantAt("/usage", baseMe);
    await screen.findByRole("navigation");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
