import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleLiteLLMSyncBatch } from "./queue-consumer";
import type { LiteLLMPortalEnv } from "../types";
import type { SyncMessage } from "../durable/schemas";

const NOW = new Date().toISOString();

function makeMsg(body: SyncMessage, attempts = 1) {
  return {
    body,
    attempts,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

function makeTeamStub() {
  return {
    recordSyncSuccess: vi.fn().mockResolvedValue(undefined),
    recordSyncError: vi.fn().mockResolvedValue(undefined),
  };
}

function makeEnv() {
  const teamStub = makeTeamStub();
  const dlqSend = vi.fn().mockResolvedValue(undefined);
  return {
    teamStub,
    dlqSend,
    env: {
      LITELLM_BASE_URL: "https://litellm.test",
      LITELLM_MASTER_KEY: "test-key",
      TEAM_CONFIG_DO: {
        idFromName: (_n: string) => ({ name: _n }) as unknown,
        get: () => teamStub,
      } as unknown,
      LITELLM_SYNC_DLQ: { send: dlqSend } as unknown,
    } as unknown as LiteLLMPortalEnv,
  };
}

describe("handleLiteLLMSyncBatch", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("team.update 2xx → recordSyncSuccess called with idempotencyKey + ack", async () => {
    const { env, teamStub } = makeEnv();
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const msg = makeMsg({
      kind: "team.update",
      entityId: "team-1",
      payload: { alias: "x" },
      idempotencyKey: "idem-1",
      enqueuedAt: NOW,
    });
    await handleLiteLLMSyncBatch({ messages: [msg] } as unknown as MessageBatch<SyncMessage>, env);
    expect(teamStub.recordSyncSuccess).toHaveBeenCalledWith("idem-1");
    expect(msg.ack).toHaveBeenCalled();
    expect(msg.retry).not.toHaveBeenCalled();
  });

  it("user.update 2xx → ack only, no DO writes", async () => {
    const { env, teamStub } = makeEnv();
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const msg = makeMsg({
      kind: "user.update",
      entityId: "user-1",
      payload: {},
      idempotencyKey: "idem-u",
      enqueuedAt: NOW,
    });
    await handleLiteLLMSyncBatch({ messages: [msg] } as unknown as MessageBatch<SyncMessage>, env);
    expect(msg.ack).toHaveBeenCalled();
    expect(teamStub.recordSyncSuccess).not.toHaveBeenCalled();
    expect(teamStub.recordSyncError).not.toHaveBeenCalled();
  });

  it("key.generate 2xx → ack only, no DO writes", async () => {
    const { env, teamStub } = makeEnv();
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const msg = makeMsg({
      kind: "key.generate",
      entityId: "key-1",
      payload: {},
      idempotencyKey: "idem-kg",
      enqueuedAt: NOW,
    });
    await handleLiteLLMSyncBatch({ messages: [msg] } as unknown as MessageBatch<SyncMessage>, env);
    expect(msg.ack).toHaveBeenCalled();
    expect(teamStub.recordSyncSuccess).not.toHaveBeenCalled();
    expect(teamStub.recordSyncError).not.toHaveBeenCalled();
  });

  it("5xx on non-final attempt → msg.retry, no DO write", async () => {
    const { env, teamStub } = makeEnv();
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("oops", { status: 503 }));
    const msg = makeMsg(
      {
        kind: "team.update",
        entityId: "team-1",
        payload: {},
        idempotencyKey: "idem-2",
        enqueuedAt: NOW,
      },
      1,
    );
    await handleLiteLLMSyncBatch({ messages: [msg] } as unknown as MessageBatch<SyncMessage>, env);
    expect(msg.retry).toHaveBeenCalled();
    expect(teamStub.recordSyncError).not.toHaveBeenCalled();
    expect(msg.ack).not.toHaveBeenCalled();
  });

  it("5xx on final attempt (attempts=5) → recordSyncError + msg.retry", async () => {
    const { env, teamStub } = makeEnv();
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("oops", { status: 503 }));
    const msg = makeMsg(
      {
        kind: "team.update",
        entityId: "team-1",
        payload: {},
        idempotencyKey: "idem-3",
        enqueuedAt: NOW,
      },
      5,
    );
    await handleLiteLLMSyncBatch({ messages: [msg] } as unknown as MessageBatch<SyncMessage>, env);
    expect(teamStub.recordSyncError).toHaveBeenCalled();
    expect(msg.retry).toHaveBeenCalled();
    expect(msg.ack).not.toHaveBeenCalled();
  });

  it("4xx → forwardToDlq + recordSyncError + ack (no retry)", async () => {
    const { env, teamStub, dlqSend } = makeEnv();
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("bad request", { status: 400 }));
    const msg = makeMsg({
      kind: "team.update",
      entityId: "team-1",
      payload: {},
      idempotencyKey: "idem-4",
      enqueuedAt: NOW,
    });
    await handleLiteLLMSyncBatch({ messages: [msg] } as unknown as MessageBatch<SyncMessage>, env);
    expect(teamStub.recordSyncError).toHaveBeenCalled();
    expect(dlqSend).toHaveBeenCalled();
    expect(msg.ack).toHaveBeenCalled();
    expect(msg.retry).not.toHaveBeenCalled();
  });

  it("4xx on non-team kind → forwardToDlq + ack, no recordSyncError", async () => {
    const { env, teamStub, dlqSend } = makeEnv();
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("bad request", { status: 422 }));
    const msg = makeMsg({
      kind: "user.update",
      entityId: "user-1",
      payload: {},
      idempotencyKey: "idem-5",
      enqueuedAt: NOW,
    });
    await handleLiteLLMSyncBatch({ messages: [msg] } as unknown as MessageBatch<SyncMessage>, env);
    expect(dlqSend).toHaveBeenCalled();
    expect(msg.ack).toHaveBeenCalled();
    expect(msg.retry).not.toHaveBeenCalled();
    expect(teamStub.recordSyncError).not.toHaveBeenCalled();
  });

  it("4xx with DLQ failure → retry instead of ack", async () => {
    const { env, teamStub } = makeEnv();
    // Override DLQ send to throw
    (env.LITELLM_SYNC_DLQ as unknown as { send: ReturnType<typeof vi.fn> }).send = vi.fn().mockRejectedValue(new Error("DLQ unavailable"));
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("bad request", { status: 400 }));
    const msg = makeMsg({
      kind: "team.update",
      entityId: "team-1",
      payload: {},
      idempotencyKey: "idem-dlq-fail",
      enqueuedAt: NOW,
    });
    await handleLiteLLMSyncBatch({ messages: [msg] } as unknown as MessageBatch<SyncMessage>, env);
    expect(teamStub.recordSyncError).toHaveBeenCalled();
    expect(msg.retry).toHaveBeenCalled();
    expect(msg.ack).not.toHaveBeenCalled();
  });

  it("4xx with missing DLQ binding → retry instead of ack", async () => {
    const { env, teamStub } = makeEnv();
    // Remove DLQ binding
    (env as unknown as { LITELLM_SYNC_DLQ: undefined }).LITELLM_SYNC_DLQ = undefined;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("bad request", { status: 400 }));
    const msg = makeMsg({
      kind: "team.update",
      entityId: "team-1",
      payload: {},
      idempotencyKey: "idem-no-dlq",
      enqueuedAt: NOW,
    });
    await handleLiteLLMSyncBatch({ messages: [msg] } as unknown as MessageBatch<SyncMessage>, env);
    expect(teamStub.recordSyncError).toHaveBeenCalled();
    expect(msg.retry).toHaveBeenCalled();
    expect(msg.ack).not.toHaveBeenCalled();
  });

  it("batch independence: failure on msg1 does not skip msg2", async () => {
    const { env } = makeEnv();
    let count = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      count++;
      return Promise.resolve(new Response("{}", { status: count === 1 ? 400 : 200 }));
    });
    const m1 = makeMsg({
      kind: "team.update",
      entityId: "t1",
      payload: {},
      idempotencyKey: "i1",
      enqueuedAt: NOW,
    });
    const m2 = makeMsg({
      kind: "team.update",
      entityId: "t2",
      payload: {},
      idempotencyKey: "i2",
      enqueuedAt: NOW,
    });
    await handleLiteLLMSyncBatch({ messages: [m1, m2] } as unknown as MessageBatch<SyncMessage>, env);
    // m1 got 400 → ack (non-retryable path)
    expect(m1.ack).toHaveBeenCalled();
    // m2 got 200 → ack
    expect(m2.ack).toHaveBeenCalled();
  });

  it("idempotency note: duplicate team.update delivery re-stamps recordSyncSuccess without error", async () => {
    const { env, teamStub } = makeEnv();
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const syncBody: SyncMessage = {
      kind: "team.update",
      entityId: "team-dup",
      payload: {},
      idempotencyKey: "idem-dup",
      enqueuedAt: NOW,
    };
    const msg1 = makeMsg(syncBody);
    const msg2 = makeMsg(syncBody);
    // Deliver twice as separate batches
    await handleLiteLLMSyncBatch({ messages: [msg1] } as unknown as MessageBatch<SyncMessage>, env);
    await handleLiteLLMSyncBatch({ messages: [msg2] } as unknown as MessageBatch<SyncMessage>, env);
    expect(teamStub.recordSyncSuccess).toHaveBeenCalledTimes(2);
    expect(teamStub.recordSyncError).not.toHaveBeenCalled();
    expect(msg1.ack).toHaveBeenCalled();
    expect(msg2.ack).toHaveBeenCalled();
  });
});
