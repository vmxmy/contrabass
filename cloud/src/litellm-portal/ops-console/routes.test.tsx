/**
 * @vitest-environment happy-dom
 *
 * Production-router regression guard for the Operations Console mount.
 *
 * This renders the REAL portal router (`createPortalRouter`) at `/ops*` and
 * `/` through the REAL `AppShell`, so it exercises the C-NEW-1 RootLayout
 * split, the C2 Owner gate, and the M-NEW-1 undefined-me loading state through
 * the actual production route tree — not a stand-in `createRootRoute()`.
 *
 * Guards (do NOT weaken):
 *  - C-NEW-1: at `/ops` the Ops shell is the SOLE chrome — the generic
 *    platform `<h1>`/`#header-actions-root` are ABSENT (no double-wrap).
 *  - C2: a non-Owner at `/ops/*` gets the 403 card and NO generic chrome.
 *  - M-NEW-1: undefined `me` at `/ops` shows the loading root, NOT the 403.
 *  - the generic chrome is still PRESENT at `/` (the split didn't regress it)
 *    and the Ops shell is ABSENT there.
 */
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { I18nProvider } from "@lingui/react";
import { RouterProvider } from "@tanstack/react-router";
import { QueryClient } from "@tanstack/react-query";
import { createPortalRouter, createMemoryHistory } from "../router";
import { AppShell } from "../routes/__root";
import { ME_QUERY_KEY } from "../hooks/use-me";
import { setupI18n } from "../i18n/setup";
import type { Me } from "../schemas";

const i18n = setupI18n("zh-CN");

const ownerMe: Me = {
  email: "owner@corp.com",
  userId: "u-o",
  company: "Acme",
  domain: "corp.com",
  role: "admin",
  tenantRole: null,
  tenantTeamId: null,
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

/**
 * Render the real portal router at `path` through `AppShell`. When `me` is
 * provided it is seeded into `ME_QUERY_KEY`; when omitted the `me` query stays
 * undefined (the M-NEW-1 cold-load state).
 */
async function renderRouterAt(path: string, me?: Me) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (me !== undefined) {
    qc.setQueryData(ME_QUERY_KEY, me);
  }
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

afterEach(cleanup);

describe("Operations Console mount (production router)", () => {
  it("C-NEW-1: Owner at /ops sees the Ops shell as the SOLE chrome (no generic header)", async () => {
    await renderRouterAt("/ops", ownerMe);

    await waitFor(() => {
      expect(document.getElementById("ops-console-shell-root")).not.toBeNull();
    });
    // The Ops shell is the sole chrome — the generic platform header and its
    // actions region must NOT be wrapped around it (C-NEW-1).
    expect(document.querySelector("h1")).toBeNull();
    expect(document.getElementById("header-actions-root")).toBeNull();
    // The screen body is mounted inside the shell.
    expect(document.getElementById("ops-tenant-overview-root")).not.toBeNull();
  });

  it("C2: a non-Owner at /ops/provisioning gets the 403 card and NO generic chrome", async () => {
    await renderRouterAt("/ops/provisioning", memberMe);

    await waitFor(() => {
      expect(document.getElementById("ops-console-shell-root")).not.toBeNull();
    });
    expect(document.getElementById("ops-forbidden-root")).not.toBeNull();
    // No nav, no provisioning body for a non-Owner.
    expect(document.getElementById("ops-provisioning-root")).toBeNull();
    // Still no generic platform chrome wrapping the forbidden card.
    expect(document.querySelector("h1")).toBeNull();
    expect(document.getElementById("header-actions-root")).toBeNull();
  });

  it("M-NEW-1: undefined me at /ops shows the loading root, NOT the 403", async () => {
    await renderRouterAt("/ops");

    await waitFor(() => {
      expect(document.getElementById("ops-console-loading-root")).not.toBeNull();
    });
    // A still-loading identity must never be mistaken for an unauthorized one.
    expect(document.getElementById("ops-forbidden-root")).toBeNull();
    expect(document.getElementById("ops-console-shell-root")).toBeNull();
  });

  it("the generic chrome is still PRESENT at / and the Ops shell is ABSENT there", async () => {
    await renderRouterAt("/", ownerMe);

    await waitFor(() => {
      expect(document.querySelector("h1")).not.toBeNull();
    });
    expect(document.getElementById("header-actions-root")).not.toBeNull();
    expect(document.getElementById("ops-console-shell-root")).toBeNull();
  });
});
