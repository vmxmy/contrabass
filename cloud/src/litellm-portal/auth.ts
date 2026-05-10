import type { AccessJwtPayload, AccessJwk, AccessJwksResponse, AuthResult, LiteLLMPortalEnv, PortalPrincipal } from "./types";
import { csv } from "./utils";

const DEFAULT_ALLOWED_EMAIL_DOMAIN = "gz-zhiyun.com";
const ACCESS_JWKS_CACHE_MS = 5 * 60 * 1000;
const accessJwksCache = new Map<string, { expiresAt: number; keys: AccessJwk[] }>();

export async function authenticateRequest(request: Request, env: LiteLLMPortalEnv): Promise<AuthResult> {
  const allowedDomain = allowedEmailDomain(env);
  const allowedEmails = configuredAllowedEmails(env);
  const devEmail = request.headers.get("x-litellm-portal-dev-email");
  if (env.LITELLM_PORTAL_DEV_AUTH === "true" && devEmail !== null) {
    return principalFromEmail(devEmail, allowedDomain, allowedEmails);
  }

  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (token === null || token.trim() === "") {
    return { ok: false, status: 401, error: "access_jwt_missing" };
  }

  const config = accessConfig(env);
  if (!config.ok) {
    return { ok: false, status: 500, error: config.error };
  }

  const payload = await validateAccessJwt(token, {
    aud: config.aud,
    teamDomain: config.teamDomain,
  });
  if (payload === undefined || payload.email === undefined) {
    return { ok: false, status: 401, error: "access_jwt_invalid" };
  }

  return principalFromEmail(payload.email, allowedDomain, allowedEmails);
}

export async function validateAccessJwt(
  token: string,
  config: { aud: string; teamDomain: string },
): Promise<AccessJwtPayload | undefined> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return undefined;
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodeJwtJson(encodedHeader) as { alg?: unknown; kid?: unknown } | undefined;
  const payload = decodeJwtJson(encodedPayload) as AccessJwtPayload | undefined;
  if (
    header === undefined
    || payload === undefined
    || header.alg !== "RS256"
    || typeof header.kid !== "string"
    || payload.iss !== config.teamDomain
    || !payloadHasAudience(payload, config.aud)
    || !payloadIsTimeValid(payload)
  ) {
    return undefined;
  }

  const jwks = await getAccessJwks(config.teamDomain);
  const jwk = jwks.find((key) => key.kid === header.kid);
  if (jwk === undefined) {
    return undefined;
  }

  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const verified = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    base64UrlToBytes(encodedSignature),
    new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
  );

  return verified ? payload : undefined;
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

async function getAccessJwks(teamDomain: string): Promise<AccessJwk[]> {
  const cached = accessJwksCache.get(teamDomain);
  if (cached !== undefined && cached.expiresAt > Date.now()) {
    return cached.keys;
  }

  const response = await fetch(`${teamDomain}/cdn-cgi/access/certs`);
  if (!response.ok) {
    return [];
  }
  const body = await response.json() as AccessJwksResponse;
  const keys = Array.isArray(body.keys) ? body.keys : [];
  accessJwksCache.set(teamDomain, { expiresAt: Date.now() + ACCESS_JWKS_CACHE_MS, keys });
  return keys;
}

function accessConfig(env: LiteLLMPortalEnv): { ok: true; aud: string; teamDomain: string } | { ok: false; error: string } {
  const aud = env.CLOUDFLARE_ACCESS_AUD?.trim();
  const teamDomain = normalizeTeamDomain(env.CLOUDFLARE_ACCESS_TEAM_DOMAIN);
  if (!aud || !teamDomain) {
    return { ok: false, error: "access_config_missing" };
  }
  return { ok: true, aud, teamDomain };
}

function normalizeTeamDomain(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const withProtocol = /^https?:\/\//u.test(trimmed) ? trimmed : `https://${trimmed}`;
  return withProtocol.replace(/\/+$/u, "");
}

function decodeJwtJson(encoded: string): unknown | undefined {
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlToBytes(encoded)));
  } catch {
    return undefined;
  }
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/gu, "+").replace(/_/gu, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function payloadHasAudience(payload: AccessJwtPayload, expectedAud: string): boolean {
  if (typeof payload.aud === "string") {
    return payload.aud === expectedAud;
  }
  return Array.isArray(payload.aud) && payload.aud.includes(expectedAud);
}

function payloadIsTimeValid(payload: AccessJwtPayload): boolean {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return typeof payload.exp === "number"
    && payload.exp > nowSeconds
    && (payload.nbf === undefined || payload.nbf <= nowSeconds);
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
