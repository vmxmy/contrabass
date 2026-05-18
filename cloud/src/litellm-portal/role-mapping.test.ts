import { describe, expect, it } from "vitest";
import { mapLiteLLMRole } from "./role-mapping";

describe("mapLiteLLMRole", () => {
  it("proxy_admin → admin", () => {
    expect(mapLiteLLMRole({ indexRole: "none", litellmRole: "proxy_admin", litellmTeamIds: [] }).role).toBe("admin");
  });
  it("proxy_admin_viewer → admin (read-only owner, nav-equivalent)", () => {
    expect(mapLiteLLMRole({ indexRole: "none", litellmRole: "proxy_admin_viewer", litellmTeamIds: [] }).role).toBe("admin");
  });
  it("normal user with no litellm role keeps IndexDO role", () => {
    expect(mapLiteLLMRole({ indexRole: "user", litellmRole: null, litellmTeamIds: [] }).role).toBe("user");
  });
  it("unknown litellm role keeps IndexDO role", () => {
    expect(mapLiteLLMRole({ indexRole: "user", litellmRole: "internal_user", litellmTeamIds: [] }).role).toBe("user");
  });
  it("none IndexDO + no litellm role stays none", () => {
    expect(mapLiteLLMRole({ indexRole: "none", litellmRole: null, litellmTeamIds: [] }).role).toBe("none");
  });
  it("IndexDO teamId wins over LiteLLM teams[0]", () => {
    const r = mapLiteLLMRole({
      indexRole: "user", litellmRole: null, litellmTeamIds: ["llm-team-a", "llm-team-b"],
      indexTeamId: "idx-team-x",
    });
    expect(r.tenantTeamId).toBe("idx-team-x");
  });
  it("falls back to LiteLLM teams[0] when IndexDO has no teamId", () => {
    const r = mapLiteLLMRole({
      indexRole: "user", litellmRole: "proxy_admin_viewer",
      litellmTeamIds: ["ea0e8075", "1255c10b"], indexTeamId: null,
    });
    expect(r.tenantTeamId).toBe("ea0e8075");
    expect(r.role).toBe("admin");
  });
});
