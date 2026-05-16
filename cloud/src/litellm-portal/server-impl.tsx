import React from "react";
import { renderToReadableStream } from "react-dom/server";
import { RouterProvider } from "@tanstack/react-router";
import { I18nProvider } from "@lingui/react";
import { QueryClient, dehydrate } from "@tanstack/react-query";
import type { JsonValue, LiteLLMPortalEnv, PortalIdentity } from "./types";
import { Shell } from "./shell";
import { AppShell } from "./routes/__root";
import { portalDisplayName, portalCompanyName } from "./utils";
import { setupI18n, detectLocale } from "./i18n/setup";
import { DASHBOARD_QUERY_KEY } from "./hooks/use-dashboard";
import { ME_QUERY_KEY } from "./hooks/use-me";
import { DashboardSchema, MeSchema } from "./schemas";
import { KVUserPrefsStore } from "./preferences";
import { createPortalRouter, createMemoryHistory } from "./router";

const PREFERENCES_QUERY_KEY = ["me", "preferences"] as const;

export async function renderPortalSSR(
  env: LiteLLMPortalEnv,
  identity: PortalIdentity,
  initialData: JsonValue | null,
  nonce: string,
  requestUrl?: string,
  acceptLanguage?: string | null,
): Promise<string> {
  const title = portalDisplayName(env);

  // Resolve locale from the request's Accept-Language. The client MUST hydrate
  // with this exact locale (it reads it back from <html lang>) — re-detecting
  // from navigator.languages before hydrate causes a server/client first-render
  // divergence (React #418).
  const locale = detectLocale(acceptLanguage);
  const i18n = setupI18n(locale);

  const dataWithIdentity: JsonValue | null = initialData !== null
    ? {
        ...(initialData as Record<string, JsonValue>),
        role: identity.role,
        email: identity.email,
        litellmUserId: identity.litellmUserId,
      }
    : null;

  // Prefetch into a server-side QueryClient so the client can rehydrate without
  // re-fetching on first paint.
  let dehydratedState: unknown = undefined;
  let initialTheme: "auto" | "dark" | "light" = "auto";
  const serverQueryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: 60_000 } },
  });

  if (dataWithIdentity !== null) {
    try {
      // Seed dashboard query from already-fetched SSR data (no extra network call).
      const dashboardParsed = DashboardSchema.safeParse(dataWithIdentity);
      if (dashboardParsed.success) {
        serverQueryClient.setQueryData(DASHBOARD_QUERY_KEY, dashboardParsed.data);
      }

      // Seed me query from identity (already resolved by auth middleware).
      if (identity.email) {
        const meParsed = MeSchema.safeParse({
          email: identity.email,
          userId: identity.litellmUserId,
          company: portalCompanyName(env),
          domain: identity.domain,
          role: identity.role,
        });
        if (meParsed.success) {
          serverQueryClient.setQueryData(ME_QUERY_KEY, meParsed.data);
        }

        const preferences = await new KVUserPrefsStore(env.USER_PREFS_KV).getForEmail(identity.email);
        serverQueryClient.setQueryData(PREFERENCES_QUERY_KEY, preferences);
        initialTheme = preferences.theme;
      }

      dehydratedState = dehydrate(serverQueryClient);
    } catch {
      // If prefetch fails, client falls back to fetching on mount — acceptable.
    }
  }

  // Merge dehydratedState into the script payload so the client can rehydrate
  // without an extra round-trip. The client reads `queryClient` off the parsed JSON.
  const shellData: JsonValue | null = dataWithIdentity !== null
    ? {
        ...(dataWithIdentity as Record<string, JsonValue>),
        ...(dehydratedState !== undefined ? { queryClient: dehydratedState as JsonValue } : {}),
      }
    : null;

  // Build a memory-backed router pointing at the request URL so SSR renders
  // the correct route without a client-side redirect flash.
  //
  // TanStack Router SSR quirk: createMemoryHistory must receive the full path
  // (pathname + search) but NOT the origin; use URL.pathname when requestUrl
  // is a full URL string.
  const initialPath = (() => {
    if (!requestUrl) return "/";
    try {
      const u = new URL(requestUrl);
      return u.pathname + u.search;
    } catch {
      // requestUrl was already a path (e.g. "/admin/audit/abc")
      return requestUrl.startsWith("/") ? requestUrl : "/";
    }
  })();

  const role = identity.role === "admin" || identity.role === "user" || identity.role === "none"
    ? identity.role
    : "none";

  const history = createMemoryHistory({ initialEntries: [initialPath] });
  const router = createPortalRouter(history, { role });

  // Resolve loaders and the matched route's lazy component bundles before SSR.
  // `router.load()` waits for loaders; `preloadRoute` additionally fetches any
  // `lazyRouteComponent(...)` chunks so renderToString does not capture only the
  // Suspense fallback for admin pages.
  await router.load();
  try {
    await router.preloadRoute({ to: initialPath });
  } catch {
    // Preload is best-effort; the client will still hydrate the lazy chunk.
  }

  // renderToReadableStream (Suspense-aware) instead of renderToString:
  // renderToString aborts Suspense boundaries it encounters and emits partial
  // markup, advancing React's internal useId counter in a way that diverges
  // from the client's clean (non-suspending) hydration render. Every Base UI
  // component that calls useId() (Switch, Tabs, Dialog trigger, …) then gets a
  // different server vs client id → React #418 attribute mismatches on the
  // whole tree. renderToReadableStream waits for all Suspense boundaries to
  // resolve (allReady) before streaming, so the counter sequence is identical
  // to the client's first render.
  const stream = await renderToReadableStream(
    React.createElement(
      I18nProvider,
      { i18n },
      React.createElement(
        Shell,
        { title, nonce, initialData: shellData, initialTheme, locale },
        React.createElement(
          AppShell,
          { dehydratedState, queryClient: serverQueryClient },
          React.createElement(RouterProvider, { router }),
        ),
      ),
    ),
    // React injects the entry module itself (outside the hydrated tree) so it
    // never causes a <body>-level script/whitespace hydration mismatch. The
    // manual <script src="/portal.js"> was removed from Shell accordingly.
    { bootstrapModules: ["/portal.js"] },
  );

  // Wait for all Suspense boundaries to resolve before reading the markup.
  await stream.allReady;

  const chunks: string[] = [];
  const decoder = new TextDecoder();
  for await (const chunk of stream as AsyncIterable<Uint8Array>) {
    chunks.push(decoder.decode(chunk, { stream: true }));
  }
  chunks.push(decoder.decode());
  const markup = chunks.join("");

  return `<!doctype html>${markup}`;
}
