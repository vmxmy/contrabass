import React from "react";
import { renderToString } from "react-dom/server";
import { I18nProvider } from "@lingui/react";
import { QueryClient, dehydrate } from "@tanstack/react-query";
import type { JsonValue, LiteLLMPortalEnv, PortalIdentity } from "./types";
import { Shell } from "./shell";
import { App } from "./app";
import { portalDisplayName, portalCompanyName } from "./utils";
import { detectLocale, setupI18n } from "./i18n/setup";
import { DASHBOARD_QUERY_KEY } from "./hooks/use-dashboard";
import { ME_QUERY_KEY } from "./hooks/use-me";
import { DashboardSchema, MeSchema } from "./schemas";

export async function renderPortalSSR(
  env: LiteLLMPortalEnv,
  identity: PortalIdentity,
  initialData: JsonValue | null,
  nonce: string,
  request?: Request,
): Promise<string> {
  const title = portalDisplayName(env);

  const acceptLanguage = request?.headers.get("accept-language") ?? null;
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
  if (dataWithIdentity !== null) {
    try {
      const serverQueryClient = new QueryClient({
        defaultOptions: { queries: { staleTime: 60_000 } },
      });

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
  const shellData: import("./types").JsonValue | null = dataWithIdentity !== null
    ? {
        ...(dataWithIdentity as Record<string, import("./types").JsonValue>),
        ...(dehydratedState !== undefined ? { queryClient: dehydratedState as import("./types").JsonValue } : {}),
      }
    : null;

  const markup = renderToString(
    React.createElement(
      I18nProvider,
      { i18n },
      React.createElement(
        Shell,
        { title, nonce, initialData: shellData, locale },
        React.createElement(App, {
          initialData: dataWithIdentity as import("./app").InitialDashboardData | null,
          role: identity.role,
          dehydratedState,
        }),
      ),
    ),
  );

  return `<!doctype html>${markup}`;
}
