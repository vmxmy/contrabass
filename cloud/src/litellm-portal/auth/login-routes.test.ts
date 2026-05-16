import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleMagicCallback } from "./login-routes";
import { issueMagicLink } from "./magic-link";
import { _clearRoleCacheForTests } from "../roles";
import type { LiteLLMPortalEnv } from "../types";

type UserRow = {
  userId: string;
  email: string;
  role: "admin" | "user";
  teamId: string | null;
  createdAt: string;
};
type InviteRow = {
  emailLc: string;
  teamId: string;
  teamRole: "admin" | "user";
  status: "pending" | "consumed" | "revoked";
  invitedBy: string;
  createdAt: string;
  consumedAt: string | null;
};

function makeMock(opts: { seedUser?: UserRow; seedInvite?: InviteRow; getInviteThrows?: boolean } = {}) {
  const nonces = new Map<string, { token: string; email: string; expiresAt: string; consumedAt: string | null }>();
  const users = new Map<string, UserRow>();
  const invites = new Map<string, InviteRow>();
  if (opts.seedUser) users.set(opts.seedUser.email.toLowerCase(), opts.seedUser);
  if (opts.seedInvite) invites.set(opts.seedInvite.emailLc.toLowerCase(), opts.seedInvite);

  const putUser = vi.fn(async (r: UserRow) => {
    users.set(r.email.toLowerCase(), r);
  });
  const markInviteConsumed = vi.fn(async (emailLc: string) => {
    const cur = invites.get(emailLc.toLowerCase());
    if (!cur || cur.status !== "pending") return cur ?? null;
    const next: InviteRow = { ...cur, status: "consumed", consumedAt: new Date().toISOString() };
    invites.set(emailLc.toLowerCase(), next);
    return next;
  });

  const stub = {
    init: async () => ({ ok: true as const, imported: true }),
    storeNonce: async (n: { token: string; email: string; expiresAt: string; consumedAt: string | null }) => {
      nonces.set(n.token, n);
    },
    consumeNonce: async (token: string) => {
      const n = nonces.get(token);
      if (!n || n.consumedAt) return null;
      if (new Date(n.expiresAt).getTime() <= Date.now()) return null;
      const consumed = { ...n, consumedAt: new Date().toISOString() };
      nonces.set(token, consumed);
      return consumed;
    },
    getUserByEmail: async (email: string) => users.get(email.toLowerCase()) ?? null,
    getUserById: async (id: string) => [...users.values()].find((u) => u.userId === id) ?? null,
    putUser,
    getInvite: async (emailLc: string) => {
      if (opts.getInviteThrows) throw new Error("boom");
      return invites.get(emailLc.toLowerCase()) ?? null;
    },
    markInviteConsumed,
    appendAudit: async () => {},
  };

  const namespace = {
    idFromName: (_n: string) => ({ toString: () => "stub" }),
    get: (_id: unknown) => stub,
  };

  return { stub, namespace, users, invites, putUser, markInviteConsumed };
}

function makeEnv(namespace: unknown): LiteLLMPortalEnv {
  return {
    PORTAL_MAGIC_LINK_SECRET: "magic-secret-32bytes-paddedXXXXXX",
    PORTAL_SESSION_SECRET: "session-secret-32bytes-paddedXXX",
    PORTAL_ALLOWED_EMAIL_DOMAINS: "gz-zhiyun.com",
    INDEX_DO: namespace as DurableObjectNamespace,
    LITELLM_SYNC_QUEUE: { send: vi.fn().mockResolvedValue(undefined) } as unknown as Queue,
    LITELLM_SYNC_DLQ: { send: vi.fn().mockResolvedValue(undefined) } as unknown as Queue,
  } as unknown as LiteLLMPortalEnv;
}

async function callbackFor(email: string, env: LiteLLMPortalEnv): Promise<Response> {
  const token = await issueMagicLink(env, email);
  return handleMagicCallback(new Request(`https://x/magic-callback?token=${encodeURIComponent(token)}`), env);
}

const EMAIL = "invitee@gz-zhiyun.com";

beforeEach(() => _clearRoleCacheForTests());

describe("handleMagicCallback — admin-invite auto-join", () => {
  it("joins an existing user to the invited team and consumes the invite", async () => {
    const mock = makeMock({
      seedUser: { userId: "u1", email: EMAIL, role: "user", teamId: null, createdAt: new Date().toISOString() },
      seedInvite: { emailLc: EMAIL, teamId: "team_acme", teamRole: "user", status: "pending", invitedBy: "admin@x.com", createdAt: new Date().toISOString(), consumedAt: null },
    });
    const env = makeEnv(mock.namespace);

    const res = await callbackFor(EMAIL, env);

    expect(res.status).toBe(302);
    expect(res.headers.get("set-cookie")).toBeTruthy();
    expect(mock.putUser).toHaveBeenCalledWith(expect.objectContaining({ userId: "u1", teamId: "team_acme" }));
    expect(mock.markInviteConsumed).toHaveBeenCalledWith(EMAIL);
    expect(mock.invites.get(EMAIL)?.status).toBe("consumed");
  });

  it("materializes a brand-new user and joins them via invite", async () => {
    const mock = makeMock({
      seedInvite: { emailLc: EMAIL, teamId: "team_new", teamRole: "user", status: "pending", invitedBy: "admin@x.com", createdAt: new Date().toISOString(), consumedAt: null },
    });
    const env = makeEnv(mock.namespace);

    const res = await callbackFor(EMAIL, env);

    expect(res.status).toBe(302);
    expect(mock.users.get(EMAIL)?.teamId).toBe("team_new");
    expect(mock.invites.get(EMAIL)?.status).toBe("consumed");
  });

  it("is a no-op on a second login (invite already consumed)", async () => {
    const mock = makeMock({
      seedUser: { userId: "u1", email: EMAIL, role: "user", teamId: "team_acme", createdAt: new Date().toISOString() },
      seedInvite: { emailLc: EMAIL, teamId: "team_acme", teamRole: "user", status: "consumed", invitedBy: "admin@x.com", createdAt: new Date().toISOString(), consumedAt: new Date().toISOString() },
    });
    const env = makeEnv(mock.namespace);

    const res = await callbackFor(EMAIL, env);

    expect(res.status).toBe(302);
    expect(mock.markInviteConsumed).not.toHaveBeenCalled();
  });

  it("login still succeeds with no invite (regression)", async () => {
    const mock = makeMock({
      seedUser: { userId: "u1", email: EMAIL, role: "user", teamId: null, createdAt: new Date().toISOString() },
    });
    const env = makeEnv(mock.namespace);

    const res = await callbackFor(EMAIL, env);

    expect(res.status).toBe(302);
    expect(mock.markInviteConsumed).not.toHaveBeenCalled();
    expect(mock.users.get(EMAIL)?.teamId).toBeNull();
  });

  it("fails open: an invite lookup error never blocks login", async () => {
    const mock = makeMock({
      seedUser: { userId: "u1", email: EMAIL, role: "user", teamId: null, createdAt: new Date().toISOString() },
      getInviteThrows: true,
    });
    const env = makeEnv(mock.namespace);

    const res = await callbackFor(EMAIL, env);

    expect(res.status).toBe(302);
    expect(res.headers.get("set-cookie")).toBeTruthy();
  });
});
