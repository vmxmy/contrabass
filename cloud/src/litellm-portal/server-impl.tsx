import React from "react";
import { renderToString } from "react-dom/server";
import type { JsonValue, LiteLLMPortalEnv, PortalIdentity } from "./types";
import { Shell } from "./shell";
import { App } from "./app";
import { portalDisplayName } from "./utils";

export async function renderPortalSSR(
  env: LiteLLMPortalEnv,
  identity: PortalIdentity,
  initialData: JsonValue | null,
  nonce: string,
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

  const markup = renderToString(
    React.createElement(
      Shell,
      { title, nonce, initialData: dataWithIdentity },
      React.createElement(App, {
        initialData: dataWithIdentity as import("./app").InitialDashboardData | null,
        role: identity.role,
      }),
    ),
  );

  return `<!doctype html>${markup}`;
}
