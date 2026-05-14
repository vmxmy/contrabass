import type { LiteLLMPortalEnv } from "../types";

export const SESSION_COOKIE_NAME = "portal_session";
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Session payload encoded inside the cookie. */
export type SessionPayload = {
  email: string;
  userId: string;
  /** Issued-at, ISO 8601 timestamp. */
  iat: string;
  /** Expires-at, ISO 8601 timestamp. */
  exp: string;
};

// ---------------------------------------------------------------------------
// Private base64url helpers
// ---------------------------------------------------------------------------

function base64urlEncode(data: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(encoded: string): Uint8Array {
  // Re-pad then convert from standard base64
  const padded = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const rem = padded.length % 4;
  const repadded = rem === 0 ? padded : padded + "=".repeat(4 - rem);
  const binary = atob(repadded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Private crypto helpers
// ---------------------------------------------------------------------------

async function importKey(secret: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function signPayload(key: CryptoKey, data: string): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return new Uint8Array(sig);
}

async function verifyPayload(key: CryptoKey, data: string, sig: Uint8Array): Promise<boolean> {
  const enc = new TextEncoder();
  return crypto.subtle.verify("HMAC", key, sig, enc.encode(data));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Mint a signed session cookie value (HS256 HMAC over the JSON payload using
 *  PORTAL_SESSION_SECRET). 7-day TTL. The returned string is the cookie VALUE
 *  (caller wraps it in a Set-Cookie header with the right attributes).
 *  Throws if PORTAL_SESSION_SECRET is missing. */
export async function issueSession(
  env: LiteLLMPortalEnv,
  principal: { email: string; userId: string },
): Promise<string> {
  const secret = env.PORTAL_SESSION_SECRET;
  if (!secret) {
    throw new Error("PORTAL_SESSION_SECRET is not configured");
  }

  const now = new Date();
  const exp = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000);

  const payload: SessionPayload = {
    email: principal.email,
    userId: principal.userId,
    iat: now.toISOString(),
    exp: exp.toISOString(),
  };

  const enc = new TextEncoder();
  const payloadB64 = base64urlEncode(enc.encode(JSON.stringify(payload)));

  const key = await importKey(secret);
  const sigBytes = await signPayload(key, payloadB64);
  const sigB64 = base64urlEncode(sigBytes);

  return `${payloadB64}.${sigB64}`;
}

/** Verify a session cookie value. Returns the decoded payload on success,
 *  null on:
 *    - missing / empty cookie
 *    - bad HMAC signature
 *    - expired (exp <= now)
 *    - missing / malformed required fields
 *  Never throws on bad input. */
export async function verifySession(
  env: LiteLLMPortalEnv,
  cookieValue: string | null | undefined,
): Promise<SessionPayload | null> {
  try {
    if (!cookieValue) {
      return null;
    }

    const secret = env.PORTAL_SESSION_SECRET;
    if (!secret) {
      return null;
    }

    const dotIndex = cookieValue.lastIndexOf(".");
    if (dotIndex === -1) {
      return null;
    }

    const payloadB64 = cookieValue.slice(0, dotIndex);
    const sigB64 = cookieValue.slice(dotIndex + 1);

    if (!payloadB64 || !sigB64) {
      return null;
    }

    const key = await importKey(secret);
    const sigBytes = base64urlDecode(sigB64);
    const valid = await verifyPayload(key, payloadB64, sigBytes);
    if (!valid) {
      return null;
    }

    const dec = new TextDecoder();
    const payloadBytes = base64urlDecode(payloadB64);
    const payloadJson = dec.decode(payloadBytes);
    const payload: unknown = JSON.parse(payloadJson);

    if (
      typeof payload !== "object" ||
      payload === null ||
      typeof (payload as Record<string, unknown>).email !== "string" ||
      typeof (payload as Record<string, unknown>).userId !== "string" ||
      typeof (payload as Record<string, unknown>).iat !== "string" ||
      typeof (payload as Record<string, unknown>).exp !== "string"
    ) {
      return null;
    }

    const typed = payload as SessionPayload;

    const expTime = new Date(typed.exp).getTime();
    if (isNaN(expTime) || expTime <= Date.now()) {
      return null;
    }

    return typed;
  } catch {
    return null;
  }
}

/** Return a Set-Cookie header value that immediately expires the cookie. */
export function clearSessionHeader(): string {
  return `${SESSION_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

/** Build a Set-Cookie header value for an active session cookie. */
export function buildSessionCookieHeader(value: string, maxAgeSeconds = SESSION_TTL_SECONDS): string {
  return `${SESSION_COOKIE_NAME}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
}
