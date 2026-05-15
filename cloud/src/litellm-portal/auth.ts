import type { AuthResult, LiteLLMPortalEnv } from "./types";
import { verifySession, SESSION_COOKIE_NAME } from "./auth/session";
import { csv } from "./utils";

const DEFAULT_ALLOWED_EMAIL_DOMAIN = "gz-zhiyun.com";

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

// Note: CF Access JWT verification was removed post-cutover (T-12.1 PR-1). Flag guard is removed in PR-2.
// Dev-auth bypass (LITELLM_PORTAL_DEV_AUTH / x-litellm-portal-dev-email) is removed in PR-3.
export async function authenticateRequest(request: Request, env: LiteLLMPortalEnv): Promise<AuthResult> {
  const devEmail = request.headers.get("x-litellm-portal-dev-email");
  if (env.LITELLM_PORTAL_DEV_AUTH === "true" && devEmail !== null) {
    return principalFromEmail(devEmail, allowedEmailDomain(env), configuredAllowedEmails(env));
  }

  return authenticateViaSession(request, env);
}

function principalFromEmail(email: string, allowedDomain: string, allowedEmails: string[]): AuthResult {
  const normalized = email.trim().toLowerCase();
  if (!isAllowedEmail(normalized, allowedDomain, allowedEmails)) {
    return { ok: false, status: 403, error: "email_domain_forbidden" };
  }

  return {
    ok: true,
    principal: {
      email: normalized,
      userId: normalized,
      domain: emailDomain(normalized),
    },
  };
}

export function isPortalAllowedEmail(email: string, env: LiteLLMPortalEnv): boolean {
  const normalized = email.trim().toLowerCase();
  return isAllowedEmail(normalized, allowedEmailDomain(env), configuredAllowedEmails(env));
}

function isAllowedEmail(email: string, domain: string, allowedEmails: string[]): boolean {
  return email.endsWith(`@${domain}`) || allowedEmails.includes(email);
}

function allowedEmailDomain(env: LiteLLMPortalEnv): string {
  return (env.LITELLM_PORTAL_ALLOWED_EMAIL_DOMAIN?.trim() || DEFAULT_ALLOWED_EMAIL_DOMAIN).toLowerCase();
}

function configuredAllowedEmails(env: LiteLLMPortalEnv): string[] {
  return csv(env.LITELLM_PORTAL_ALLOWED_EMAILS).map((email) => email.toLowerCase());
}

function emailDomain(email: string): string {
  return email.split("@").pop() ?? "";
}
