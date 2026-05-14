import { describe, it, expect } from "vitest";
import { parseAllowedDomains, isEmailAllowed } from "./allowlist";
import type { LiteLLMPortalEnv } from "../types";

function makeEnv(domains: string | undefined): LiteLLMPortalEnv {
  return { PORTAL_ALLOWED_EMAIL_DOMAINS: domains } as LiteLLMPortalEnv;
}

describe("parseAllowedDomains", () => {
  it("returns [] when env var is undefined", () => {
    expect(parseAllowedDomains(makeEnv(undefined))).toEqual([]);
  });

  it("returns [] when env var is empty", () => {
    expect(parseAllowedDomains(makeEnv(""))).toEqual([]);
  });

  it("parses a single domain", () => {
    expect(parseAllowedDomains(makeEnv("gz-zhiyun.com"))).toEqual(["gz-zhiyun.com"]);
  });

  it("parses a multi-domain comma list", () => {
    expect(parseAllowedDomains(makeEnv("gz-zhiyun.com,partner.example"))).toEqual(["gz-zhiyun.com", "partner.example"]);
  });

  it("trims whitespace", () => {
    expect(parseAllowedDomains(makeEnv(" gz-zhiyun.com , partner.example "))).toEqual(["gz-zhiyun.com", "partner.example"]);
  });

  it("lowercases all entries", () => {
    expect(parseAllowedDomains(makeEnv("GZ-Zhiyun.COM"))).toEqual(["gz-zhiyun.com"]);
  });

  it("deduplicates entries", () => {
    expect(parseAllowedDomains(makeEnv("a.com,A.COM,a.com"))).toEqual(["a.com"]);
  });

  it("filters empty entries from leading/trailing commas", () => {
    expect(parseAllowedDomains(makeEnv(",gz-zhiyun.com,,partner.example,"))).toEqual(["gz-zhiyun.com", "partner.example"]);
  });
});

describe("isEmailAllowed", () => {
  it("rejects empty allow-list", () => {
    expect(isEmailAllowed("alice@gz-zhiyun.com", makeEnv(undefined))).toBe(false);
  });

  it("accepts matching domain", () => {
    expect(isEmailAllowed("alice@gz-zhiyun.com", makeEnv("gz-zhiyun.com"))).toBe(true);
  });

  it("rejects non-matching domain", () => {
    expect(isEmailAllowed("alice@example.com", makeEnv("gz-zhiyun.com"))).toBe(false);
  });

  it("matches case-insensitively", () => {
    expect(isEmailAllowed("Alice@GZ-Zhiyun.COM", makeEnv("gz-zhiyun.com"))).toBe(true);
    expect(isEmailAllowed("alice@gz-zhiyun.com", makeEnv("GZ-ZHIYUN.COM"))).toBe(true);
  });

  it("rejects email without @", () => {
    expect(isEmailAllowed("notanemail", makeEnv("gz-zhiyun.com"))).toBe(false);
  });

  it("rejects email with multiple @", () => {
    expect(isEmailAllowed("a@b@c.com", makeEnv("c.com"))).toBe(false);
  });

  it("rejects email with empty domain", () => {
    expect(isEmailAllowed("alice@", makeEnv("gz-zhiyun.com"))).toBe(false);
  });

  it("matches across multi-domain list", () => {
    const env = makeEnv("gz-zhiyun.com,partner.example");
    expect(isEmailAllowed("a@gz-zhiyun.com", env)).toBe(true);
    expect(isEmailAllowed("b@partner.example", env)).toBe(true);
    expect(isEmailAllowed("c@evil.com", env)).toBe(false);
  });
});
