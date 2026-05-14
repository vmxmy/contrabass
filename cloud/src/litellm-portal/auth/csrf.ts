import type { LiteLLMPortalEnv } from "../types";

/** Returns null on success, a Response on rejection.
 *  Validates Origin / Referer header against the request URL's origin for
 *  state-changing requests. Only enforced when PORTAL_DO_SOT_ENABLED is "true". */
export function checkCsrf(request: Request, env: LiteLLMPortalEnv): Response | null {
  if (env.PORTAL_DO_SOT_ENABLED !== "true") return null;

  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return null;

  // Internal webhook paths authenticate via shared secret, not browser session.
  const requestUrl = new URL(request.url);
  if (requestUrl.pathname.startsWith("/_internal/")) return null;

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
