import { portalAppJs, portalBundleChunks } from "./app.generated";
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
import { recordMetric } from "./observability/metrics";
import { recordAudit } from "./observability/audit";
import { checkClientErrorRateLimit, recordClientError } from "./observability/client-error";
import type { ClientErrorPayload } from "./observability/client-error";
import { scanBudgetThresholds } from "./notifications";

export type { LiteLLMPortalEnv } from "./types";
export { RateLimitDO } from "./security/rate-limit-do";

const portalChunkByFileName = new Map<string, { fileName: string; js: string }>(
  portalBundleChunks.map((chunk) => [chunk.fileName, chunk]),
);

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
    !url.pathname.startsWith("/portal-chunks/") &&
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
          return htmlResponse(html, nonce);
        }
      }
    } catch {
      // fall through to unauthenticated shell
    }
    const html = await renderPortalSSR(env, { email: "", userId: "", domain: "", litellmUserId: "", role: "none" }, null, nonce, request.url);
    return htmlResponse(html, nonce);
  }

  if (request.method === "GET" && url.pathname === "/kumo.css") {
    return cssResponse(kumoStandaloneCss);
  }

  if (request.method === "GET" && url.pathname === "/portal.js") {
    return javascriptResponse(portalAppJs);
  }

  if (request.method === "GET" && url.pathname.startsWith("/portal-chunks/")) {
    const fileName = url.pathname.slice("/portal-chunks/".length);
    const chunk = portalChunkByFileName.get(fileName);
    if (chunk) {
      return javascriptResponse(chunk.js);
    }
    return new Response(null, { status: 404, headers: securityHeaders() });
  }

  if (request.method === "GET" && url.pathname === "/favicon.ico") {
    return new Response(null, { status: 204, headers: securityHeaders() });
  }

  if (!url.pathname.startsWith("/api/")) {
    return jsonResponse({ error: "not_found" }, 404);
  }

  // Client-error endpoint: no auth required, rate-limited per session
  if (request.method === "POST" && url.pathname === "/api/_internal/client-error") {
    return handleClientError(request, env);
  }

  // Delegate all /api/* requests to the typed Hono RPC app with observability wrapping.
  const apiStart = Date.now();

  // Record audit trail for admin routes before delegating to Hono.
  if (url.pathname.startsWith("/api/admin/")) {
    try {
      const auth = await authenticateRequest(request, env);
      if (auth.ok) {
        const identityResult = await resolveIdentity(env, auth.principal);
        if (identityResult.ok) {
          recordAudit(env, {
            actor: identityResult.identity.email,
            action: url.pathname,
            target: url.search ? url.search.slice(1) : "",
            ip: request.headers.get("cf-connecting-ip") ?? "unknown",
            ts: new Date().toISOString(),
          });
        }
      }
    } catch {
      // audit failure must not block the request
    }
  }

  try {
    const apiResponse = await honoApp.fetch(request, env);
    // Apply leak detector only on admin routes where master-key material could appear.
    const scanned = url.pathname.startsWith("/api/admin/")
      ? await detectLeakInResponse(apiResponse)
      : apiResponse;
    const securedResponse = withSecurityHeaders(scanned);
    recordMetric(env, {
      route: url.pathname,
      status: securedResponse.status,
      latencyMs: Date.now() - apiStart,
      upstreamMs: 0,
      role: "none",
      cacheHit: false,
    });
    return securedResponse;
  } catch (error) {
    const message = error instanceof Error ? error.message : "internal_error";
    const status = message === "litellm_config_missing" ? 500 : 502;
    recordMetric(env, {
      route: url.pathname,
      status,
      latencyMs: Date.now() - apiStart,
      upstreamMs: 0,
      role: "none",
      cacheHit: false,
    });
    return jsonResponse({ error: message }, status);
  }
}

async function handleClientError(request: Request, env: LiteLLMPortalEnv): Promise<Response> {
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  let payload: ClientErrorPayload;
  try {
    payload = await request.json() as ClientErrorPayload;
  } catch {
    return jsonResponse({ error: "invalid_json" }, 400);
  }
  if (!Array.isArray(payload?.events) || payload.events.length === 0) {
    return jsonResponse({ error: "events_required" }, 400);
  }

  const firstEvent = payload.events[0];
  const sessionId = typeof firstEvent?.sessionId === "string" ? firstEvent.sessionId : "unknown";

  if (!checkClientErrorRateLimit(sessionId)) {
    recordAudit(env, {
      actor: `session:${sessionId}`,
      action: "client_error_rate_limited",
      target: "",
      ip,
      ts: new Date().toISOString(),
    });
    return jsonResponse({ error: "rate_limited" }, 429);
  }

  for (const event of payload.events) {
    if (typeof event?.message === "string" && typeof event?.sessionId === "string") {
      recordClientError(env, {
        message: event.message,
        stack: typeof event.stack === "string" ? event.stack : undefined,
        sessionId: event.sessionId,
        ts: typeof event.ts === "string" ? event.ts : new Date().toISOString(),
      }, ip);
    }
  }

  return jsonResponse({ ok: true });
}

export default {
  fetch: handleLiteLLMPortalRequest,
  async scheduled(controller, env, ctx) {
    if (controller.cron === "0 9 * * *") {
      ctx.waitUntil(scanBudgetThresholds(env));
      return;
    }
    // "* * * * *" — reserved for the spend-snapshot mirror (PDCSOT-39 / T-5.2);
    // no handler yet. Intentional no-op to avoid blocking the cron registration.
  },
} satisfies ExportedHandler<LiteLLMPortalEnv>;
