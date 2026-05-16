import { describe, it, expect } from "vitest";
import {
  issueSession,
  verifySession,
  clearSessionHeader,
  buildSessionCookieHeader,
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
} from "./session";
import type { LiteLLMPortalEnv } from "../types";

const DEFAULT_SECRET = "test-secret-32-bytes-of-random-data-padding";

function makeEnv(secret?: string): LiteLLMPortalEnv {
  const env: Partial<LiteLLMPortalEnv> = {};
  if (secret !== undefined) {
    env.PORTAL_SESSION_SECRET = secret;
  }
  return env as LiteLLMPortalEnv;
}

function makeEnvWithSecret(): LiteLLMPortalEnv {
  return makeEnv(DEFAULT_SECRET);
}

describe("session cookie helpers", () => {
  it("issueSession + verifySession round-trip returns the payload", async () => {
    const env = makeEnvWithSecret();
    const value = await issueSession(env, { email: "alice@example.com", userId: "alice-uid" });
    const payload = await verifySession(env, value);
    expect(payload).not.toBeNull();
    expect(payload?.email).toBe("alice@example.com");
    expect(payload?.userId).toBe("alice-uid");
    expect(typeof payload?.iat).toBe("string");
    expect(typeof payload?.exp).toBe("string");
  });

  it("verifySession returns null on tampered signature", async () => {
    const env = makeEnvWithSecret();
    const value = await issueSession(env, { email: "a@b.com", userId: "u" });
    // Tamper the second-to-last char (not the last — it encodes only 4 effective bits
    // for a 32-byte HMAC, so certain substitutions produce identical decoded bytes).
    const tampered = value.slice(0, -2) + (value.slice(-2, -1) === "A" ? "B" : "A") + value.slice(-1);
    expect(await verifySession(env, tampered)).toBeNull();
  });

  it("verifySession returns null on tampered payload", async () => {
    const env = makeEnvWithSecret();
    const value = await issueSession(env, { email: "a@b.com", userId: "u" });
    const dot = value.lastIndexOf(".");
    const flipped = (value[0] === "A" ? "B" : "A") + value.slice(1, dot) + value.slice(dot);
    expect(await verifySession(env, flipped)).toBeNull();
  });

  it("verifySession returns null on null/empty input", async () => {
    const env = makeEnvWithSecret();
    expect(await verifySession(env, null)).toBeNull();
    expect(await verifySession(env, "")).toBeNull();
    expect(await verifySession(env, undefined)).toBeNull();
  });

  it("verifySession returns null when secret is missing", async () => {
    const env = makeEnvWithSecret();
    const value = await issueSession(env, { email: "a@b.com", userId: "u" });
    const broken = makeEnv(undefined);
    expect(await verifySession(broken, value)).toBeNull();
  });

  it("issueSession throws when secret is missing", async () => {
    const broken = makeEnv(undefined);
    await expect(issueSession(broken, { email: "a", userId: "u" })).rejects.toThrow(/PORTAL_SESSION_SECRET/);
  });

  it("clearSessionHeader returns a Max-Age=0 cookie", () => {
    const header = clearSessionHeader();
    expect(header).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(header).toContain("Max-Age=0");
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Path=/");
  });

  it("buildSessionCookieHeader includes all security attrs and the TTL", () => {
    const header = buildSessionCookieHeader("test-value");
    expect(header).toContain(`${SESSION_COOKIE_NAME}=test-value`);
    expect(header).toContain(`Max-Age=${SESSION_TTL_SECONDS}`);
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Path=/");
  });
});
