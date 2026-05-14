import type { LiteLLMPortalEnv } from "../types";
import { isEmailAllowed } from "./allowlist";
import { issueMagicLink, sendMagicLink, verifyMagicLink } from "./magic-link";
import { issueSession, buildSessionCookieHeader, clearSessionHeader } from "./session";

// ---------------------------------------------------------------------------
// Inline IndexDO stub type (avoids pulling DO module into test transform chain)
// ---------------------------------------------------------------------------

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
  <title>Sign in</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      font-family: system-ui, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      background: #f5f5f5;
    }
    .card {
      background: #fff;
      border-radius: 8px;
      box-shadow: 0 2px 8px rgba(0,0,0,.12);
      padding: 2rem;
      width: 100%;
      max-width: 360px;
    }
    h1 { font-size: 1.4rem; margin: 0 0 1.5rem; }
    label { display: block; font-size: .875rem; margin-bottom: .4rem; }
    input[type="email"] {
      display: block;
      width: 100%;
      padding: .5rem .75rem;
      border: 1px solid #ccc;
      border-radius: 4px;
      font-size: 1rem;
      margin-bottom: 1rem;
    }
    button {
      width: 100%;
      padding: .6rem;
      background: #0f62fe;
      color: #fff;
      border: none;
      border-radius: 4px;
      font-size: 1rem;
      cursor: pointer;
    }
    button:hover { background: #0353e9; }
    .error { color: #da1e28; font-size: .875rem; margin-bottom: .75rem; }
    .success { color: #198038; font-size: .9375rem; }
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

export async function handleLoginPost(request: Request, env: LiteLLMPortalEnv): Promise<Response> {
  let email: string;
  try {
    const form = await request.formData();
    const raw = form.get("email");
    email = typeof raw === "string" ? raw.trim() : "";
  } catch {
    return htmlResp(loginPage("Invalid email"), 400);
  }

  if (!email || !email.includes("@") || email.length > 320) {
    return htmlResp(loginPage("Invalid email"), 400);
  }

  if (!isEmailAllowed(email, env)) {
    return htmlResp(loginPage("Sign-in is not available for this email"), 403);
  }

  let token: string;
  try {
    token = await issueMagicLink(env, email);
  } catch {
    return htmlResp(loginPage("Could not send the magic link. Please try again later."), 500);
  }

  const requestUrl = new URL(request.url);
  const origin = requestUrl.origin;
  const link = `${origin}/magic-callback?token=${encodeURIComponent(token)}`;

  try {
    await sendMagicLink(env, {
      email,
      link,
      companyName: env.LITELLM_PORTAL_COMPANY_NAME ?? "the portal",
    });
  } catch {
    return htmlResp(loginPage("Could not send the magic link. Please try again later."), 500);
  }

  return htmlResp(loginPage(undefined, email));
}

export async function handleMagicCallback(request: Request, env: LiteLLMPortalEnv): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");

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
      const newRecord = {
        userId: emailLc,
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

  let sessionValue: string;
  try {
    sessionValue = await issueSession(env, { email: emailLc, userId });
  } catch {
    return htmlResp(expiredLinkPage(), 500);
  }

  return new Response(null, {
    status: 302,
    headers: {
      Location: "/",
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
