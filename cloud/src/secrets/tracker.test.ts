import { describe, expect, it } from "vitest";

import {
  TRACKER_SECRET_PROVIDERS,
  TRACKER_SECRETS_STORE_NAME,
  trackerSecretName,
  type TrackerSecretProvider,
} from "./tracker";

describe("tracker secret naming", () => {
  it("uses the account Secrets Store reserved for tracker credentials", () => {
    expect(TRACKER_SECRETS_STORE_NAME).toBe("default_secrets_store");
  });

  it.each([
    { provider: "linear", expected: "tracker/team-alpha/linear" },
    { provider: "github", expected: "tracker/team-alpha/github" },
  ] satisfies Array<{ provider: TrackerSecretProvider; expected: string }>)
    ("formats $provider tracker secrets under the team prefix", ({ provider, expected }) => {
      expect(trackerSecretName("team-alpha", provider)).toBe(expected);
    });

  it("publishes the supported tracker providers", () => {
    expect(TRACKER_SECRET_PROVIDERS).toEqual(["linear", "github"]);
  });

  it.each(["", "   "])("rejects blank team ids", (teamId) => {
    expect(() => trackerSecretName(teamId, "linear")).toThrow("teamId is required");
  });

  it("rejects team ids that would escape the per-team namespace", () => {
    expect(() => trackerSecretName("team/alpha", "github")).toThrow("teamId must not contain '/'");
  });
});
