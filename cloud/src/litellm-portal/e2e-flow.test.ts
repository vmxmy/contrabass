/**
 * End-to-end happy-path flow test (PDCSOT-72)
 *
 * Covers the full flag=true (PORTAL_DO_SOT_ENABLED="true") admin-write flow
 * without a real Cloudflare runtime:
 *
 *   [Test 1] magic-link round-trip:
 *     issueMagicLink → verifyMagicLink → issueSession → verifySession
 *
 *   [Test 2] admin write → queue:
 *     Sends an authenticated app.fetch PATCH through the full HTTP path
 *     (routing → applyAuthMiddleware → CSRF → body-parsing → dryRun →
 *     adminUpdateTeamLimitsDO → DO putTeam + enqueueSync).
 *     Captures the SyncMessage sent to LITELLM_SYNC_QUEUE.send.
 *
 *   [Test 3] queue consumer → DO sync metadata update:
 *     Takes the captured SyncMessage, wraps it in a MessageBatch, calls
 *     handleLiteLLMSyncBatch with a mocked LiteLLM fetch returning 200,
 *     and asserts TeamConfigDO.recordSyncSuccess was called with the matching
 *     idempotencyKey.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { issueMagicLink, verifyMagicLink } from "./auth/magic-link";
import { issueSession, verifySession, SESSION_COOKIE_NAME } from "./auth/session";
import { handleLiteLLMSyncBatch } from "./sync/queue-consumer";
import { app } from "./routes";
import { _clearRoleCacheForTests } from "./roles";
import type { LiteLLMPortalEnv } from "./types";
import type { SyncMessage } from "./durable/schemas";

// ---------------------------------------------------------------------------
// In-memory IndexDO stub (for magic-link nonce store/consume)
// ---------------------------------------------------------------------------

type NonceRecord = {
  token: string;
  email: string;
  expiresAt: string;
  consumedAt: string | null;
};

function makeMockIndexDO() {
  const nonces = new Map<string, NonceRecord>();
  const users = new Map<string, { userId: string; email: string; role: "admin" | "user"; teamId: string | null; createdAt: string }>();

  const stub = {
    storeNonce: async (n: NonceRecord) => {
      nonces.set(n.token, n);
    },
    consumeNonce: async (token: string) => {
      const n = nonces.get(token);
      if (!n || n.consumedAt) return null;
      if (new Date(n.expiresAt).getTime() <= Date.now()) return null;
      const consumed: NonceRecord = { ...n, consumedAt: new Date().toISOString() };
      nonces.set(token, consumed);
      return consumed;
    },
    getUserByEmail: async (email: string) => users.get(email.toLowerCase()) ?? null,
    putUser: async (record: { userId: string; email: string; role: "admin" | "user"; teamId: string | null; createdAt: string }) => {
      users.set(record.email.toLowerCase(), record);
    },
    getUserById: async (userId: string) => {
      for (const u of users.values()) {
        if (u.userId === userId) return u;
      }
      return null;
    },
    isImported: async () => true,
    markImported: async () => {},
    appendAudit: async () => {},
    listTeams: async () => [],
    listAllUsers: async () => ({ users: [], cursor: undefined }),
  };

  const namespace = {
    idFromName: (_name: string) => ({ toString: () => "stub-id" }),
    get: (_id: unknown) => stub,
  };

  return { nonces, users, stub, namespace };
}

// ---------------------------------------------------------------------------
// In-memory TeamConfigDO stub
// ---------------------------------------------------------------------------

type TeamRecord = {
  id: string;
  alias: string;
  models: string[];
  maxBudget?: number;
  tpmLimit?: number;
  rpmLimit?: number;
  blocked: boolean;
};

function makeMockTeamConfigDO() {
  let teamRecord: TeamRecord | null = null;
  let lastSyncedAt: string | null = null;
  let lastSyncError: string | null = null;
  let dirty = false;
  let lastIdempotencyKey: string | null = null;

  const stub = {
    getTeam: async () => teamRecord,
    putTeam: vi.fn(async (record: TeamRecord) => {
      teamRecord = record;
      dirty = true;
    }),
    getSyncMetadata: async () => ({ lastSyncedAt, lastSyncError, dirty }),
    recordSyncSuccess: vi.fn(async (idempotencyKey: string) => {
      lastSyncedAt = new Date().toISOString();
      lastSyncError = null;
      dirty = false;
      lastIdempotencyKey = idempotencyKey;
    }),
    recordSyncError: vi.fn(async (reason: string) => {
      lastSyncError = reason;
    }),
    _seed: (record: TeamRecord) => {
      teamRecord = record;
    },
    _getLastIdempotencyKey: () => lastIdempotencyKey,
  };

  const namespace = {
    idFromName: (_name: string) => ({ toString: () => "stub-id" }),
    get: (_id: unknown) => stub,
  };

  return { stub, namespace };
}

// ---------------------------------------------------------------------------
// Shared env builder
// ---------------------------------------------------------------------------

const SESSION_SECRET = "test-session-secret-32-bytes-padding!";
const MAGIC_LINK_SECRET = "test-magic-link-secret-32-bytes!!";
const ALLOWED_EMAIL = "admin@example.com";
const ALLOWED_DOMAIN = "example.com";

function makeBaseEnv(
  idx: ReturnType<typeof makeMockIndexDO>,
  teamDo: ReturnType<typeof makeMockTeamConfigDO>,
  queueSend: ReturnType<typeof vi.fn>,
): LiteLLMPortalEnv {
  return {
    PORTAL_DO_SOT_ENABLED: "true",
    PORTAL_SESSION_SECRET: SESSION_SECRET,
    PORTAL_MAGIC_LINK_SECRET: MAGIC_LINK_SECRET,
    PORTAL_ALLOWED_EMAIL_DOMAINS: ALLOWED_DOMAIN,
    BOOTSTRAP_ADMIN_EMAILS: ALLOWED_EMAIL,
    LITELLM_BASE_URL: "https://litellm.test",
    LITELLM_MASTER_KEY: "test-master-key",
    LITELLM_PORTAL_WRITE_OPS_ENABLED: "true",
    INDEX_DO: idx.namespace as unknown as DurableObjectNamespace,
    TEAM_CONFIG_DO: teamDo.namespace as unknown as DurableObjectNamespace,
    LITELLM_SYNC_QUEUE: { send: queueSend } as unknown as Queue<SyncMessage>,
  } as LiteLLMPortalEnv;
}

// ---------------------------------------------------------------------------
// Test suite 1: Magic-link round-trip + session
// ---------------------------------------------------------------------------

describe("magic-link round-trip (login → callback → session)", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("issues a magic-link token, verifies it, issues a session, and verifies the session", async () => {
    const idx = makeMockIndexDO();
    const teamDo = makeMockTeamConfigDO();
    const queueSend = vi.fn().mockResolvedValue(undefined);
    const env = makeBaseEnv(idx, teamDo, queueSend);

    // Step 1: Issue magic link (simulates POST /login)
    const token = await issueMagicLink(env, ALLOWED_EMAIL);
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);
    // One nonce stored in IndexDO
    expect(idx.nonces.size).toBe(1);

    // Step 2: Verify magic link (simulates GET /magic-callback?token=...)
    const verifyResult = await verifyMagicLink(env, token);
    expect(verifyResult).not.toBeNull();
    expect(verifyResult?.email).toBe(ALLOWED_EMAIL);

    // Nonce is now consumed — replay attempt returns null
    const replayResult = await verifyMagicLink(env, token);
    expect(replayResult).toBeNull();

    // Step 3: Issue session cookie (simulates handleMagicCallback issuing Set-Cookie)
    const email = ALLOWED_EMAIL.toLowerCase();
    const sessionValue = await issueSession(env, { email, userId: email });
    expect(typeof sessionValue).toBe("string");

    // Step 4: Verify session (simulates authenticateViaSession parsing Cookie header)
    const cookieHeader = `${SESSION_COOKIE_NAME}=${sessionValue}`;
    const cookiePart = cookieHeader.split(";")[0];
    const rawValue = cookiePart.slice(`${SESSION_COOKIE_NAME}=`.length);
    const payload = await verifySession(env, rawValue);
    expect(payload).not.toBeNull();
    expect(payload?.email).toBe(email);
    expect(payload?.userId).toBe(email);
  });
});

// ---------------------------------------------------------------------------
// Test suite 2: Admin write → DO + queue (via real HTTP path)
// ---------------------------------------------------------------------------

describe("admin write → DO putTeam + LITELLM_SYNC_QUEUE.send", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    _clearRoleCacheForTests();
  });

  it("PATCH team limits: writes to TeamConfigDO and enqueues a team.update SyncMessage", async () => {
    const idx = makeMockIndexDO();
    const teamDo = makeMockTeamConfigDO();
    const queueSend = vi.fn().mockResolvedValue(undefined);
    const env = makeBaseEnv(idx, teamDo, queueSend);

    const teamId = "team-001";
    const seedRecord: TeamRecord = {
      id: teamId,
      alias: "Team One",
      models: ["gpt-4"],
      blocked: false,
    };
    teamDo.stub._seed(seedRecord);

    // Seed the admin user in IndexDO so getRoleViaIndexDO returns "admin"
    await idx.stub.putUser({
      userId: ALLOWED_EMAIL.toLowerCase(),
      email: ALLOWED_EMAIL.toLowerCase(),
      role: "admin",
      teamId: null,
      createdAt: new Date().toISOString(),
    });

    // Forge a signed session cookie for the admin user
    const sessionValue = await issueSession(env, {
      email: ALLOWED_EMAIL.toLowerCase(),
      userId: ALLOWED_EMAIL.toLowerCase(),
    });

    // Exercise the full HTTP path: routing → applyAuthMiddleware → CSRF (Origin) →
    // body-parsing → adminUpdateTeamLimitsDO → DO putTeam + enqueueSync
    const response = await app.fetch(
      new Request(`https://portal.test/api/admin/teams/${teamId}/limits`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "Cookie": `${SESSION_COOKIE_NAME}=${sessionValue}`,
          "Origin": "https://portal.test",
        },
        body: JSON.stringify({ reason: "e2e-test", maxBudget: 100, tpmLimit: 10000, rpmLimit: 500 }),
      }),
      env,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body.enqueued).toBe(true);

    // Assert DO write: putTeam was called with merged limits
    expect(teamDo.stub.putTeam).toHaveBeenCalledWith(
      expect.objectContaining({
        id: teamId,
        tpmLimit: 10000,
        rpmLimit: 500,
        maxBudget: 100,
      }),
      expect.any(String),
    );

    // Assert queue send: one team.update SyncMessage enqueued
    expect(queueSend).toHaveBeenCalledTimes(1);
    const sentMessage = queueSend.mock.calls[0][0] as SyncMessage;
    expect(sentMessage.kind).toBe("team.update");
    expect(sentMessage.entityId).toBe(teamId);
    expect(typeof sentMessage.idempotencyKey).toBe("string");
    expect(sentMessage.idempotencyKey.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Test suite 3: Queue consumer → TeamConfigDO.recordSyncSuccess
// ---------------------------------------------------------------------------

describe("queue consumer → TeamConfigDO.recordSyncSuccess (PDCSOT-72 full flow)", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("handleLiteLLMSyncBatch with 200 from LiteLLM calls recordSyncSuccess with matching idempotencyKey", async () => {
    const idx = makeMockIndexDO();
    const teamDo = makeMockTeamConfigDO();

    // This time the queue is not needed for the consumer test — we supply the message directly
    const env: LiteLLMPortalEnv = {
      PORTAL_DO_SOT_ENABLED: "true",
      PORTAL_SESSION_SECRET: SESSION_SECRET,
      PORTAL_MAGIC_LINK_SECRET: MAGIC_LINK_SECRET,
      LITELLM_BASE_URL: "https://litellm.test",
      LITELLM_MASTER_KEY: "test-master-key",
      INDEX_DO: idx.namespace as unknown as DurableObjectNamespace,
      TEAM_CONFIG_DO: teamDo.namespace as unknown as DurableObjectNamespace,
    } as LiteLLMPortalEnv;

    const idempotencyKey = "team.update:t1:test-idem-key-12345";
    const syncMessage: SyncMessage = {
      kind: "team.update",
      entityId: "t1",
      payload: {
        team_id: "t1",
        max_budget: 100,
        tpm_limit: 10000,
        rpm_limit: 500,
      },
      idempotencyKey,
      enqueuedAt: new Date().toISOString(),
    };

    // Mock LiteLLM fetch to return 200
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));

    const msg = {
      body: syncMessage,
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    };

    await handleLiteLLMSyncBatch(
      { messages: [msg] } as unknown as MessageBatch<SyncMessage>,
      env,
    );

    // LiteLLM was called
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(fetchCall[0])).toContain("/team/update");

    // recordSyncSuccess was called with the exact idempotencyKey
    expect(teamDo.stub.recordSyncSuccess).toHaveBeenCalledTimes(1);
    expect(teamDo.stub.recordSyncSuccess).toHaveBeenCalledWith(idempotencyKey);

    // Message was acked, not retried
    expect(msg.ack).toHaveBeenCalled();
    expect(msg.retry).not.toHaveBeenCalled();
  });

  it("full chain: magic-link token → session → admin write → queue → consumer → recordSyncSuccess", async () => {
    // -----------------------------------------------------------------------
    // Phase A: magic-link token round-trip
    // -----------------------------------------------------------------------
    const idx = makeMockIndexDO();
    const teamDo = makeMockTeamConfigDO();
    let capturedSyncMessage: SyncMessage | null = null;
    const queueSend = vi.fn().mockImplementation(async (msg: SyncMessage) => {
      capturedSyncMessage = msg;
    });
    const env = makeBaseEnv(idx, teamDo, queueSend);

    // Seed the admin user in IndexDO for role resolution
    const email = ALLOWED_EMAIL.toLowerCase();
    await idx.stub.putUser({
      userId: email,
      email,
      role: "admin",
      teamId: null,
      createdAt: new Date().toISOString(),
    });
    _clearRoleCacheForTests();

    // Issue magic link
    const token = await issueMagicLink(env, ALLOWED_EMAIL);
    const verifyResult = await verifyMagicLink(env, token);
    expect(verifyResult).not.toBeNull();

    // Issue session
    const sessionValue = await issueSession(env, { email, userId: email });
    const payload = await verifySession(env, sessionValue);
    expect(payload?.email).toBe(email);

    // -----------------------------------------------------------------------
    // Phase B: Admin write via full HTTP path — routing → auth → CSRF →
    // body-parsing → adminUpdateTeamLimitsDO → DO putTeam + enqueueSync
    // -----------------------------------------------------------------------
    const teamId = "t1";
    teamDo.stub._seed({
      id: teamId,
      alias: "Team One",
      models: ["gpt-4"],
      blocked: false,
    });

    const patchResponse = await app.fetch(
      new Request(`https://portal.test/api/admin/teams/${teamId}/limits`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "Cookie": `${SESSION_COOKIE_NAME}=${sessionValue}`,
          "Origin": "https://portal.test",
        },
        body: JSON.stringify({ reason: "e2e-test", maxBudget: 100, tpmLimit: 10000, rpmLimit: 500 }),
      }),
      env,
    );

    expect(patchResponse.status).toBe(200);
    const patchBody = await patchResponse.json() as Record<string, unknown>;
    expect(patchBody.enqueued).toBe(true);
    expect(capturedSyncMessage).not.toBeNull();

    // -----------------------------------------------------------------------
    // Phase C: Queue consumer processes the captured SyncMessage
    // -----------------------------------------------------------------------
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));

    const queueMsg = {
      body: capturedSyncMessage as unknown as SyncMessage,
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    };

    await handleLiteLLMSyncBatch(
      { messages: [queueMsg] } as unknown as MessageBatch<SyncMessage>,
      env,
    );

    // Assert recordSyncSuccess was called with the captured idempotencyKey
    expect(teamDo.stub.recordSyncSuccess).toHaveBeenCalledTimes(1);
    expect(teamDo.stub.recordSyncSuccess).toHaveBeenCalledWith(
      (capturedSyncMessage as unknown as SyncMessage).idempotencyKey,
    );

    // Queue message was acked
    expect(queueMsg.ack).toHaveBeenCalled();
    expect(queueMsg.retry).not.toHaveBeenCalled();

    // TeamConfigDO.putTeam was called with the correct limits
    expect(teamDo.stub.putTeam).toHaveBeenCalledWith(
      expect.objectContaining({ tpmLimit: 10000, rpmLimit: 500, maxBudget: 100 }),
      expect.any(String),
    );
  });
});
