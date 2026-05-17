/**
 * @vitest-environment happy-dom
 */
import React from "react";
import { afterEach, describe, it, expect } from "vitest";
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

const ownerMe: Me = {
  email: "o@x.com", userId: "u1", company: "Acme Co", domain: "x.com",
  role: "admin", tenantRole: null, tenantTeamId: null,
};

const nonOwnerMe: Me = {
  email: "user@x.com", userId: "u2", company: "Acme Co", domain: "x.com",
  role: "user", tenantRole: "member", tenantTeamId: "t1",
};

// Production-router harness — mirrors ops-console/routes.test.tsx:58-74,
// including `await router.load()` (Phase-2-proven; must be awaited).
async function renderOpsAt(path: string, me: Me) {
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

describe("OpsConsoleShell", () => {
  it("Owner sees all seven nav items + ops chip", async () => {
    await renderOpsAt("/ops", ownerMe);
    const nav = within(await screen.findByRole("navigation"));
    for (const label of ["租户总览", "发放与邀请", "全局用量", "审计", "平台设置"]) {
      expect(nav.getByText(new RegExp(label))).toBeTruthy();
    }
    expect(screen.getByText(/内部·特权/)).toBeTruthy();
  });

  it("non-Owner sees a 403 card + link to / (no nav)", async () => {
    await renderOpsAt("/ops", nonOwnerMe);
    expect(await screen.findByText(/仅平台 Owner 可访问/)).toBeTruthy();
    expect(screen.queryByRole("navigation")).toBeNull();
  });
});

describe("OpsConsoleShell a11y (§A.1)", () => {
  it("the active Ops nav link carries aria-current=page", async () => {
    await renderOpsAt("/ops/audit", ownerMe);
    const active = await screen.findByRole("link", { current: "page" });
    expect(active.getAttribute("href")).toBe("/ops/audit");
  });

  it("every Ops nav link carries the shared focus-ring utility class", async () => {
    await renderOpsAt("/ops", ownerMe);
    const links = await screen.findAllByRole("link");
    const navLinks = links.filter((l) => l.getAttribute("href")?.startsWith("/ops"));
    expect(navLinks.length).toBeGreaterThan(0);
    for (const l of navLinks) {
      expect(l.className).toContain("focus-visible:ring-kumo-brand");
    }
  });
});

describe("OpsConsoleShell §B.1 restyle", () => {
  it("renders the privileged steel-ring pill (not a brand pill)", async () => {
    await renderOpsAt("/ops", ownerMe);
    const pill = await screen.findByText(/内部 · 特权|内部·特权/);
    const el = pill.closest("[data-ops-privileged-pill]") as HTMLElement;
    expect(el).not.toBeNull();
    expect(el.className).toContain("ring-1");
  });

  it("renders the global-state summary chips region", async () => {
    await renderOpsAt("/ops", ownerMe);
    expect(await screen.findByTestId("ops-summary-chips")).toBeTruthy();
  });

  it("renders the shared SideNav with Ops group headings (compact)", async () => {
    await renderOpsAt("/ops", ownerMe);
    const nav = within(await screen.findByRole("navigation"));
    expect(nav.getByText("租户")).toBeTruthy();
    expect(nav.getByText("平台")).toBeTruthy();
  });
});
