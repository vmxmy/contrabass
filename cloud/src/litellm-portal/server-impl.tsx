import React from "react";
import { renderToString } from "react-dom/server";
import { RouterProvider } from "@tanstack/react-router";
import { QueryClient, dehydrate } from "@tanstack/react-query";
import type { JsonValue, LiteLLMPortalEnv, PortalIdentity } from "./types";
import { Shell } from "./shell";
import { AppShell } from "./routes/__root";
import { portalDisplayName } from "./utils";
import { DASHBOARD_QUERY_KEY } from "./hooks/use-dashboard";
import { ME_QUERY_KEY } from "./hooks/use-me";
import { DashboardSchema, MeSchema } from "./schemas";
import { portalCompanyName } from "./utils";
import { createPortalRouter, createMemoryHistory } from "./router";

export async function renderPortalSSR(
  env: LiteLLMPortalEnv,
  identity: PortalIdentity,
  initialData: JsonValue | null,
  nonce: string,
  requestUrl?: string,
): Promise<string> {
  const title = portalDisplayName(env);

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

  // Let the router resolve the matched route before rendering to string.
  await router.load();

  const markup = renderToString(
    React.createElement(
      Shell,
      { title, nonce, initialData: shellData },
      React.createElement(
        AppShell,
        { dehydratedState },
        React.createElement(RouterProvider, { router }),
      ),
    ),
  );

  return `<!doctype html>${markup}`;
}
