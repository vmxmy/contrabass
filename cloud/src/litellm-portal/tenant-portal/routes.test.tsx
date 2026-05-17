/**
 * @vitest-environment happy-dom
 */
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { I18nProvider } from "@lingui/react";
import { QueryClient } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { setupI18n } from "../i18n/setup";
import { ME_QUERY_KEY } from "../hooks/use-me";
import { createPortalRouter, createMemoryHistory } from "../router";
import { AppShell } from "../routes/__root";
import type { Me } from "../schemas";

const i18n = setupI18n("zh-CN");
afterEach(cleanup);

const tenantAdminMe: Me = {
  email: "a@acme.example.com", userId: "u1", company: "Acme",
  domain: "acme.example.com", role: "user",
  tenantRole: "tenant_admin", tenantTeamId: "t1",
};

// Production-router harness (mirrors ops-console/routes.test.tsx:58-74,
// including `await router.load()`).
async function renderTenantRouteAt(path: string, me: Me) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(ME_QUERY_KEY, me);
  const router = createPortalRouter(
    createMemoryHistory({ initialEntries: [path] }),
    { role: me.role },
  );
  await router.load();
  return render(
    <I18nProvider i18n={i18n}>
      <AppShell queryClient={qc}>
        <RouterProvider router={router} />
      </AppShell>
    </I18nProvider>,
  );
}

describe("Tenant Portal route topology (§A.0 — pathless layout)", () => {
  it("TenantPortalShell wraps a tenant SUBROUTE (/usage), not just /", async () => {
    await renderTenantRouteAt("/usage", tenantAdminMe);
    await waitFor(() => {
      expect(document.getElementById("tenant-portal-shell-root")).not.toBeNull();
    });
    // The usage screen body mounts INSIDE the shell (the tenant nav is present).
    expect(document.getElementById("tenant-usage-root")).not.toBeNull();
  });

  it("/ still renders the identity-selected shell via indexRoute (no route-id collision)", async () => {
    await renderTenantRouteAt("/", tenantAdminMe);
    await waitFor(() => {
      expect(document.getElementById("tenant-portal-shell-root")).not.toBeNull();
    });
    // The `/` overview body (owned by indexRoute→PortalIndex, NOT the layout).
    expect(document.getElementById("tenant-overview-root")).not.toBeNull();
  });
});
