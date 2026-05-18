import { describe, it, expect } from "vitest";
import {
  deterministicUserId,
  normalizeEmail,
  isReservedLiteLLMUserId,
  RESERVED_LITELLM_USER_IDS,
} from "./derive-user-id";

describe("normalizeEmail", () => {
  it("trims and lowercases (absorbs the live trailing-space/case noise)", () => {
    // #given the observed `wangxiaoyi@gz-zhiyun.com ` trailing-space row
    expect(normalizeEmail("wangxiaoyi@gz-zhiyun.com ")).toBe("wangxiaoyi@gz-zhiyun.com");
    expect(normalizeEmail("  XU@Ziikoo.COM  ")).toBe("xu@ziikoo.com");
  });
});

describe("deterministicUserId", () => {
  it("is deterministic modulo trailing space and case", () => {
    const a = deterministicUserId("liqingying@gz-zhiyun.com");
    expect(deterministicUserId("  LiQingYing@GZ-Zhiyun.com ")).toBe(a);
  });

  it("shapes as <local-slug>-<8 hex>", () => {
    expect(deterministicUserId("liqingying@gz-zhiyun.com")).toMatch(/^liqingying-[0-9a-f]{8}$/);
  });

  it("distinguishes different emails whose local parts slugify identically", () => {
    // #given two emails whose local part collapses to the same slug
    const x = deterministicUserId("li.qing.ying@a.com");
    const y = deterministicUserId("li-qing-ying@b.com");
    // #then the full-email hash suffix keeps them distinct
    expect(x).not.toBe(y);
    expect(x.startsWith("li-qing-ying-")).toBe(true);
    expect(y.startsWith("li-qing-ying-")).toBe(true);
  });

  it("falls back to a 'user' slug when the local part has no alphanumerics", () => {
    expect(deterministicUserId("+++@x.com")).toMatch(/^user-[0-9a-f]{8}$/);
  });
});

describe("reserved LiteLLM accounts", () => {
  it("excludes the observed special accounts", () => {
    expect(isReservedLiteLLMUserId("admin")).toBe(true);
    expect(isReservedLiteLLMUserId("default_user_id")).toBe(true);
    expect(isReservedLiteLLMUserId("agent-app")).toBe(true);
    expect(isReservedLiteLLMUserId(" default_user_id ")).toBe(true);
  });

  it("does not flag a normal slug", () => {
    expect(isReservedLiteLLMUserId("laoxu")).toBe(false);
    expect(RESERVED_LITELLM_USER_IDS.has("laoxu")).toBe(false);
  });
});
