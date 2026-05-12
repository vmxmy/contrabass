import React from "react";
import { renderToString } from "react-dom/server";
import { I18nProvider } from "@lingui/react";
import type { JsonValue, LiteLLMPortalEnv, PortalIdentity } from "./types";
import { Shell } from "./shell";
import { App } from "./app";
import { portalDisplayName } from "./utils";
import { detectLocale, setupI18n } from "./i18n/setup";

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

  const markup = renderToString(
    React.createElement(
      I18nProvider,
      { i18n },
      React.createElement(
        Shell,
        { title, nonce, initialData: dataWithIdentity, locale },
        React.createElement(App, {
          initialData: dataWithIdentity as import("./app").InitialDashboardData | null,
          role: identity.role,
        }),
      ),
    ),
  );

  return `<!doctype html>${markup}`;
}
