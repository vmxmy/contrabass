/**
 * @vitest-environment happy-dom
 */
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { I18nProvider } from "@lingui/react";
import { setupI18n } from "../i18n/setup";
import { RouterProvider } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createPortalRouter, createMemoryHistory } from "../router";
import { AppShell } from "../routes/__root";
import { ME_QUERY_KEY } from "../hooks/use-me";
import type { Me } from "../schemas";

const i18n = setupI18n("zh-CN");
afterEach(cleanup);

const me: Me = {
  email: "a@x.com", userId: "u1", company: "Acme", domain: "x.com",
  role: "user", tenantRole: "tenant_admin", tenantTeamId: "t1",
};

// Production-router harness WITH `await router.load()` (mirrors
// ops-console/routes.test.tsx:58-74; the load step is required so the matched
// route's <main> is mounted before assertions). The Tenant content <main>
// lives in TenantLayout (Task-0 pathless layout, reached at tenant subroutes)
// AND is reached at `/` via indexRoute→PortalIndex — assert BOTH.
async function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(ME_QUERY_KEY, me);
  const router = createPortalRouter(createMemoryHistory({ initialEntries: [path] }), { role: "user" });
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

describe("§B.4 motion language", () => {
  for (const path of ["/", "/usage"] as const) {
    it(`route-enter motion on main content is motion-safe gated and <=200ms (${path})`, async () => {
      const { container } = await renderAt(path);
      // The shell's content <main> is the INNERMOST main: tenant routes nest
      // __root.tsx's outer layout <main> (out of Task-7 scope) around the
      // TenantPortalShell content <main>. Select the last <main> so the
      // route-enter-motion assertion targets the shell-owned element Task 7
      // actually edits, not __root.tsx's layout wrapper.
      const mains = container.querySelectorAll("main");
      const main = mains[mains.length - 1] as HTMLElement;
      expect(main, `<main> must be mounted at ${path} (Task-0 layout wraps subroutes)`).not.toBeNull();
      expect(main.className).toContain("motion-safe:");
      // No transition/animation declared without the motion-safe variant gate,
      // and no duration token above 200ms anywhere on the shell tree.
      const all = container.querySelectorAll("*");
      for (const el of all) {
        const cls = (el as HTMLElement).className;
        if (typeof cls !== "string") continue;
        expect(cls).not.toMatch(/duration-(250|300|500|700|1000)/);
        expect(cls).not.toMatch(/\banimate-(spin|ping|bounce|pulse)\b/);
      }
    });
  }
});
