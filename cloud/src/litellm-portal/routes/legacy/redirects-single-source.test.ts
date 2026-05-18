import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { handleLiteLLMPortalRequest } from "../../index";

const tanstackSrc = readFileSync(
  "src/litellm-portal/routes/legacy/redirects.tsx",
  "utf8",
);
const workerSrc = readFileSync("src/litellm-portal/index.ts", "utf8");

function portalEnv() {
  return {
    LITELLM_PROXY_URL: "https://proxy.test",
    LITELLM_MASTER_KEY: "sk-test",
  } as unknown as Parameters<typeof handleLiteLLMPortalRequest>[1];
}

describe("F5/D5 single redirect authority (layered, documented)", () => {
  it("the worker layer is the legacy-redirect authority for full-page nav", async () => {
    const cases = [
      ["https://portal.test/admin", "/"],
      ["https://portal.test/admin/usage", "/"],
      ["https://portal.test/admin/users/alice", "/manage/users/alice"],
      ["https://portal.test/admin/teams/team-1", "/manage/teams/team-1"],
      ["https://portal.test/admin/audit/event-1", "/manage/audit/event-1"],
      ["https://portal.test/admin/settings", "/manage/settings"],
      ["https://portal.test/preferences", "/manage/preferences"],
    ] as const;

    for (const [url, location] of cases) {
      const response = await handleLiteLLMPortalRequest(
        new Request(url),
        portalEnv(),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(location);
    }
  });

  it("the TanStack SPA-nav copy declares targets consistent with the worker authority", () => {
    const expectedTanstackMappings = [
      ['redirectRoute("/admin", "/")', true],
      ['redirectRoute("/admin/usage", "/")', true],
      ['redirectRoute("/admin/users", "/manage/users")', true],
      ['redirectRoute("/admin/teams", "/manage/teams")', true],
      ['redirectRoute("/admin/audit", "/manage/audit")', true],
      ['redirectRoute("/admin/settings", "/manage/settings")', true],
      ['redirectRoute("/preferences", "/manage/preferences")', true],
    ] as const;
    for (const [fragment] of expectedTanstackMappings) {
      expect(tanstackSrc).toContain(fragment);
    }
    expect(tanstackSrc).toContain("/manage/users/${encodeURIComponent(params.userId)}");
    expect(tanstackSrc).toContain("/manage/teams/${encodeURIComponent(params.teamId)}");
    expect(tanstackSrc).toContain("/manage/audit/${encodeURIComponent(params.eventId)}");
  });

  it("both layered copies document the single-source layering", () => {
    expect(tanstackSrc).toContain("F5/D5");
    expect(workerSrc).toContain("F5/D5");
  });
});
