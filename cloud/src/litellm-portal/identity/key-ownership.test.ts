import { describe, it, expect } from "vitest";
import { keyBelongsToUser, type KeyOwner } from "../litellm";

// Fixtures mirror the live LiteLLM_VerificationToken shapes:
//  - portal keys with user_id = slug (e.g. "laoxu")
//  - legacy keys with metadata.portal_email = slug OR email OR absent
//  - dashboard keys under user_id = "default_user_id"
const laoxu: KeyOwner = { litellmUserId: "laoxu", emailLc: "xu@ziikoo.com" };

describe("keyBelongsToUser — 4-tier precedence", () => {
  it("tier 1: matches the real LiteLLM user_id coupling key", () => {
    expect(keyBelongsToUser({ user_id: "laoxu", metadata: {} }, laoxu)).toBe(true);
  });

  it("tier 2: matches the new structured cb_identity tag", () => {
    const rec = {
      user_id: "default_user_id",
      metadata: { cb_identity: { litellm_user_id: "laoxu", email_lc: "xu@ziikoo.com", v: 1 } },
    };
    expect(keyBelongsToUser(rec, laoxu)).toBe(true);
  });

  it("tier 3: legacy portal_email holding the SLUG still matches", () => {
    // observed live: {"portal_email": "laoxu"}
    expect(keyBelongsToUser({ user_id: "default_user_id", metadata: { portal_email: "laoxu" } }, laoxu)).toBe(true);
  });

  it("tier 3: legacy portal_email holding the EMAIL still matches", () => {
    // observed live: {"portal_email": "xu@ziikoo.com"}
    expect(
      keyBelongsToUser({ user_id: "default_user_id", metadata: { portal_email: "xu@ziikoo.com" } }, laoxu),
    ).toBe(true);
  });

  it("tier 4: falls back to key.user_email", () => {
    expect(keyBelongsToUser({ user_email: "xu@ziikoo.com", metadata: {} }, laoxu)).toBe(true);
  });

  it("does NOT short-circuit to false on a present-but-mismatched user_id (the old bug)", () => {
    // old code returned false here because user_id was present and != owner;
    // new code keeps checking metadata and matches via the structured tag.
    const rec = {
      user_id: "default_user_id",
      metadata: { cb_identity: { litellm_user_id: "laoxu", email_lc: "xu@ziikoo.com", v: 1 } },
    };
    expect(keyBelongsToUser(rec, laoxu)).toBe(true);
  });

  it("returns false when nothing matches", () => {
    expect(
      keyBelongsToUser({ user_id: "someoneelse", metadata: { portal_email: "other@x.com" } }, laoxu),
    ).toBe(false);
  });

  it("email tiers are skipped when owner has no emailLc (migration gate path)", () => {
    const slugOnly: KeyOwner = { litellmUserId: "laoxu" };
    expect(keyBelongsToUser({ user_email: "xu@ziikoo.com", metadata: {} }, slugOnly)).toBe(false);
    expect(keyBelongsToUser({ user_id: "laoxu", metadata: {} }, slugOnly)).toBe(true);
  });
});
