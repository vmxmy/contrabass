import { beforeEach, describe, expect, it, vi } from "vitest";

import { app } from "./routes";
import { issueSession, SESSION_COOKIE_NAME } from "./auth/session";
import { _clearRoleCacheForTests } from "./roles";
import { OpsTenantsSchema } from "./schemas";
import type { LiteLLMPortalEnv } from "./types";

// NOTE: the original plan draft authenticated these tests via a
// `cf-access-authenticated-user-email` header. This codebase has NO Cloudflare
// Access header-auth path — the real, secure auth is a signed `portal_session`
// cookie (`issueSession`/`verifySession`, `PORTAL_SESSION_SECRET`) and the
// platform role is resolved from the IndexDO user record (fail-closed). An
// earlier implementation introduced an unverified-header auth bypass to satisfy
// the bad premise; that was reverted. These tests use the real session idiom
// (mirrors routes-do-path.test.ts). Under the secure model an Owner's admin
// role itself requires IndexDO, so the plan's contradictory "owner with NO
// IndexDO → 503" case is unrepresentable without the reverted bypass; the
// realistic secure deliverable assertion is owner + IndexDO → 200.

const SESSION_SECRET = "test-secret-32bytes-paddedXXXXXX";
const OWNER_EMAIL = "admin@gz-zhiyun.com";
const MEMBER_EMAIL = "bob@gz-zhiyun.com";

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
    listTeams: vi.fn().mockResolvedValue([{ id: "t1", alias: "Acme" }]),
    listTenantRoles: vi.fn().mockResolvedValue([]),
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

describe("ops backend gating", () => {
  beforeEach(() => {
    _clearRoleCacheForTests();
  });

  it("unauthenticated /api/ops/tenants → 401", async () => {
    // #given an env with no session cookie on the request
    const env = makeEnv(makeIndexDOStub([]));
    // #when
    const res = await app.fetch(new Request("http://localhost/api/ops/tenants"), env);
    // #then the real session authenticator rejects (no cookie)
    expect(res.status).toBe(401);
  });

  it("authenticated NON-owner /api/ops/tenants → 403 owner_required", async () => {
    // #given a real signed session for a user whose IndexDO record is role=user
    const stub = makeIndexDOStub([
      { userId: MEMBER_EMAIL, email: MEMBER_EMAIL, role: "user", teamId: "t2", createdAt: new Date().toISOString() },
    ]);
    const env = makeEnv(stub);
    const cookie = await sessionCookie(env, MEMBER_EMAIL);
    // #when
    const res = await app.fetch(
      new Request("http://localhost/api/ops/tenants", { headers: { Cookie: cookie } }),
      env,
    );
    // #then requireOwner rejects a resolved non-admin
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "owner_required" });
  });

  it("authenticated OWNER /api/ops/tenants → 200 with OpsTenants payload", async () => {
    // #given a real signed session for a user whose IndexDO record is role=admin
    const stub = makeIndexDOStub([
      { userId: OWNER_EMAIL, email: OWNER_EMAIL, role: "admin", teamId: "t1", createdAt: new Date().toISOString() },
    ]);
    const env = makeEnv(stub);
    const cookie = await sessionCookie(env, OWNER_EMAIL);
    // #when
    const res = await app.fetch(
      new Request("http://localhost/api/ops/tenants", { headers: { Cookie: cookie } }),
      env,
    );
    // #then the owner gate passes and the endpoint returns a valid OpsTenants body
    expect(res.status).toBe(200);
    const parsed = OpsTenantsSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    expect(Array.isArray(parsed.success && parsed.data.tenants)).toBe(true);
  });
});
