import { afterEach, describe, expect, it, vi } from "vitest";

import { handleLiteLLMPortalRequest, type LiteLLMPortalEnv } from "./index";
import { _clearRoleCacheForTests } from "./roles";
import { detectLeakInResponse } from "./security/leak-detector";
import { securityHeaders } from "./security/headers";
import { RateLimitDO } from "./security/rate-limit-do";
import { htmlResponse } from "./utils";

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  _clearRoleCacheForTests();
});

const originalFetch = globalThis.fetch;

// ---------------------------------------------------------------------------
// Security header helpers
// ---------------------------------------------------------------------------

describe("securityHeaders()", () => {
  it("includes all required security headers without a nonce", () => {
    const headers = securityHeaders();
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["permissions-policy"]).toContain("camera=()");
    expect(headers["content-security-policy"]).toContain("script-src 'self'");
    expect(headers["content-security-policy"]).toContain("object-src 'none'");
    expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  });

  it("includes a nonce in script-src when nonce is provided", () => {
    const nonce = "abc123xyz";
    const headers = securityHeaders(nonce);
    expect(headers["content-security-policy"]).toContain(`'nonce-${nonce}'`);
  });

  it("produces a different CSP for different nonces", () => {
    const h1 = securityHeaders("nonce-aaa");
    const h2 = securityHeaders("nonce-bbb");
    expect(h1["content-security-policy"]).not.toBe(h2["content-security-policy"]);
  });
});

// ---------------------------------------------------------------------------
// Security headers applied to non-SSR responses
// ---------------------------------------------------------------------------

describe("portal security headers on non-SSR responses", () => {
  it("JSON API 401 response includes x-content-type-options and x-frame-options", async () => {
    // /api/me with no auth token → 401 (no SSR, no @tanstack/react-query)
    const response = await handleLiteLLMPortalRequest(
      new Request("https://portal.test/api/me"),
      portalEnv(),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });

  it("JSON API 401 response includes referrer-policy strict-origin-when-cross-origin", async () => {
    const response = await handleLiteLLMPortalRequest(
      new Request("https://portal.test/api/me"),
      portalEnv(),
    );
    expect(response.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
  });

  it("JSON API 401 response includes content-security-policy", async () => {
    const response = await handleLiteLLMPortalRequest(
      new Request("https://portal.test/api/me"),
      portalEnv(),
    );
    const csp = response.headers.get("content-security-policy");
    expect(csp).not.toBeNull();
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("not_found path includes security headers", async () => {
    const response = await handleLiteLLMPortalRequest(
      new Request("https://portal.test/unknown-path"),
      portalEnv(),
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("htmlResponse helper builds headers with nonce in CSP", () => {
    const nonce = "testnonce1234567890abc";
    const resp = htmlResponse("<html></html>", nonce);
    const csp = resp.headers.get("content-security-policy");
    expect(csp).toContain(`'nonce-${nonce}'`);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(resp.headers.get("x-frame-options")).toBe("DENY");
  });

  it("htmlResponse helper without nonce still includes base CSP directives", () => {
    const resp = htmlResponse("<html></html>");
    const csp = resp.headers.get("content-security-policy");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("'nonce-");
  });

  it("nonces are unique per call to crypto.randomUUID", () => {
    const n1 = crypto.randomUUID().replace(/-/g, "");
    const n2 = crypto.randomUUID().replace(/-/g, "");
    expect(n1).not.toBe(n2);
    expect(n1).toHaveLength(32);
  });
});

// ---------------------------------------------------------------------------
// Leak detector middleware
// ---------------------------------------------------------------------------

describe("detectLeakInResponse()", () => {
  it("passes through a clean JSON response unchanged", async () => {
    const original = Response.json({ email: "user@example.com", role: "user" });
    const result = await detectLeakInResponse(original);
    expect(result.status).toBe(200);
    const body = await result.json() as Record<string, unknown>;
    expect(body.email).toBe("user@example.com");
  });

  it("replaces a JSON response containing sk- fragment with 500", async () => {
    const leaky = new Response(
      JSON.stringify({ key: "sk-aaaaaaaabbbbbbbb", user: "admin" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    const result = await detectLeakInResponse(leaky);
    expect(result.status).toBe(500);
    const body = await result.json() as Record<string, unknown>;
    expect(body.error).toBe("response_blocked");
  });

  it("treats sk- with fewer than 8 trailing chars as safe", async () => {
    const safe = new Response(
      JSON.stringify({ label: "sk-short" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    const result = await detectLeakInResponse(safe);
    expect(result.status).toBe(200);
  });

  it("passes through non-JSON responses untouched", async () => {
    const html = new Response("<html>hello</html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
    const result = await detectLeakInResponse(html);
    expect(result.status).toBe(200);
    const text = await result.text();
    expect(text).toContain("<html>");
  });

  it("catches sk- key embedded deep in a JSON structure", async () => {
    const leaky = new Response(
      JSON.stringify({ data: { nested: { key: "sk-master1234567890" } } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    const result = await detectLeakInResponse(leaky);
    expect(result.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Rate limit Durable Object (unit test with mock DurableObjectState)
// ---------------------------------------------------------------------------

describe("RateLimitDO", () => {
  function makeMockState(): DurableObjectState {
    const storage = new Map<string, unknown>();
    return {
      storage: {
        get: async (key: string) => storage.get(key),
        put: async (key: string, value: unknown) => { storage.set(key, value); },
      },
    } as unknown as DurableObjectState;
  }

  it("allows requests below the threshold", async () => {
    const state = makeMockState();
    const do_ = new RateLimitDO(state);
    const req = new Request("https://rate-limit-do/check?key=user%40example.com%3A1.2.3.4");
    const response = await do_.fetch(req);
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
  });

  it("returns 429 after exceeding 60 requests within the window", async () => {
    const state = makeMockState();
    const do_ = new RateLimitDO(state);
    const req = () => new Request("https://rate-limit-do/check?key=user%40example.com%3A1.2.3.4");

    for (let i = 0; i < 60; i++) {
      const r = await do_.fetch(req());
      expect(r.status).toBe(200);
    }

    const overflow = await do_.fetch(req());
    expect(overflow.status).toBe(429);
    expect(overflow.headers.get("retry-after")).not.toBeNull();
    const body = await overflow.json() as Record<string, unknown>;
    expect(body.error).toBe("rate_limit_exceeded");
  });

  it("allows a second actor key independently", async () => {
    const state = makeMockState();
    const do_ = new RateLimitDO(state);
    const reqA = () => new Request("https://rate-limit-do/check?key=actor-a");
    const reqB = () => new Request("https://rate-limit-do/check?key=actor-b");

    for (let i = 0; i < 60; i++) {
      await do_.fetch(reqA());
    }
    const aOver = await do_.fetch(reqA());
    expect(aOver.status).toBe(429);

    const bOk = await do_.fetch(reqB());
    expect(bOk.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function portalEnv(overrides: Partial<LiteLLMPortalEnv> = {}): LiteLLMPortalEnv {
  return {
    CLOUDFLARE_ACCESS_AUD: "access-aud",
    CLOUDFLARE_ACCESS_TEAM_DOMAIN: "https://gz-zhiyun.cloudflareaccess.com",
    LITELLM_ALLOWED_MODELS: "gpt-4o-mini",
    LITELLM_BASE_URL: "https://litellm.test",
    LITELLM_MASTER_KEY: "litellm-master",
    LITELLM_PORTAL_ALLOWED_EMAIL_DOMAIN: "gz-zhiyun.com",
    ...overrides,
  };
}
