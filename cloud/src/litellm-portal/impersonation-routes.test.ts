import { beforeEach, describe, expect, it, vi } from "vitest";

import { app } from "./routes";
import { issueSession, SESSION_COOKIE_NAME } from "./auth/session";
import { _clearRoleCacheForTests } from "./roles";
import {
  mintImpersonationToken,
  reMintImpersonationToken,
  IMPERSONATION_COOKIE,
} from "./impersonation";
import type { LiteLLMPortalEnv } from "./types";

// NOTE: this codebase has NO Cloudflare Access header-auth path. The real,
// secure auth is the signed `portal_session` cookie (issueSession /
// PORTAL_SESSION_SECRET) and the platform role is resolved from the IndexDO
// user record (fail-closed). These tests use the real session idiom (mirrors
// ops-routes.test.ts) — no cf-access headers, no BOOTSTRAP_ADMIN_EMAILS.

const SESSION_SECRET = "test-secret-32bytes-paddedXXXXXX";
// Impersonation tokens are HMAC-signed with the same secret as the portal
// session cookie (same crypto shape — see impersonation.ts docstring).
const IMP_SECRET = SESSION_SECRET;
const OWNER_EMAIL = "admin@gz-zhiyun.com";

type StubUser = {
  userId: string;
  email: string;
  role: "admin" | "user";
  teamId: string | null;
  createdAt: string;
};

function makeIndexDOStub(users: StubUser[]) {
  return {
    getUserByEmail: vi.fn(async (email: string) => users.find((u) => u.email === email) ?? null),
    getUserById: vi.fn(async (userId: string) => users.find((u) => u.userId === userId) ?? null),
    listTeams: vi.fn().mockResolvedValue([{ id: "team-1", alias: "Acme" }]),
    listTenantRoles: vi.fn().mockResolvedValue([]),
    appendAudit: vi.fn().mockResolvedValue(undefined),
    putImpersonationSession: vi.fn().mockResolvedValue(undefined),
    getActiveImpersonationSession: vi.fn().mockResolvedValue(null),
    endImpersonationSession: vi.fn().mockResolvedValue(undefined),
  };
}

function makeIndexDONamespace(stub: ReturnType<typeof makeIndexDOStub>) {
  return { idFromName: vi.fn().mockReturnValue({}), get: vi.fn().mockReturnValue(stub) };
}

function makeEnv(stub: ReturnType<typeof makeIndexDOStub>): LiteLLMPortalEnv {
  return {
    PORTAL_SESSION_SECRET: SESSION_SECRET,
    PORTAL_ALLOWED_EMAIL_DOMAINS: "gz-zhiyun.com",
    INDEX_DO: makeIndexDONamespace(stub) as unknown as DurableObjectNamespace,
  } as unknown as LiteLLMPortalEnv;
}

async function sessionCookie(env: LiteLLMPortalEnv, email: string): Promise<string> {
  const value = await issueSession(env, { email, userId: email });
  return `${SESSION_COOKIE_NAME}=${value}`;
}

function ownerStub() {
  return makeIndexDOStub([
    {
      userId: OWNER_EMAIL,
      email: OWNER_EMAIL,
      role: "admin",
      teamId: "team-1",
      createdAt: new Date().toISOString(),
    },
  ]);
}

describe("impersonation routes", () => {
  beforeEach(() => {
    _clearRoleCacheForTests();
  });

  it("POST /api/ops/impersonation unauthenticated → 401/403", async () => {
    // #given an env with no session cookie on the request
    const env = makeEnv(makeIndexDOStub([]));
    // #when
    const res = await app.fetch(
      new Request("http://localhost/api/ops/impersonation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ teamId: "team-1", reason: "user_request" }),
      }),
      env,
    );
    // #then the real session authenticator rejects (no cookie)
    expect([401, 403]).toContain(res.status);
  });

  it("DELETE /api/ops/impersonation as Owner with no active token → 200 clearing cb_imp", async () => {
    // #given a real signed session for an IndexDO-admin (Owner)
    const env = makeEnv(ownerStub());
    const cookie = await sessionCookie(env, OWNER_EMAIL);
    // #when
    const res = await app.fetch(
      new Request("http://localhost/api/ops/impersonation", {
        method: "DELETE",
        headers: { Cookie: cookie },
      }),
      env,
    );
    // #then the stop endpoint succeeds and clears the impersonation cookie
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie") ?? "").toContain(`${IMPERSONATION_COOKIE}=`);
  });

  it("C3: Owner WITHOUT cb_imp cookie POST /api/tenant/invites → 403 impersonation_required", async () => {
    // #given a real signed Owner session, no impersonation cookie
    const env = makeEnv(ownerStub());
    const cookie = await sessionCookie(env, OWNER_EMAIL);
    // #when an Owner attempts a tenant write directly
    const res = await app.fetch(
      new Request("http://localhost/api/tenant/invites", {
        method: "POST",
        headers: { Cookie: cookie, "content-type": "application/json" },
        body: JSON.stringify({ email: "x@gz-zhiyun.com", teamRole: "user", reason: "user_request" }),
      }),
      env,
    );
    // #then C3 blocks the Owner-as-tenant write audit escape
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "impersonation_required" });
  });

  it("C3: Owner WITH valid cb_imp cookie POST /api/tenant/invites → not impersonation-gated", async () => {
    // #given a real signed Owner session AND a valid impersonation token cookie
    const env = makeEnv(ownerStub());
    const session = await sessionCookie(env, OWNER_EMAIL);
    const token = await mintImpersonationToken(IMP_SECRET, {
      realActor: OWNER_EMAIL,
      effectiveTeamId: "team-1",
      now: Date.now(),
    });
    // #when the Owner performs the same write while impersonating
    const res = await app.fetch(
      new Request("http://localhost/api/tenant/invites", {
        method: "POST",
        headers: {
          Cookie: `${session}; ${IMPERSONATION_COOKIE}=${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ email: "x@gz-zhiyun.com", teamRole: "user", reason: "user_request" }),
      }),
      env,
    );
    // #then the C3 gate is satisfied (a downstream dependency error is fine)
    expect(res.status).not.toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(body.error).not.toBe("impersonation_required");
  });

  it("H4: reMintImpersonationToken keeps absoluteDeadline, slides idleDeadline", async () => {
    // #given an original token minted at t0
    const t0 = 1_000_000;
    const token = await mintImpersonationToken(IMP_SECRET, {
      realActor: OWNER_EMAIL,
      effectiveTeamId: "team-1",
      now: t0,
    });
    const decode = (tok: string) =>
      JSON.parse(
        new TextDecoder().decode(
          Uint8Array.from(
            atob(tok.split(".")[0].replace(/-/g, "+").replace(/_/g, "/")),
            (ch) => ch.charCodeAt(0),
          ),
        ),
      ) as { issuedAt: number; idleDeadline: number; absoluteDeadline: number };
    const prior = decode(token);
    // #when re-minted 20 minutes later
    const reMinted = await reMintImpersonationToken(
      IMP_SECRET,
      {
        realActor: OWNER_EMAIL,
        effectiveTeamId: "team-1",
        issuedAt: prior.issuedAt,
        absoluteDeadline: prior.absoluteDeadline,
      },
      t0 + 20 * 60 * 1000,
    );
    const next = decode(reMinted);
    // #then the absolute cap is unchanged and the idle window slid forward
    expect(next.absoluteDeadline).toBe(prior.absoluteDeadline);
    expect(next.idleDeadline).toBeGreaterThan(prior.idleDeadline);
  });
});
