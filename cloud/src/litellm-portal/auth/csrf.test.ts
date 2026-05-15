import { describe, it, expect } from "vitest";
import { checkCsrf } from "./csrf";
import { SESSION_COOKIE_NAME } from "./session";
import type { LiteLLMPortalEnv } from "../types";

function makeEnv(enabled = true): LiteLLMPortalEnv {
  return (enabled ? { PORTAL_SESSION_SECRET: "test-secret-32-bytes-paddingXXXX" } : {}) as LiteLLMPortalEnv;
}

// Include a fake session cookie so the CSRF check does not short-circuit for
// cookieless requests (those are rejected by auth, not by CSRF).
const WITH_COOKIE = { Cookie: `${SESSION_COOKIE_NAME}=fake-cookie-value` };

function makeRequest(url: string, method = "POST", headers: Record<string, string> = {}): Request {
  return new Request(url, { method, headers });
}

function makeRequestWithCookie(url: string, method = "POST", headers: Record<string, string> = {}): Request {
  return new Request(url, { method, headers: { ...WITH_COOKIE, ...headers } });
}

describe("checkCsrf", () => {
  describe("internal-webhook exact-match exemption", () => {
    it("allows POST to /api/_internal/role-changed without Origin or Referer (shared-secret auth)", () => {
      const req = makeRequest("https://portal.example.com/api/_internal/role-changed");
      const result = checkCsrf(req, makeEnv());
      expect(result).toBeNull();
    });

    it("does NOT exempt sibling /api/_internal/client-error (no shared-secret auth)", () => {
      const req = makeRequestWithCookie("https://portal.example.com/api/_internal/client-error");
      const result = checkCsrf(req, makeEnv());
      expect(result).not.toBeNull();
      expect(result?.status).toBe(403);
    });

    it("does NOT exempt arbitrary /api/_internal/* paths", () => {
      const req = makeRequestWithCookie("https://portal.example.com/api/_internal/other-hook");
      const result = checkCsrf(req, makeEnv());
      expect(result).not.toBeNull();
      expect(result?.status).toBe(403);
    });

    it("does NOT exempt bare /_internal/role-changed (route is only reachable via /api mount)", () => {
      const req = makeRequestWithCookie("https://portal.example.com/_internal/role-changed");
      const result = checkCsrf(req, makeEnv());
      expect(result).not.toBeNull();
      expect(result?.status).toBe(403);
    });
  });

  describe("non-internal paths still enforce CSRF", () => {
    it("rejects POST without Origin or Referer (when session cookie is present)", () => {
      const req = makeRequestWithCookie("https://portal.example.com/api/some-action");
      const result = checkCsrf(req, makeEnv());
      expect(result).not.toBeNull();
      expect(result?.status).toBe(403);
    });

    it("accepts POST with matching Origin", () => {
      const req = makeRequestWithCookie("https://portal.example.com/api/some-action", "POST", {
        Origin: "https://portal.example.com",
      });
      const result = checkCsrf(req, makeEnv());
      expect(result).toBeNull();
    });

    it("passes through unauthenticated POST without session cookie (auth layer handles 401)", () => {
      const req = makeRequest("https://portal.example.com/api/some-action");
      const result = checkCsrf(req, makeEnv());
      expect(result).toBeNull();
    });
  });

  describe("disabled when PORTAL_SESSION_SECRET is not configured", () => {
    it("always returns null when disabled", () => {
      const req = makeRequest("https://portal.example.com/api/some-action");
      const result = checkCsrf(req, makeEnv(false));
      expect(result).toBeNull();
    });
  });

  describe("safe methods are always exempt", () => {
    it("allows GET without Origin", () => {
      const req = makeRequest("https://portal.example.com/api/some-action", "GET");
      expect(checkCsrf(req, makeEnv())).toBeNull();
    });

    it("allows HEAD without Origin", () => {
      const req = makeRequest("https://portal.example.com/api/some-action", "HEAD");
      expect(checkCsrf(req, makeEnv())).toBeNull();
    });

    it("allows OPTIONS without Origin", () => {
      const req = makeRequest("https://portal.example.com/api/some-action", "OPTIONS");
      expect(checkCsrf(req, makeEnv())).toBeNull();
    });
  });
});
