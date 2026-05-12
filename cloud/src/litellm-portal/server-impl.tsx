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

  const markup = renderToString(
    React.createElement(
      Shell,
      { title, nonce, initialData },
      React.createElement(App, {
        initialData: initialData as import("./app").InitialDashboardData | null,
        role: identity.role,
      }),
    ),
  );

  return `<!doctype html>${markup}`;
}
