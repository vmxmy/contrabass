import { portalAppJs, portalBundleChunks } from "./app.generated";
import { kumoStandaloneCss } from "./kumo-css.generated";
import { authenticateRequest } from "./auth";
import { cssResponse, htmlResponse, javascriptResponse, jsonResponse, securityHeaders } from "./utils";
import { resolveIdentity } from "./roles";
import { readImpersonationCookie, verifyImpersonationToken } from "./impersonation";
import { app as honoApp, loadDashboard } from "./routes";
import { detectLeakInResponse } from "./security/leak-detector";
import { withSecurityHeaders } from "./security/headers";
import type { JsonValue, LiteLLMPortalEnv } from "./types";
import { recordMetric } from "./observability/metrics";
import { recordAudit } from "./observability/audit";
import { checkClientErrorRateLimit, recordClientError } from "./observability/client-error";
import type { ClientErrorPayload } from "./observability/client-error";
import { scanBudgetThresholds } from "./notifications";
import { runSpendSnapshotTick } from "./sync/spend-snapshot-cron";
import { runMonthlyBillingArchive } from "./sync/billing-archive-cron";
import { runIdentityReconcile } from "./sync/identity-reconcile-cron";
import { runUsageRollup } from "./usage/usage-rollup";
import { handleLiteLLMSyncBatch } from "./sync/queue-consumer";
import type { SyncMessage } from "./durable/schemas";
import { handleLoginGet, handleLoginPost, handleMagicCallback, handleLogout } from "./auth/login-routes";
import { checkCsrf } from "./auth/csrf";

export type { LiteLLMPortalEnv } from "./types";
// SQLite-backed Durable Object classes. The KV→SQLite migration is complete:
// step 1 created these and repointed the bindings; step 2 (the v4
// deleted_classes migration below) destroys the orphaned legacy KV classes, so
// the old IndexDO/TeamConfigDO/RateLimitDO exports are no longer needed.
export { RateLimitDO as RateLimitDOSQLite } from "./security/rate-limit-do";
export { IndexDO as IndexDOSQLite } from "./durable/index-do";
export { TeamConfigDO as TeamConfigDOSQLite } from "./durable/team-config-do";

const portalChunkByFileName = new Map<string, { fileName: string; js: string }>(
  portalBundleChunks.map((chunk) => [chunk.fileName, chunk]),
);

/**
 * F5/D5 — legacy-redirect single source of truth.
 *
 * This worker-layer function is THE authority for legacy `/admin/*` and
 * `/preferences` redirects: it returns a 302 on full-page navigation before
 * the SPA ever loads. The TanStack route table in
 * `routes/legacy/redirects.tsx` is the intentionally-layered SPA-side
 * fallback for client-side navigations that never reach the worker; its
 * targets must stay consistent with the mappings below. Any change here MUST
 * be mirrored there (enforced by
 * `routes/legacy/redirects-single-source.test.ts`).
 */
function legacyPortalRedirectTarget(url: URL): string | null {
  const search = url.search;
  if (url.pathname === "/preferences") return `/manage/preferences${search}`;
  if (url.pathname === "/admin" || url.pathname === "/admin/usage") return `/${search}`;
  const mappings = [
    ["/admin/users", "/manage/users"],
    ["/admin/teams", "/manage/teams"],
    ["/admin/audit", "/manage/audit"],
  ] as const;
  for (const [from, to] of mappings) {
    if (url.pathname === from || url.pathname.startsWith(`${from}/`)) {
      return `${to}${url.pathname.slice(from.length)}${search}`;
    }
  }
  if (url.pathname === "/admin/settings") return `/manage/settings${search}`;
  return null;
}

export async function handleLiteLLMPortalRequest(request: Request, env: LiteLLMPortalEnv): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: securityHeaders() });
  }

  const csrfReject = checkCsrf(request, env);
  if (csrfReject) return csrfReject;

  // Auth-bypass routes
  if (url.pathname === "/logout" && request.method === "POST") return handleLogout(request, env);
  if (url.pathname === "/login" && request.method === "GET") return handleLoginGet(request, env);
  if (url.pathname === "/login" && request.method === "POST") return handleLoginPost(request, env);
  if (url.pathname === "/magic-callback" && request.method === "GET") return handleMagicCallback(request, env);

  // Serve the portal SPA shell for all non-asset GET requests so that
  // path-based routes like /admin, /admin/users, /admin/audit/:id can be
  // directly linked and deep-linked.  Asset paths (/kumo.css, /portal.js,
  // /favicon.ico) are handled by their own branches below; /api/* goes to
  // the Hono app at the end of this handler.
  const isPortalPage =
    request.method === "GET" &&
    !url.pathname.startsWith("/api/") &&
    !url.pathname.startsWith("/portal-chunks/") &&
    url.pathname !== "/kumo.css" &&
    url.pathname !== "/portal.js" &&
    url.pathname !== "/favicon.ico";

  if (isPortalPage) {
    const redirectTarget = legacyPortalRedirectTarget(url);
    if (redirectTarget !== null) {
      return new Response(null, {
        status: 302,
        headers: {
          ...securityHeaders(),
          location: redirectTarget,
        },
      });
    }

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
          const initialData: JsonValue =
            dashboard !== null ? dashboard : { error: dashboardError ?? "dashboard_load_failed" };
          const impTok = readImpersonationCookie(request);
          const imp =
            impTok && env.PORTAL_SESSION_SECRET
              ? await verifyImpersonationToken(env.PORTAL_SESSION_SECRET, impTok, Date.now())
              : null;
          const html = await renderPortalSSR(
            env,
            identityResult.identity,
            initialData,
            nonce,
            request.url,
            request.headers.get("accept-language"),
            imp == null ? null : { realActor: imp.realActor, effectiveTeamId: imp.effectiveTeamId },
          );
          return htmlResponse(html, nonce);
        }
      }
    } catch {
      // fall through to unauthenticated shell
    }
    const html = await renderPortalSSR(
      env,
      { email: "", userId: "", domain: "", litellmUserId: "", role: "none", tenantRole: null, tenantTeamId: null },
      null,
      nonce,
      request.url,
      request.headers.get("accept-language"),
      null,
    );
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
    const scanned = url.pathname.startsWith("/api/admin/") ? await detectLeakInResponse(apiResponse) : apiResponse;
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
    payload = (await request.json()) as ClientErrorPayload;
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
      recordClientError(
        env,
        {
          message: event.message,
          stack: typeof event.stack === "string" ? event.stack : undefined,
          sessionId: event.sessionId,
          ts: typeof event.ts === "string" ? event.ts : new Date().toISOString(),
        },
        ip,
      );
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
    if (controller.cron === "* * * * *") {
      ctx.waitUntil(runSpendSnapshotTick(env));
      return;
    }
    if (controller.cron === "*/30 * * * *") {
      ctx.waitUntil(runUsageRollup(env));
      return;
    }
    if (controller.cron === "0 2 1 * *") {
      ctx.waitUntil(runMonthlyBillingArchive(env));
      return;
    }
    if (controller.cron === "15 */6 * * *") {
      ctx.waitUntil(runIdentityReconcile(env));
      return;
    }
  },
  async queue(batch, env, _ctx) {
    await handleLiteLLMSyncBatch(batch as MessageBatch<SyncMessage>, env);
  },
} satisfies ExportedHandler<LiteLLMPortalEnv>;
