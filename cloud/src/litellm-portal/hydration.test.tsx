// @vitest-environment happy-dom

/**
 * Hydration regression guard (React #418).
 *
 * Reproduces the production incident on https://zhiyun.ziikoo.com: the SSR
 * markup and the client's first (hydration) render diverge, so React 19
 * discards the server tree and warns ("Hydration failed..." / "did not
 * match...", with the offending element). In production React is minified so
 * the only signal is the opaque #418 code. Vitest uses the React
 * **development** build, so the assertion failure names the exact element.
 *
 * This file is the permanent guard: it asserts ZERO hydration errors. The
 * absence of such a test is why two #418 incidents shipped.
 */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@lingui/react";
import { RouterProvider } from "@tanstack/react-router";
import { renderPortalSSR } from "./server-impl";
import { AppShell } from "./routes/__root";
import { Shell } from "./shell";
import { createPortalRouter, createBrowserHistory } from "./router";
import { detectLocale, setupI18n } from "./i18n/setup";
import type { LiteLLMPortalEnv, PortalIdentity } from "./types";
import type { UserPreferences } from "./schemas";

// React.act requires this flag to be set in non-RTL test environments;
// without it React logs a noisy (non-hydration) console.error on every
// update. Setting it keeps the captured console output limited to real
// hydration diagnostics.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type PortalRole = "admin" | "user" | "none";

function makeEnv(): LiteLLMPortalEnv {
  return { LITELLM_PORTAL_COMPANY_NAME: "gz-zhiyun" };
}

function makeIdentity(role: PortalRole): PortalIdentity {
  return {
    email: "operator@gz-zhiyun.com",
    userId: "u_operator",
    domain: "gz-zhiyun.com",
    litellmUserId: "litellm_operator",
    role,
  };
}

/**
 * Mirror the real client bootstrap (client.tsx): parse the #initial-data
 * script the server emitted, build a browser router, and hydrate the existing
 * #root subtree WITHOUT a seeded query client — the client only has the
 * dehydrated state, exactly the production client condition.
 */
async function hydrateLikeClient(): Promise<void> {
  const { hydrateRoot } = await import("react-dom/client");

  let dehydratedState: unknown = undefined;
  let role: PortalRole | undefined;
  const dataEl = document.getElementById("initial-data");
  if (dataEl?.textContent) {
    const parsed = JSON.parse(dataEl.textContent) as {
      queryClient?: unknown;
      role?: unknown;
    };
    dehydratedState = parsed.queryClient;
    const r = parsed.role;
    role = r === "admin" || r === "user" || r === "none" ? r : undefined;
  }

  const ssrLocale = document.documentElement.lang || null;
  const locale = detectLocale(ssrLocale);
  const i18n = setupI18n(locale);

  // Read Shell props back from the rendered DOM — mirrors client.tsx exactly.
  const title = document.title;
  const modeAttr = document.documentElement.dataset.mode;
  const initialTheme: UserPreferences["theme"] =
    modeAttr === "dark" || modeAttr === "light" ? modeAttr : "auto";
  // Read nonce from the foucScript <script> tag so it matches the server value.
  const nonceScript = document.head.querySelector("script[nonce]");
  const nonce = nonceScript?.getAttribute("nonce") ?? "";

  const history = createBrowserHistory();
  const router = createPortalRouter(history, { role });

  // Mirror the fixed client bootstrap: resolve matches before hydrateRoot so
  // the client's first render matches the server's resolved subtree (React #418
  // root cause 1: without this the router renders Suspense null vs server <main>).
  await router.load();

  // Hydrate document (not #root) with the full tree including Shell — mirrors
  // client.tsx. Shell adds one component depth level; without it every useId
  // in Base UI components is shifted by one level vs the server → id attribute
  // mismatches (React #418 root cause 2).
  await React.act(async () => {
    hydrateRoot(
      document,
      <I18nProvider i18n={i18n}>
        <Shell
          title={title}
          nonce={nonce}
          initialData={null}
          initialTheme={initialTheme}
          locale={locale}
        >
          <AppShell dehydratedState={dehydratedState}>
            <RouterProvider router={router} />
          </AppShell>
        </Shell>
      </I18nProvider>,
    );
  });
  // Flush post-hydration effects.
  await new Promise((r) => setTimeout(r, 50));
}

/**
 * Replace the live document with the SSR HTML without going through
 * documentElement.innerHTML (which would discard <html>/<head> and the
 * useId-bearing markup). Parsing the doctype+html string and adopting it
 * preserves the exact server DOM that hydrateRoot must match.
 */
function loadSsrDocument(html: string): void {
  const body = html.slice(html.indexOf("<html"));
  document.open();
  document.write(body);
  document.close();
}

describe("litellm-portal SSR hydration (#418 guard)", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  const captured: string[] = [];

  beforeEach(() => {
    captured.length = 0;
    const sink = (...args: unknown[]) => {
      captured.push(
        args.map((a) => (a instanceof Error ? `${a.message}` : String(a))).join(" "),
      );
    };
    errorSpy = vi.spyOn(console, "error").mockImplementation(sink);
    warnSpy = vi.spyOn(console, "warn").mockImplementation(sink);
  });

  afterEach(() => {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  for (const role of ["user", "admin"] as const) {
    it(`server and client first render are identical for role=${role}`, async () => {
      const env = makeEnv();
      const identity = makeIdentity(role);
      const initialData = { role } as unknown as Parameters<typeof renderPortalSSR>[2];

      const html = await renderPortalSSR(
        env,
        identity,
        initialData,
        "test-nonce",
        "http://localhost/",
        "zh-CN",
      );
      expect(html).toContain("<!doctype html>");

      loadSsrDocument(html);
      await hydrateLikeClient();

      const hydrationErrors = captured.filter(
        (m) =>
          /hydrat/i.test(m) ||
          /did not match/i.test(m) ||
          /server rendered|client/i.test(m) && /server/i.test(m) ||
          /Text content does not match/i.test(m),
      );

      if (hydrationErrors.length > 0) {
        require("node:fs").writeFileSync(
          `/tmp/h2-${role}.txt`,
          hydrationErrors.join("\n--- next ---\n"),
        );
        throw new Error(
          `React hydration mismatch (#418) for role=${role}:\n\n` +
            hydrationErrors.join("\n--- next ---\n"),
        );
      }
      expect(hydrationErrors).toEqual([]);
    });
  }
});
