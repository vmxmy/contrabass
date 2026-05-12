import { portalAppJs } from "./app.generated";
import { kumoStandaloneCss } from "./kumo-css.generated";
import { authenticateRequest } from "./auth";
import {
  cssResponse,
  htmlResponse,
  javascriptResponse,
  jsonResponse,
  securityHeaders,
} from "./utils";
import { resolveIdentity } from "./roles";
import { app as honoApp, loadDashboard } from "./routes";
import type { JsonValue, LiteLLMPortalEnv } from "./types";

export type { LiteLLMPortalEnv } from "./types";

export async function handleLiteLLMPortalRequest(request: Request, env: LiteLLMPortalEnv): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: securityHeaders() });
  }

  // Serve the portal SPA shell for all non-asset GET requests so that
  // path-based routes like /admin, /admin/users, /admin/audit/:id can be
  // directly linked and deep-linked.  Asset paths (/kumo.css, /portal.js,
  // /favicon.ico) are handled by their own branches below; /api/* goes to
  // the Hono app at the end of this handler.
  const isPortalPage = request.method === "GET" &&
    !url.pathname.startsWith("/api/") &&
    url.pathname !== "/kumo.css" &&
    url.pathname !== "/portal.js" &&
    url.pathname !== "/favicon.ico";

  if (isPortalPage) {
    const nonce = crypto.randomUUID().replace(/-/g, "");
    const { renderPortalSSR } = await import("./server");
    try {
      const auth = await authenticateRequest(request, env);
      if (auth.ok) {
        const identityResult = await resolveIdentity(env, auth.principal);
        if (identityResult.ok) {
          let dashboard: Record<string, JsonValue> | null = null;
          let dashboardError: string | null = null;
          try {
            dashboard = await loadDashboard(env, identityResult.identity);
          } catch (err) {
            dashboardError = err instanceof Error ? err.message : "dashboard_load_failed";
          }
          const initialData: JsonValue = dashboard !== null
            ? dashboard
            : { error: dashboardError ?? "dashboard_load_failed" };
          const html = await renderPortalSSR(env, identityResult.identity, initialData, nonce, request.url);
          return htmlResponse(html);
        }
      }
    } catch {
      // fall through to unauthenticated shell
    }
    const html = await renderPortalSSR(env, { email: "", userId: "", domain: "", litellmUserId: "", role: "none" }, null, nonce, request.url);
    return htmlResponse(html);
  }

  if (request.method === "GET" && url.pathname === "/kumo.css") {
    return cssResponse(kumoStandaloneCss);
  }

  if (request.method === "GET" && url.pathname === "/portal.js") {
    return javascriptResponse(portalAppJs);
  }

  if (request.method === "GET" && url.pathname === "/favicon.ico") {
    return new Response(null, { status: 204, headers: securityHeaders() });
  }

  if (!url.pathname.startsWith("/api/")) {
    return jsonResponse({ error: "not_found" }, 404);
  }

  // Delegate all /api/* requests to the typed Hono RPC app.
  // The Hono app handles auth middleware, identity resolution, Zod validation,
  // and schema-validated responses internally.
  try {
    return await honoApp.fetch(request, env);
  } catch (error) {
    const message = error instanceof Error ? error.message : "internal_error";
    return jsonResponse({ error: message }, message === "litellm_config_missing" ? 500 : 502);
  }
}

export default {
  fetch: handleLiteLLMPortalRequest,
} satisfies ExportedHandler<LiteLLMPortalEnv>;
