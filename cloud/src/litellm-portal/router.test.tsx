/**
 * @vitest-environment happy-dom
 */
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { I18nProvider } from "@lingui/react";
import { RouterProvider } from "@tanstack/react-router";
import { QueryClient } from "@tanstack/react-query";
import { createPortalRouter, createMemoryHistory } from "./router";
import { createTenantPortalRoutes } from "./tenant-portal/routes";
import { rootRoute } from "./routes/__root";
import { AppShell } from "./routes/__root";
import { ME_QUERY_KEY } from "./hooks/use-me";
import { setupI18n } from "./i18n/setup";
import type { Me } from "./schemas";

const i18n = setupI18n("zh-CN");

/**
 * Render the real portal router at the given path through `AppShell` with a
 * QueryClient pre-seeded with the `me` query. This exercises the
 * shell-SELECTION logic only — which branch (`TenantPortalShell` vs legacy
 * `UserView`, and which nav variant) the seeded `ME_QUERY_KEY` data picks. It
 * is a single client-side render, NOT an SSR→hydrateRoot round-trip; the
 * permanent #418 SSR/hydration parity guard lives in `hydration.test.tsx`.
 */
async function renderPortalAt(path: string, me: Me) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(ME_QUERY_KEY, me);
  const history = createMemoryHistory({ initialEntries: [path] });
  const router = createPortalRouter(history, { role: me.role });
  await router.load();
  const utils = render(
    <I18nProvider i18n={i18n}>
      <AppShell queryClient={qc}>
        <RouterProvider router={router} />
      </AppShell>
    </I18nProvider>,
  );
  return { router, ...utils };
}

const tenantAdminMe: Me = {
  email: "ta@team.com",
  userId: "u-ta",
  company: "Acme",
  domain: "team.com",
  role: "user",
  tenantRole: "tenant_admin",
  tenantTeamId: "t1",
};

const memberMe: Me = {
  email: "m@team.com",
  userId: "u-m",
  company: "Acme",
  domain: "team.com",
  role: "user",
  tenantRole: "member",
  tenantTeamId: "t1",
};

const pureOwnerMe: Me = {
  email: "owner@corp.com",
  userId: "u-o",
  company: "Acme",
  domain: "corp.com",
  role: "admin",
  tenantRole: null,
  tenantTeamId: null,
};

afterEach(cleanup);

describe("createPortalRouter", () => {
  it("resolves / to the unified usage dashboard for a user-role context", async () => {
    const history = createMemoryHistory({ initialEntries: ["/"] });
    const router = createPortalRouter(history, { role: "user" });
    await router.load();

    expect(router.state.location.pathname).toBe("/");
    expect(router.state.matches.some((m) => m.routeId === "__root__/404")).toBe(false);
  });

  it("redirects /manage to /manage/keys", async () => {
    const history = createMemoryHistory({ initialEntries: ["/manage"] });
    const router = createPortalRouter(history, { role: "user" });
    await router.load();

    expect(router.state.location.pathname).toBe("/manage/keys");
  });

  it("allows non-admin users to access /manage/keys", async () => {
    const history = createMemoryHistory({ initialEntries: ["/manage/keys"] });
    const router = createPortalRouter(history, { role: "user" });
    await router.load();

    expect(router.state.location.pathname).toBe("/manage/keys");
  });

  it("redirects non-admin users away from admin-only manage routes", async () => {
    const history = createMemoryHistory({ initialEntries: ["/manage/audit/abc123"] });
    const router = createPortalRouter(history, { role: "none" });
    await router.load();

    expect(router.state.location.pathname).toBe("/");
  });

  it("allows admin users to access admin-only manage routes", async () => {
    const history = createMemoryHistory({ initialEntries: ["/manage/audit/abc123"] });
    const router = createPortalRouter(history, { role: "admin" });
    await router.load();

    expect(router.state.location.pathname).toBe("/manage/audit/abc123");
  });

  it("keeps /manage/keys resolving unchanged after the Tenant Portal shell lands", async () => {
    const history = createMemoryHistory({ initialEntries: ["/manage/keys"] });
    const router = createPortalRouter(history, { role: "user" });
    await router.load();

    expect(router.state.location.pathname).toBe("/manage/keys");
    expect(router.state.matches.some((m) => m.routeId === "__root__/404")).toBe(false);
  });

  it("redirects /manage to /manage/keys after Task 1 (legacy not regressed)", async () => {
    const history = createMemoryHistory({ initialEntries: ["/manage"] });
    const router = createPortalRouter(history, { role: "admin" });
    await router.load();

    expect(router.state.location.pathname).toBe("/manage/keys");
  });

  it("redirects legacy /admin links to the new destinations", async () => {
    const history = createMemoryHistory({ initialEntries: ["/admin/users/alice%40example.com"] });
    const router = createPortalRouter(history, { role: "admin" });
    await router.load();

    expect(router.state.location.pathname).toBe("/manage/users/alice%40example.com");
  });

  it("redirects legacy /preferences to /manage/preferences", async () => {
    const history = createMemoryHistory({ initialEntries: ["/preferences"] });
    const router = createPortalRouter(history, { role: "user" });
    await router.load();

    expect(router.state.location.pathname).toBe("/manage/preferences");
  });

  it("registers the tenant subtree routes (a child route matches, not just __root__)", async () => {
    for (const path of ["/usage", "/keys", "/members", "/alerts", "/billing"]) {
      const history = createMemoryHistory({ initialEntries: [path] });
      const router = createPortalRouter(history, { role: "user" });
      await router.load();

      expect(router.state.location.pathname).toBe(path);
      // An unregistered path matches only ["__root__"]; a registered tenant
      // route adds its own match → length > 1.
      const childMatches = router.state.matches.filter((m) => m.routeId !== "__root__");
      expect(childMatches.length).toBeGreaterThan(0);
    }
  });

  it("factory exclusion drops the / overview spec inside the factory (not by call-site index)", () => {
    const withIndex = createTenantPortalRoutes(rootRoute);
    const withoutIndex = createTenantPortalRoutes(rootRoute, { includeIndex: false });

    expect(withIndex).toHaveLength(6);
    expect(withoutIndex).toHaveLength(5);
    const excludedPaths = withoutIndex.map((r) => r.options.path);
    expect(excludedPaths).not.toContain("/");
    expect([...excludedPaths].sort()).toEqual(
      ["/alerts", "/billing", "/keys", "/members", "/usage"].sort(),
    );
  });

  it("keeps legacy /manage/* resolving and does not collide with the tenant subtree", async () => {
    const history = createMemoryHistory({ initialEntries: ["/manage/keys"] });
    const router = createPortalRouter(history, { role: "user" });
    await router.load();

    expect(router.state.location.pathname).toBe("/manage/keys");
    // Legacy /manage/keys still resolves via the manage subtree, distinct from
    // the new top-level tenant /keys route.
    const ids = router.state.matches.map((m) => m.routeId);
    expect(ids.some((id) => id.includes("/manage"))).toBe(true);
  });
});

describe("/ shell selection from useMe()", () => {
  it("renders the Tenant Portal shell (not the legacy UserView) for a tenant_admin", async () => {
    await renderPortalAt("/", tenantAdminMe);

    await waitFor(() => {
      expect(document.getElementById("tenant-portal-shell-root")).not.toBeNull();
    });
    expect(screen.getByLabelText("租户品牌")).toBeTruthy();
    expect(screen.getByLabelText("租户导航")).toBeTruthy();
    expect(document.getElementById("usage-panel-root")).toBeNull();
    expect(document.getElementById("identity-bar-root")).toBeNull();
  });

  it("renders the shell with the 3-item member nav for a member", async () => {
    await renderPortalAt("/", memberMe);

    await waitFor(() => {
      expect(document.getElementById("tenant-portal-shell-root")).not.toBeNull();
    });
    const nav = screen.getByLabelText("租户导航");
    expect(nav.textContent).toContain("概览");
    expect(nav.textContent).toContain("用量");
    expect(nav.textContent).toContain("API Key");
    expect(nav.textContent).not.toContain("成员");
    expect(nav.textContent).not.toContain("预算");
    expect(nav.textContent).not.toContain("账单");
  });

  it("renders the Ops Console entry variant with a /ops link for a pure Owner", async () => {
    await renderPortalAt("/", pureOwnerMe);

    await waitFor(() => {
      expect(document.getElementById("tenant-portal-shell-root")).not.toBeNull();
    });
    const ownerEntry = document.getElementById("owner-ops-entry-root");
    expect(ownerEntry).not.toBeNull();
    expect(screen.getAllByText(/运营控制台|Operations Console/).length).toBeGreaterThan(0);
    // Scope to the ops-entry region to avoid matching other /ops links in chrome.
    const entryLink = within(ownerEntry as HTMLElement).getByRole("link");
    expect(entryLink.getAttribute("href")).toBe("/ops");
    expect(screen.queryByLabelText("租户导航")).toBeNull();
  });
});

describe("C-NEW-1: RootLayout /ops chrome split (production router)", () => {
  const ownerMe: Me = {
    email: "owner@corp.com",
    userId: "u-o",
    company: "Acme",
    domain: "corp.com",
    role: "admin",
    tenantRole: null,
    tenantTeamId: null,
  };

  async function renderAt(path: string, me?: Me) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    if (me !== undefined) qc.setQueryData(ME_QUERY_KEY, me);
    const history = createMemoryHistory({ initialEntries: [path] });
    const router = createPortalRouter(history, { role: me?.role });
    await router.load();
    const utils = render(
      <I18nProvider i18n={i18n}>
        <AppShell queryClient={qc}>
          <RouterProvider router={router} />
        </AppShell>
      </I18nProvider>,
    );
    return { router, ...utils };
  }

  it("at /ops the generic chrome is ABSENT and the Ops shell is the sole chrome", async () => {
    await renderAt("/ops", ownerMe);

    await waitFor(() => {
      expect(document.getElementById("ops-console-shell-root")).not.toBeNull();
    });
    expect(document.querySelector("h1")).toBeNull();
    expect(document.getElementById("header-actions-root")).toBeNull();
  });

  it("at / the generic chrome is PRESENT and the Ops shell is ABSENT", async () => {
    await renderAt("/", ownerMe);

    await waitFor(() => {
      expect(document.querySelector("h1")).not.toBeNull();
    });
    expect(document.getElementById("header-actions-root")).not.toBeNull();
    expect(document.getElementById("ops-console-shell-root")).toBeNull();
  });

  it("legacy /manage/keys still resolves after the /ops mount + RootLayout split", async () => {
    const history = createMemoryHistory({ initialEntries: ["/manage/keys"] });
    const router = createPortalRouter(history, { role: "user" });
    await router.load();

    expect(router.state.location.pathname).toBe("/manage/keys");
    expect(router.state.matches.some((m) => m.routeId === "__root__/404")).toBe(false);
  });
});
