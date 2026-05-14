import { describe, it, expect, beforeEach } from "vitest";
import { issueMagicLink, verifyMagicLink, MAGIC_LINK_TTL_SECONDS } from "./magic-link";
import type { LiteLLMPortalEnv } from "../types";

// ---------------------------------------------------------------------------
// Minimal in-memory IndexDO stub
// ---------------------------------------------------------------------------

type NonceRecord = {
  token: string;
  email: string;
  expiresAt: string;
  consumedAt: string | null;
};

function makeMockIndexDO() {
  const nonces = new Map<string, NonceRecord>();

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
    getUserByEmail: async () => null,
    putUser: async () => {},
    isImported: async () => true,
    markImported: async () => {},
    appendAudit: async () => {},
  };

  const namespace = {
    idFromName: (_name: string) => ({ toString: () => "stub-id" }),
    get: (_id: unknown) => stub,
  };

  return { nonces, stub, namespace };
}

function makeEnv(idx: ReturnType<typeof makeMockIndexDO>): LiteLLMPortalEnv {
  return {
    PORTAL_MAGIC_LINK_SECRET: "test-secret-32-bytes-of-random-data-padding",
    INDEX_DO: idx.namespace as unknown as DurableObjectNamespace,
  } as LiteLLMPortalEnv;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("issueMagicLink + verifyMagicLink", () => {
  let idx: ReturnType<typeof makeMockIndexDO>;
  let env: LiteLLMPortalEnv;

  beforeEach(() => {
    idx = makeMockIndexDO();
    env = makeEnv(idx);
  });

  it("exports MAGIC_LINK_TTL_SECONDS as 900 (15 minutes)", () => {
    expect(MAGIC_LINK_TTL_SECONDS).toBe(900);
  });

  it("valid round-trip returns { email }", async () => {
    const token = await issueMagicLink(env, "alice@example.com");
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);

    const result = await verifyMagicLink(env, token);
    expect(result).toEqual({ email: "alice@example.com" });
  });

  it("bad signature returns null", async () => {
    const token = await issueMagicLink(env, "alice@example.com");
    // Flip last char of the signature portion
    const tampered = token.slice(0, -1) + (token.slice(-1) === "A" ? "B" : "A");
    const result = await verifyMagicLink(env, tampered);
    expect(result).toBeNull();
  });

  it("replay returns null after first consume", async () => {
    const token = await issueMagicLink(env, "alice@example.com");
    const first = await verifyMagicLink(env, token);
    expect(first).toEqual({ email: "alice@example.com" });

    const second = await verifyMagicLink(env, token);
    expect(second).toBeNull();
  });

  it("expired token returns null", async () => {
    const token = await issueMagicLink(env, "alice@example.com");
    // Force every stored nonce to appear expired
    for (const [k, v] of idx.nonces) {
      idx.nonces.set(k, { ...v, expiresAt: new Date(Date.now() - 1000).toISOString() });
    }
    const result = await verifyMagicLink(env, token);
    expect(result).toBeNull();
  });

  it("missing PORTAL_MAGIC_LINK_SECRET on verify returns null", async () => {
    const token = await issueMagicLink(env, "alice@example.com");
    const broken = { ...env, PORTAL_MAGIC_LINK_SECRET: undefined } as unknown as LiteLLMPortalEnv;
    const result = await verifyMagicLink(broken, token);
    expect(result).toBeNull();
  });

  it("null/empty/undefined token returns null", async () => {
    expect(await verifyMagicLink(env, null)).toBeNull();
    expect(await verifyMagicLink(env, "")).toBeNull();
    expect(await verifyMagicLink(env, undefined)).toBeNull();
  });
});
