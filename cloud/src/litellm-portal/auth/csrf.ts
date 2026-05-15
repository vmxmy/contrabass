import type { LiteLLMPortalEnv } from "../types";
import { SESSION_COOKIE_NAME } from "./session";

/** Returns null on success, a Response on rejection.
 *  Validates Origin / Referer header against the request URL's origin for
 *  state-changing requests. Skipped when no session secret is configured
 *  (no browser-session auth path active) or when the request carries no
 *  session cookie (unauthenticated requests fail at the auth layer anyway). */
export function checkCsrf(request: Request, env: LiteLLMPortalEnv): Response | null {
  if (!env.PORTAL_SESSION_SECRET) return null;
  const cookieHeader = request.headers.get("Cookie") ?? "";
  if (!cookieHeader.includes(`${SESSION_COOKIE_NAME}=`)) return null;

  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return null;

  // Only exact internal-webhook paths that authenticate via shared secret are exempt.
  // Do NOT exempt the broader /api/_internal/* prefix — sibling routes like
  // /api/_internal/client-error are unauthenticated and would become a CSRF
  // spam target if exempted. Add new entries here only when the new route
  // authenticates via shared secret (not browser session).
  const requestUrl = new URL(request.url);
  if (requestUrl.pathname === "/api/_internal/role-changed") return null;

  const expectedOrigin = `${requestUrl.protocol}//${requestUrl.host}`;

  const origin = request.headers.get("Origin");
  const referer = request.headers.get("Referer");

  // Prefer Origin (more reliable). Fall back to Referer's origin component.
  if (origin) {
    if (origin === expectedOrigin) return null;
    return new Response(JSON.stringify({ error: "csrf_origin_mismatch" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (referer) {
    try {
      const refererOrigin = new URL(referer).origin;
      if (refererOrigin === expectedOrigin) return null;
    } catch {
      // malformed Referer
    }
    return new Response(JSON.stringify({ error: "csrf_referer_mismatch" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  // No Origin and no Referer: reject. Browsers always send at least Referer on
  // form/fetch POSTs to same-origin (and Origin on cross-origin).
  return new Response(JSON.stringify({ error: "csrf_missing_origin_and_referer" }), {
    status: 403,
    headers: { "Content-Type": "application/json" },
  });
}
