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
import { detectLeakInResponse } from "./security/leak-detector";
import { withSecurityHeaders } from "./security/headers";
import type { JsonValue, LiteLLMPortalEnv } from "./types";

export type { LiteLLMPortalEnv } from "./types";
export { RateLimitDO } from "./security/rate-limit-do";

export async function handleLiteLLMPortalRequest(request: Request, env: LiteLLMPortalEnv): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: securityHeaders() });
  }

  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
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
          const html = await renderPortalSSR(env, identityResult.identity, initialData, nonce);
          return htmlResponse(html, nonce);
        }
      }
    } catch {
      // fall through to unauthenticated shell
    }
    const html = await renderPortalSSR(env, { email: "", userId: "", domain: "", litellmUserId: "", role: "none" }, null, nonce);
    return htmlResponse(html, nonce);
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
    const apiResponse = await honoApp.fetch(request, env);
    // Apply leak detector only on admin routes where master-key material could appear.
    const scanned = url.pathname.startsWith("/api/admin/")
      ? await detectLeakInResponse(apiResponse)
      : apiResponse;
    return withSecurityHeaders(scanned);
  } catch (error) {
    const message = error instanceof Error ? error.message : "internal_error";
    return jsonResponse({ error: message }, message === "litellm_config_missing" ? 500 : 502);
  }
}

export default {
  fetch: handleLiteLLMPortalRequest,
} satisfies ExportedHandler<LiteLLMPortalEnv>;
