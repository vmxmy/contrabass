import type { LiteLLMPortalEnv } from "../types";
import { isEmailAllowed } from "./allowlist";
import { issueMagicLink, sendMagicLink, verifyMagicLink } from "./magic-link";
import { issueSession, buildSessionCookieHeader, clearSessionHeader } from "./session";
import { resolveLiteLLMUser } from "../litellm";
import { enqueueSync } from "../sync/queue-producer";
import { invalidateRole } from "../role-cache";
import { resolveIdentity } from "../roles";

// ---------------------------------------------------------------------------
// SANCTIONED local style constants (spec §D.2). /login is a standalone SSR
// HTML document rendered OUTSIDE the Kumo runtime (no React, no Kumo utility
// class can apply here), so its inline <style> uses these self-contained,
// Kumo-visually-aligned, DETERMINISTIC hex constants. This is the documented
// per-page exception — directly analogous to the Phase-3 §F.6 ops-theme
// sanctioned-exception (named consts in lieu of unreachable design tokens).
// No other raw hex on this page; NO Math.random; presentation-only with zero
// auth-logic coupling. Dark counterparts back the prefers-color-scheme block.
// ---------------------------------------------------------------------------

const LOGIN_STYLE = {
  bg: "#fafafa",
  card: "#ffffff",
  border: "#e5e5e5",
  ink: "#1a1a1a",
  subtle: "#555555",
  brand: "#1f3a8a",
  brandHover: "#162a63",
  onBrand: "#ffffff",      // #ffffff on brand #1f3a8a ≈ 9.7:1 — WCAG AA ✓
  error: "#b42318",
  success: "#177245",
  dBg: "#1a1a1a",
  dCard: "#242424",
  dBorder: "#3a3a3a",
  dInk: "#f4f4f4",
  dSubtle: "#a0a0a0",
  dError: "#f0a8a0",       // #f0a8a0 on dCard #242424 ≈ 7.99:1 — WCAG AA ✓
  dSuccess: "#7fc8a0",     // #7fc8a0 on dCard #242424 ≈ 7.89:1 — WCAG AA ✓
} as const;

// ---------------------------------------------------------------------------
// Inline IndexDO stub type (avoids pulling DO module into test transform chain)
// ---------------------------------------------------------------------------

type IndexDOInitStub = { init(): Promise<{ ok: true; imported: boolean }> };

// Singleflight + failure-backoff state for ensurePortalDOInitialized.
// A single isolate may receive many concurrent requests; without singleflight
// each one would independently drive an expensive IndexDO.init() import.
let _initInFlight: Promise<void> | null = null;
let _initFailedAt: number | null = null;
const INIT_BACKOFF_MS = 30_000; // 30 s cooldown after a failure

async function ensurePortalDOInitialized(env: LiteLLMPortalEnv): Promise<void> {
  if (!env.INDEX_DO) return;

  // Backoff: if init failed recently, skip to avoid hammering the DO.
  if (_initFailedAt !== null && Date.now() - _initFailedAt < INIT_BACKOFF_MS) return;

  // Singleflight: share one in-flight init promise across concurrent callers.
  if (_initInFlight !== null) {
    await _initInFlight;
    return;
  }

  const indexDO = env.INDEX_DO;
  _initInFlight = (async () => {
    try {
      const idxStub = indexDO.get(indexDO.idFromName("index")) as unknown as IndexDOInitStub;
      await idxStub.init();
      _initFailedAt = null;
    } catch (err) {
      _initFailedAt = Date.now();
      // Don't block login on init failure; log + continue. UI will show empty state until ops re-trigger init.
      console.error("[auth] IndexDO.init() failed:", err);
    } finally {
      _initInFlight = null;
    }
  })();

  await _initInFlight;
}

type IndexDOStub = {
  getUserByEmail(email: string): Promise<{
    userId: string;
    email: string;
    role: "admin" | "user";
    teamId: string | null;
    maxBudget?: number;
    createdAt: string;
  } | null>;
  putUser(record: {
    userId: string;
    email: string;
    role: "admin" | "user";
    teamId: string | null;
    maxBudget?: number;
    createdAt: string;
  }): Promise<void>;
  getInvite(emailLc: string): Promise<{
    emailLc: string;
    teamId: string;
    teamRole: "admin" | "user";
    status: "pending" | "consumed" | "revoked";
    invitedBy: string;
    createdAt: string;
    consumedAt: string | null;
  } | null>;
  markInviteConsumed(emailLc: string): Promise<unknown>;
  putTenantRole(record: {
    userId: string;
    teamId: string;
    tenantRole: "tenant_admin" | "member";
    updatedBy: string;
    updatedAt: string;
  }): Promise<unknown>;
};

function parseBootstrapAdminEmails(env: LiteLLMPortalEnv): Set<string> {
  if (!env.BOOTSTRAP_ADMIN_EMAILS?.trim()) return new Set();
  return new Set(
    env.BOOTSTRAP_ADMIN_EMAILS.split(",")
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.length > 0),
  );
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 1) {
    return email;
  }
  return `${email[0]}***${email.slice(at)}`;
}

function loginPage(errorMsg?: string, successEmail?: string): string {
  const formSection = successEmail
    ? `<p class="success">Check your inbox at ${maskEmail(successEmail)}. The link expires in 15 minutes.</p>`
    : `
      ${errorMsg ? `<p class="error">${errorMsg}</p>` : ""}
      <form method="POST" action="/login">
        <label for="email">Email address</label>
        <input type="email" id="email" name="email" required autocomplete="email" />
        <button type="submit">Send magic link</button>
      </form>`;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Sign in</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      padding: 1.5rem;
      background: ${LOGIN_STYLE.bg};
      color: ${LOGIN_STYLE.ink};
    }
    .card {
      background: ${LOGIN_STYLE.card};
      border: 1px solid ${LOGIN_STYLE.border};
      border-radius: 14px;
      padding: 2.5rem;
      width: 100%;
      max-width: 384px;
    }
    h1 { font-size: 1.5rem; font-weight: 600; margin: 0 0 1.75rem; color: ${LOGIN_STYLE.ink}; }
    label { display: block; font-size: .875rem; font-weight: 500; margin-bottom: .5rem; color: ${LOGIN_STYLE.subtle}; }
    input[type="email"] {
      display: block;
      width: 100%;
      padding: .625rem .75rem;
      border: 1px solid ${LOGIN_STYLE.border};
      border-radius: 8px;
      font-size: 1rem;
      color: ${LOGIN_STYLE.ink};
      background: ${LOGIN_STYLE.card};
      margin-bottom: 1.25rem;
    }
    button {
      width: 100%;
      padding: .6875rem;
      background: ${LOGIN_STYLE.brand};
      color: ${LOGIN_STYLE.onBrand};
      border: 1px solid ${LOGIN_STYLE.brand};
      border-radius: 8px;
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
      transition: background-color 150ms ease;
    }
    button:hover { background: ${LOGIN_STYLE.brandHover}; border-color: ${LOGIN_STYLE.brandHover}; }
    input:focus-visible, button:focus-visible {
      outline: 2px solid ${LOGIN_STYLE.brand};
      outline-offset: 2px;
    }
    .error { color: ${LOGIN_STYLE.error}; font-size: .875rem; margin-bottom: .75rem; }
    .success { color: ${LOGIN_STYLE.success}; font-size: .9375rem; }
    @media (prefers-reduced-motion: reduce) {
      button { transition: none; }
    }
    @media (prefers-color-scheme: dark) {
      body { background: ${LOGIN_STYLE.dBg}; color: ${LOGIN_STYLE.dInk}; }
      .card { background: ${LOGIN_STYLE.dCard}; border-color: ${LOGIN_STYLE.dBorder}; }
      h1 { color: ${LOGIN_STYLE.dInk}; }
      label { color: ${LOGIN_STYLE.dSubtle}; }
      input[type="email"] {
        background: ${LOGIN_STYLE.dCard};
        border-color: ${LOGIN_STYLE.dBorder};
        color: ${LOGIN_STYLE.dInk};
      }
      .error { color: ${LOGIN_STYLE.dError}; }
      .success { color: ${LOGIN_STYLE.dSuccess}; }
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>Sign in</h1>
    ${formSection}
  </div>
</body>
</html>`;
}

function expiredLinkPage(): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Link expired</title>
  <style>
    body { font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f5f5f5; }
    .card { background: #fff; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,.12); padding: 2rem; max-width: 360px; width: 100%; }
    p { font-size: .9375rem; }
    a { color: #0f62fe; }
  </style>
</head>
<body>
  <div class="card">
    <p>This sign-in link is invalid or has expired. <a href="/login">Try again</a>.</p>
  </div>
</body>
</html>`;
}

function htmlResp(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

export async function handleLoginGet(_request: Request, _env: LiteLLMPortalEnv): Promise<Response> {
  return htmlResp(loginPage());
}

// ---------------------------------------------------------------------------
// Login rate-limit helper
// Max 3 magic-link sends per email per 5 minutes,
// max 10 per IP per 5 minutes.
// Uses RATE_LIMIT_DO when available; falls back to a per-isolate in-memory
// map as a soft brake (note: in-memory state is not shared across isolates).
// ---------------------------------------------------------------------------

const LOGIN_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const LOGIN_MAX_PER_EMAIL = 3;
const LOGIN_MAX_PER_IP = 10;

// Per-isolate fallback store: key → sorted array of timestamps
const _loginRateLimitStore = new Map<string, number[]>();

function _checkMemoryLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const windowStart = now - windowMs;
  const timestamps = (_loginRateLimitStore.get(key) ?? []).filter((ts) => ts > windowStart);
  if (timestamps.length >= max) {
    _loginRateLimitStore.set(key, timestamps);
    return false;
  }
  timestamps.push(now);
  _loginRateLimitStore.set(key, timestamps);
  return true;
}

async function checkLoginRateLimit(
  env: LiteLLMPortalEnv,
  email: string,
  ip: string,
): Promise<boolean> {
  const emailKey = `login:email:${email.toLowerCase()}`;
  const ipKey = `login:ip:${ip}`;

  if (env.RATE_LIMIT_DO) {
    const doId = env.RATE_LIMIT_DO.idFromName("login-rate-limit");
    const stub = env.RATE_LIMIT_DO.get(doId);
    const params = `windowMs=${LOGIN_WINDOW_MS}`;

    const [emailResp, ipResp] = await Promise.all([
      stub.fetch(
        new Request(
          `https://rate-limit-do/check?key=${encodeURIComponent(emailKey)}&${params}&max=${LOGIN_MAX_PER_EMAIL}`,
        ),
      ),
      stub.fetch(
        new Request(
          `https://rate-limit-do/check?key=${encodeURIComponent(ipKey)}&${params}&max=${LOGIN_MAX_PER_IP}`,
        ),
      ),
    ]);

    return emailResp.status !== 429 && ipResp.status !== 429;
  }

  // Fallback: in-memory per-isolate soft brake
  const emailOk = _checkMemoryLimit(emailKey, LOGIN_MAX_PER_EMAIL, LOGIN_WINDOW_MS);
  const ipOk = _checkMemoryLimit(ipKey, LOGIN_MAX_PER_IP, LOGIN_WINDOW_MS);
  return emailOk && ipOk;
}

export async function handleLoginPost(request: Request, env: LiteLLMPortalEnv): Promise<Response> {
  // Step 1: parse form body
  let email: string;
  try {
    const form = await request.formData();
    const raw = form.get("email");
    email = typeof raw === "string" ? raw.trim() : "";
  } catch {
    return htmlResp(loginPage("Invalid email"), 400);
  }

  // Step 2: validate email format — return 400 so the UX can correct it.
  if (!email || !email.includes("@") || email.length > 320) {
    return htmlResp(loginPage("Invalid email"), 400);
  }

  // From here on: ALWAYS return the same generic 200 "check inbox" response
  // regardless of allow-list / rate-limit / send-failure outcome. The reason
  // is logged server-side only.
  const genericSuccess = htmlResp(loginPage(undefined, email));

  // Step 3: allow-list check (silent — failure indistinguishable from success to caller)
  if (!isEmailAllowed(email, env)) {
    console.warn("[login] email not in allow-list:", email);
    return genericSuccess;
  }

  // Step 4: rate-limit check (silent on exceed)
  const clientIp =
    request.headers.get("CF-Connecting-IP") ??
    request.headers.get("X-Forwarded-For") ??
    "unknown";
  const allowed = await checkLoginRateLimit(env, email, clientIp);
  if (!allowed) {
    console.warn("[login] rate-limit exceeded for:", email, clientIp);
    return genericSuccess;
  }

  // Step 5: trigger IndexDO init now that cheap rejections have passed
  await ensurePortalDOInitialized(env);

  // Issue token + send
  try {
    const token = await issueMagicLink(env, email);
    const requestUrl = new URL(request.url);
    const link = `${requestUrl.origin}/magic-callback?token=${encodeURIComponent(token)}`;
    await sendMagicLink(env, {
      email,
      link,
      companyName: env.LITELLM_PORTAL_COMPANY_NAME ?? "the portal",
    });
  } catch (err) {
    console.error("[login] magic-link issue or send failed:", err);
    // Still return generic success — don't leak server state.
  }

  return genericSuccess;
}

export async function handleMagicCallback(request: Request, env: LiteLLMPortalEnv): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");

  // Reject obviously invalid tokens before triggering IndexDO init.
  if (!token || token.length < 8) {
    return htmlResp(expiredLinkPage(), 400);
  }

  // Token shape looks plausible — initialize DO before verifying.
  await ensurePortalDOInitialized(env);

  const result = await verifyMagicLink(env, token);
  if (result === null) {
    return htmlResp(expiredLinkPage(), 400);
  }

  const { email } = result;
  const emailLc = email.toLowerCase();

  let userId: string;
  try {
    if (!env.INDEX_DO) {
      return htmlResp(expiredLinkPage(), 500);
    }
    const idxStub = env.INDEX_DO.get(env.INDEX_DO.idFromName("index")) as unknown as IndexDOStub;
    const existing = await idxStub.getUserByEmail(emailLc);

    if (existing) {
      userId = existing.userId;
    } else {
      const bootstrap = parseBootstrapAdminEmails(env);
      const role: "admin" | "user" = bootstrap.has(emailLc) ? "admin" : "user";
      // Prefer the canonical LiteLLM user_id so self-scope usage queries
      // line up with LiteLLM's own user records. Fall back to the email only
      // when LiteLLM does not yet know this user (no stable id available).
      let resolvedUserId = emailLc;
      try {
        const litellmUser = await resolveLiteLLMUser(env, emailLc);
        if (litellmUser.found && litellmUser.userId.trim().length > 0) {
          resolvedUserId = litellmUser.userId.trim();
        }
      } catch {
        // LiteLLM unavailable / not configured — keep the email fallback.
      }
      const newRecord = {
        userId: resolvedUserId,
        email: emailLc,
        role,
        teamId: null,
        createdAt: new Date().toISOString(),
      };
      await idxStub.putUser(newRecord);
      userId = newRecord.userId;
    }
  } catch {
    return htmlResp(expiredLinkPage(), 500);
  }

  // Admin-invite auto-join. Fail-open: an invite/DO/LiteLLM error here must
  // never block a successful login (mirrors role-cache fail-open philosophy).
  try {
    if (env.INDEX_DO) {
      const inviteStub = env.INDEX_DO.get(env.INDEX_DO.idFromName("index")) as unknown as IndexDOStub;
      const invite = await inviteStub.getInvite(emailLc);
      if (invite && invite.status === "pending") {
        const current = await inviteStub.getUserByEmail(emailLc);
        if (current && current.teamId !== invite.teamId) {
          await inviteStub.putUser({ ...current, teamId: invite.teamId });
          // Best-effort reconcile to LiteLLM; enqueueSync never throws.
          await enqueueSync(env, {
            kind: "user.update",
            entityId: current.userId,
            payload: { user_id: current.userId, team_id: invite.teamId },
          });
        }
        // Idempotent: only a pending invite is consumed.
        await inviteStub.markInviteConsumed(emailLc);
        // Seed tenantRole from invite.teamRole. Best-effort: never blocks login.
        // Keys on the IndexDO user-record `userId`; the read counterpart is
        // role-cache.ts resolveTenantRole (must stay the same (userId,teamId) tuple).
        try {
          await inviteStub.putTenantRole({
            userId,
            teamId: invite.teamId,
            tenantRole: invite.teamRole === "admin" ? "tenant_admin" : "member",
            updatedBy: `invite:${invite.invitedBy}`,
            updatedAt: new Date().toISOString(),
          });
        } catch (e) {
          console.error("[auth] tenantRole seed failed (non-fatal):", e);
        }
        // Drop the short role-cache so the new teamId is visible immediately.
        await invalidateRole(env, emailLc);
      }
    }
  } catch (err) {
    console.error("[auth] invite auto-join failed (non-fatal):", err);
  }

  let sessionValue: string;
  try {
    sessionValue = await issueSession(env, { email: emailLc, userId });
  } catch {
    return htmlResp(expiredLinkPage(), 500);
  }

  let landing = "/";
  try {
    const id = await resolveIdentity(env, {
      email: emailLc,
      userId,
      domain: emailLc.split("@")[1] ?? "",
    });
    if (id.ok && id.identity.role === "admin") landing = "/ops";
  } catch {
    landing = "/";
  }

  return new Response(null, {
    status: 302,
    headers: {
      Location: landing,
      "Set-Cookie": buildSessionCookieHeader(sessionValue),
    },
  });
}

export function handleLogout(_request: Request, _env: LiteLLMPortalEnv): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: "/login",
      "Set-Cookie": clearSessionHeader(),
    },
  });
}
