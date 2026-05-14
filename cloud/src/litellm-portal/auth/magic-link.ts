import type { LiteLLMPortalEnv } from "../types";
import type { IndexDO } from "../durable/index-do";
import type { MagicLinkNonce } from "../durable/schemas";

/** TTL for magic-link tokens, in seconds (15 minutes). */
export const MAGIC_LINK_TTL_SECONDS = 15 * 60;

// ---------------------------------------------------------------------------
// Private payload type
// ---------------------------------------------------------------------------

type MagicLinkPayload = {
  email: string;
  /** Issued-at, ISO 8601. */
  iat: string;
  /** Expires-at, ISO 8601. */
  exp: string;
  /** Random nonce token. */
  nonce: string;
};

// ---------------------------------------------------------------------------
// Private base64url helpers (mirrored from session.ts — not imported)
// ---------------------------------------------------------------------------

function base64urlEncode(data: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(encoded: string): Uint8Array {
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
// Private crypto helpers (mirrored from session.ts — not imported)
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
// Public API: issueMagicLink
// ---------------------------------------------------------------------------

/** Mint a single-use HMAC-signed magic-link token + store the nonce in
 *  IndexDO so the corresponding `verifyMagicLink` can detect replay.
 *  Returns the token string the caller embeds in the magic-link URL.
 *  Throws if PORTAL_MAGIC_LINK_SECRET is missing or if INDEX_DO is unbound. */
export async function issueMagicLink(
  env: LiteLLMPortalEnv,
  email: string,
): Promise<string> {
  if (typeof email !== "string" || !email.includes("@")) {
    throw new Error("issueMagicLink: email must be a non-empty string containing '@'");
  }

  const secret = env.PORTAL_MAGIC_LINK_SECRET;
  if (!secret) {
    throw new Error("PORTAL_MAGIC_LINK_SECRET is not configured");
  }

  if (!env.INDEX_DO) {
    throw new Error("INDEX_DO is not bound");
  }

  const now = new Date();
  const exp = new Date(now.getTime() + MAGIC_LINK_TTL_SECONDS * 1000);
  const nonce = crypto.randomUUID();

  const payloadObj: MagicLinkPayload = {
    email,
    iat: now.toISOString(),
    exp: exp.toISOString(),
    nonce,
  };

  const enc = new TextEncoder();
  const payloadB64 = base64urlEncode(enc.encode(JSON.stringify(payloadObj)));

  const key = await importKey(secret);
  const sigBytes = await signPayload(key, payloadB64);
  const sigB64 = base64urlEncode(sigBytes);

  const token = `${payloadB64}.${sigB64}`;

  const idxStub = env.INDEX_DO.get(env.INDEX_DO.idFromName("index")) as unknown as IndexDO;
  await idxStub.storeNonce({
    token: nonce,
    email,
    expiresAt: exp.toISOString(),
    consumedAt: null,
  } satisfies MagicLinkNonce);

  return token;
}

// ---------------------------------------------------------------------------
// Public API: verifyMagicLink
// ---------------------------------------------------------------------------

/** Verify a magic-link token end-to-end:
 *   1. Parse + verify HMAC signature against PORTAL_MAGIC_LINK_SECRET.
 *   2. Check expiry (15-min TTL encoded in payload).
 *   3. Consume the nonce in IndexDO (atomic single-use via existing IndexDO.consumeNonce).
 *  Returns the email on success, null on ANY failure (bad sig, expired,
 *  already consumed, missing fields, missing config). Never throws. */
export async function verifyMagicLink(
  env: LiteLLMPortalEnv,
  token: string | null | undefined,
): Promise<{ email: string } | null> {
  try {
    if (!token) {
      return null;
    }

    const secret = env.PORTAL_MAGIC_LINK_SECRET;
    if (!secret || !env.INDEX_DO) {
      return null;
    }

    const dotIndex = token.lastIndexOf(".");
    if (dotIndex === -1) {
      return null;
    }

    const payloadB64 = token.slice(0, dotIndex);
    const sigB64 = token.slice(dotIndex + 1);

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
    const parsed: unknown = JSON.parse(payloadJson);

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as Record<string, unknown>).email !== "string" ||
      typeof (parsed as Record<string, unknown>).iat !== "string" ||
      typeof (parsed as Record<string, unknown>).exp !== "string" ||
      typeof (parsed as Record<string, unknown>).nonce !== "string"
    ) {
      return null;
    }

    const payload = parsed as MagicLinkPayload;

    const expTime = new Date(payload.exp).getTime();
    if (isNaN(expTime) || expTime <= Date.now()) {
      return null;
    }

    const idxStub = env.INDEX_DO.get(env.INDEX_DO.idFromName("index")) as unknown as IndexDO;
    const consumed = await idxStub.consumeNonce(payload.nonce);
    if (consumed === null) {
      return null;
    }

    if (consumed.email !== payload.email) {
      return null;
    }

    return { email: payload.email };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// sendMagicLink
// ---------------------------------------------------------------------------

/** Send a magic-link email via MailChannels.
 *  POSTs to https://api.mailchannels.net/tx/v1/send.
 *  On a non-2xx response, throws an Error so the caller can return 5xx
 *  to the user. Never swallows transport errors. */
export async function sendMagicLink(
  env: LiteLLMPortalEnv,
  options: {
    /** Recipient email address. */
    email: string;
    /** Absolute URL the user clicks to consume the magic-link nonce. */
    link: string;
    /** From address. Should match a DNS-verified sender domain. */
    from?: string;
    /** Optional company / display name for the email body. */
    companyName?: string;
  },
): Promise<void> {
  const fromEmail = options.from ?? "no-reply@gz-zhiyun.com"; // TODO: replace with a configurable env var in a follow-up
  const fromName = env.LITELLM_PORTAL_DISPLAY_NAME ?? "Portal Sign-in";
  const companyName = options.companyName ?? "the portal";
  const subject = `Sign in to ${companyName}`;

  const plainBody = [
    "Click the link below to sign in. It expires in 15 minutes.",
    "",
    options.link,
    "",
    "If you did not request this, ignore this email.",
  ].join("\n");

  const htmlBody = [
    "<!DOCTYPE html>",
    "<html><body>",
    "<p>Click the link below to sign in. It expires in 15 minutes.</p>",
    `<p><a href="${options.link}">${options.link}</a></p>`,
    "<p>If you did not request this, ignore this email.</p>",
    "</body></html>",
  ].join("\n");

  const payload = {
    personalizations: [{ to: [{ email: options.email }] }],
    from: { email: fromEmail, name: fromName },
    subject,
    content: [
      { type: "text/plain", value: plainBody },
      { type: "text/html", value: htmlBody },
    ],
  };

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (env.MAILCHANNELS_API_KEY) {
    headers["X-Api-Key"] = env.MAILCHANNELS_API_KEY;
  }

  const response = await fetch("https://api.mailchannels.net/tx/v1/send", {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const snippet = await response
      .text()
      .then((t) => t.slice(0, 200))
      .catch(() => "");
    throw new Error(
      `MailChannels send failed: HTTP ${response.status} — ${snippet}`,
    );
  }
}
