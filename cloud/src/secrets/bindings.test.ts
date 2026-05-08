import { describe, expect, it } from "vitest";

import apiWranglerToml from "../../wrangler.toml?raw";
import trackerPollerWranglerToml from "../../wrangler.tracker-poller.toml?raw";

describe("tracker Secrets Store bindings", () => {
  it("does not bind tracker secrets to the API Worker config", () => {
    expect(apiWranglerToml).not.toContain("secrets_store_secrets");
    expect(apiWranglerToml).not.toContain("tracker/synthetic-smoke/linear");
    expect(apiWranglerToml).not.toContain("tracker/synthetic-smoke/github");
  });

  it("binds tracker secrets only in the tracker poller Worker config", () => {
    expect(trackerPollerWranglerToml).toContain('name = "contrabass-tracker-poller"');
    expect(trackerPollerWranglerToml).toContain("[[secrets_store_secrets]]");
    expect(trackerPollerWranglerToml).toContain('secret_name = "tracker/synthetic-smoke/linear"');
    expect(trackerPollerWranglerToml).toContain('secret_name = "tracker/synthetic-smoke/github"');
  });

  it("redeclares Secrets Store bindings for each deploy environment", () => {
    expect(countOccurrences(trackerPollerWranglerToml, "[[secrets_store_secrets]]")).toBe(2);
    expect(countOccurrences(trackerPollerWranglerToml, "[[env.staging.secrets_store_secrets]]")).toBe(2);
    expect(countOccurrences(trackerPollerWranglerToml, "[[env.production.secrets_store_secrets]]")).toBe(2);
  });
});

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}
