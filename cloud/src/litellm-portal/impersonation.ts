/**
 * Server-authoritative impersonation primitive for the Operations Console.
 *
 * An Owner "enters a tenant" (read-write: act as tenant). The session is
 * carried by a signed, short-TTL token (HMAC-SHA256, same crypto shape as the
 * portal session cookie). The token is the transport; the IndexDO
 * `cb_index_impersonation` record is the authoritative ledger (force-exit +
 * auditable stop). Every tenant-scoped write while impersonating is attributed
 * real=OwnerId / effective=tenant(teamId) and audited with viaImpersonation.
 *
 * Timeouts (locked): 30-minute idle, 2-hour absolute cap. Each verified request
 * does NOT slide the idle window here (the slide is applied by the caller that
 * re-mints on activity — see routes.ts applyAuthMiddleware); verify only checks
 * the deadlines embedded at mint time, so this module is pure + testable.
 */

export const IMPERSONATION_COOKIE = "cb_imp";
const IDLE_MS = 30 * 60 * 1000;
const ABSOLUTE_MS = 2 * 60 * 60 * 1000;

export type ImpersonationContext = {
  viaImpersonation: true;
  realActor: string;
  effectiveTeamId: string;
  issuedAt: number;
  idleDeadline: number;
  absoluteDeadline: number;
};

type Payload = {
  realActor: string;
  effectiveTeamId: string;
  issuedAt: number;
  idleDeadline: number;
  absoluteDeadline: number;
};

function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return new Uint8Array(sig);
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function mintImpersonationToken(
  secret: string,
  input: { realActor: string; effectiveTeamId: string; now: number },
): Promise<string> {
  const payload: Payload = {
    realActor: input.realActor,
    effectiveTeamId: input.effectiveTeamId,
    issuedAt: input.now,
    idleDeadline: input.now + IDLE_MS,
    absoluteDeadline: input.now + ABSOLUTE_MS,
  };
  const body = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = b64urlEncode(await hmac(secret, body));
  return `${body}.${sig}`;
}

export async function reMintImpersonationToken(
  secret: string,
  prior: { realActor: string; effectiveTeamId: string; issuedAt: number; absoluteDeadline: number },
  now: number,
): Promise<string> {
  const payload: Payload = {
    realActor: prior.realActor,
    effectiveTeamId: prior.effectiveTeamId,
    issuedAt: prior.issuedAt,
    idleDeadline: now + IDLE_MS,
    absoluteDeadline: prior.absoluteDeadline,
  };
  const body = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = b64urlEncode(await hmac(secret, body));
  return `${body}.${sig}`;
}

export async function verifyImpersonationToken(
  secret: string,
  token: string,
  now: number,
): Promise<ImpersonationContext | null> {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = await hmac(secret, body);
  let provided: Uint8Array;
  try {
    provided = b64urlDecode(sig);
  } catch {
    return null;
  }
  if (!timingSafeEqual(expected, provided)) return null;

  let payload: Payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body))) as Payload;
  } catch {
    return null;
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  if (
    typeof payload.realActor !== "string" ||
    typeof payload.effectiveTeamId !== "string" ||
    typeof payload.idleDeadline !== "number" ||
    typeof payload.absoluteDeadline !== "number"
  ) {
    return null;
  }
  if (now > payload.idleDeadline) return null;
  if (now > payload.absoluteDeadline) return null;

  return {
    viaImpersonation: true,
    realActor: payload.realActor,
    effectiveTeamId: payload.effectiveTeamId,
    issuedAt: payload.issuedAt,
    idleDeadline: payload.idleDeadline,
    absoluteDeadline: payload.absoluteDeadline,
  };
}

export function readImpersonationCookie(req: Request): string | null {
  const raw = req.headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === IMPERSONATION_COOKIE) return v.join("=");
  }
  return null;
}

export function buildImpersonationSetCookie(token: string, maxAgeSeconds: number): string {
  return `${IMPERSONATION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

export function buildImpersonationClearCookie(): string {
  return `${IMPERSONATION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}
