/**
 * @vitest-environment happy-dom
 */
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
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

const adminMe: Me = {
  email: "admin@acme.example.com", userId: "u1", company: "Acme",
  domain: "acme.example.com", role: "user",
  tenantRole: "tenant_admin", tenantTeamId: "t1",
};

const memberMe: Me = {
  email: "m@acme.example.com", userId: "u2", company: "Acme",
  domain: "acme.example.com", role: "user",
  tenantRole: "member", tenantTeamId: "t1",
};

const pureOwnerMe: Me = {
  email: "o@acme.example.com", userId: "u3", company: "Acme",
  domain: "acme.example.com", role: "admin",
  tenantRole: null, tenantTeamId: null,
};

// Production-router harness — mirrors ops-console/routes.test.tsx:58-74
// EXACTLY, including `await router.load()` (the Phase-2-proven step the
// earlier draft of this harness omitted — without it the matched route's
// component is not resolved before render and `useRouterState` reads an
// unsettled location). MUST be awaited at the call site.
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

describe("TenantPortalShell", () => {
  it("shows all six nav items for a tenant_admin", async () => {
    await renderTenantAt("/usage", adminMe);
    const nav = within(await screen.findByRole("navigation"));
    expect(nav.getByText(/概览/)).toBeTruthy();
    expect(nav.getByText(/用量/)).toBeTruthy();
    expect(nav.getByText(/API Key/)).toBeTruthy();
    expect(nav.getByText(/成员/)).toBeTruthy();
    expect(nav.getByText(/预算/)).toBeTruthy();
    expect(nav.getByText(/账单/)).toBeTruthy();
  });

  it("shows only Overview/Usage/API Key for a member", async () => {
    await renderTenantAt("/usage", memberMe);
    const nav = within(await screen.findByRole("navigation"));
    expect(nav.getByText(/概览/)).toBeTruthy();
    expect(nav.getByText(/用量/)).toBeTruthy();
    expect(nav.getByText(/API Key/)).toBeTruthy();
    expect(nav.queryByText(/成员/)).toBeNull();
    expect(nav.queryByText(/预算/)).toBeNull();
    expect(nav.queryByText(/账单/)).toBeNull();
  });

  it("shows a Phase-2 notice and a /manage link for a pure Owner (admin, no tenantTeamId)", async () => {
    const { container } = await renderTenantAt("/", pureOwnerMe);
    expect((await screen.findAllByText(/Phase 2/)).length).toBeGreaterThan(0);
    expect(screen.queryByRole("navigation")).toBeNull();
    const notice = within(container.querySelector("#owner-phase2-root") as HTMLElement);
    const link = notice.getByRole("link", { name: /管理|Console|控制台/ });
    expect(link.getAttribute("href")).toBe("/manage");
  });
});

describe("TenantPortalShell a11y (§A.1)", () => {
  it("the active nav link carries aria-current=page", async () => {
    await renderTenantAt("/usage", adminMe);
    const active = await screen.findByRole("link", { current: "page" });
    expect(active.getAttribute("href")).toBe("/usage");
  });

  it("every nav link carries the shared focus-ring utility class", async () => {
    await renderTenantAt("/usage", adminMe);
    const links = await screen.findAllByRole("link");
    const navLinks = links.filter((l) => l.getAttribute("href")?.startsWith("/"));
    expect(navLinks.length).toBeGreaterThan(0);
    for (const l of navLinks) {
      expect(l.className).toContain("focus-visible:ring-kumo-brand");
    }
  });

  it("does NOT override any Kumo semantic/hierarchy/typography token (no inline --kumo-* except brand)", async () => {
    const { container } = await renderTenantAt("/usage", adminMe);
    await screen.findByRole("navigation");
    const root = container.querySelector("#tenant-portal-shell-root") as HTMLElement;
    const style = root.getAttribute("style") ?? "";
    // Only --kumo-brand / --kumo-brand-hover are ever inline-set (branding.ts).
    const decls = style.split(";").map((s) => s.trim()).filter(Boolean);
    for (const d of decls) {
      if (d.startsWith("--kumo-")) {
        expect(d.startsWith("--kumo-brand")).toBe(true);
      }
    }
  });
});
