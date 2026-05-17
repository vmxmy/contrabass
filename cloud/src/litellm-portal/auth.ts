import type { AuthResult, LiteLLMPortalEnv } from "./types";
import { verifySession, SESSION_COOKIE_NAME } from "./auth/session";

async function authenticateViaSession(request: Request, env: LiteLLMPortalEnv): Promise<AuthResult> {
  const cookieHeader = request.headers.get("Cookie") ?? "";
  const parts = cookieHeader.split(";").map((p) => p.trim());
  const target = `${SESSION_COOKIE_NAME}=`;
  const entry = parts.find((p) => p.startsWith(target));
  if (entry === undefined) {
    return { ok: false, status: 401, error: "missing_session_cookie" };
  }
  const value = entry.slice(target.length);
  const payload = await verifySession(env, value);
  if (payload === null) {
    return { ok: false, status: 401, error: "invalid_session" };
  }
  const atIdx = payload.email.indexOf("@");
  const domain = atIdx === -1 ? "" : payload.email.slice(atIdx + 1).toLowerCase();
  return {
    ok: true,
    principal: {
      email: payload.email,
      userId: payload.userId,
      domain,
    },
  };
}

function authenticateViaCfAccess(request: Request, env: LiteLLMPortalEnv): AuthResult | null {
  const email = request.headers.get("cf-access-authenticated-user-email");
  if (!email) return null;
  const allowed = env.LITELLM_PORTAL_ALLOWED_EMAILS
    ? new Set(env.LITELLM_PORTAL_ALLOWED_EMAILS.split(",").map((e) => e.trim().toLowerCase()))
    : null;
  if (allowed !== null && !allowed.has(email.toLowerCase())) {
    return { ok: false, status: 401, error: "email_not_allowed" };
  }
  if (!allowed) return null;
  const atIdx = email.indexOf("@");
  const domain = atIdx === -1 ? "" : email.slice(atIdx + 1).toLowerCase();
  return { ok: true, principal: { email, userId: email, domain } };
}

export async function authenticateRequest(request: Request, env: LiteLLMPortalEnv): Promise<AuthResult> {
  const cfResult = authenticateViaCfAccess(request, env);
  if (cfResult !== null) return cfResult;
  return authenticateViaSession(request, env);
}

export { isEmailAllowed as isPortalAllowedEmail } from "./auth/allowlist";
