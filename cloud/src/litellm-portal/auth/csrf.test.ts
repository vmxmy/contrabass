import { describe, it, expect } from "vitest";
import { checkCsrf } from "./csrf";
import type { LiteLLMPortalEnv } from "../types";

function makeEnv(enabled = true): LiteLLMPortalEnv {
  return { PORTAL_DO_SOT_ENABLED: enabled ? "true" : "false" } as LiteLLMPortalEnv;
}

function makeRequest(url: string, method = "POST", headers: Record<string, string> = {}): Request {
  return new Request(url, { method, headers });
}

describe("checkCsrf", () => {
  describe("_internal/* paths are exempt", () => {
    it("allows POST to /_internal/role-changed without Origin or Referer", () => {
      const req = makeRequest("https://portal.example.com/_internal/role-changed");
      const result = checkCsrf(req, makeEnv());
      expect(result).toBeNull();
    });

    it("allows POST to any /_internal/* path without Origin or Referer", () => {
      const req = makeRequest("https://portal.example.com/_internal/other-hook");
      const result = checkCsrf(req, makeEnv());
      expect(result).toBeNull();
    });
  });

  describe("non-internal paths still enforce CSRF", () => {
    it("rejects POST without Origin or Referer", () => {
      const req = makeRequest("https://portal.example.com/api/some-action");
      const result = checkCsrf(req, makeEnv());
      expect(result).not.toBeNull();
      expect(result?.status).toBe(403);
    });

    it("accepts POST with matching Origin", () => {
      const req = makeRequest("https://portal.example.com/api/some-action", "POST", {
        Origin: "https://portal.example.com",
      });
      const result = checkCsrf(req, makeEnv());
      expect(result).toBeNull();
    });
  });

  describe("disabled when PORTAL_DO_SOT_ENABLED is not true", () => {
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
