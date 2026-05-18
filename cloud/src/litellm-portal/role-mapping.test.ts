import { describe, expect, it } from "vitest";
import { mapLiteLLMRole, litellmRoleToTier } from "./role-mapping";

describe("litellmRoleToTier — LiteLLM single source of truth, pure fail-closed", () => {
  it("proxy_admin → admin", () => {
    expect(litellmRoleToTier("proxy_admin")).toBe("admin");
  });
  it("proxy_admin_viewer → admin_viewer (read-only owner, no escalation)", () => {
    expect(litellmRoleToTier("proxy_admin_viewer")).toBe("admin_viewer");
  });
  it("internal_user → user", () => {
    expect(litellmRoleToTier("internal_user")).toBe("user");
  });
  it("any other non-empty LiteLLM role → user", () => {
    expect(litellmRoleToTier("internal_user_viewer")).toBe("user");
    expect(litellmRoleToTier("something_new")).toBe("user");
  });
  it("null → none (fail-closed: LiteLLM unreachable/unmapped grants nothing)", () => {
    expect(litellmRoleToTier(null)).toBe("none");
  });
  it("empty/whitespace → none", () => {
    expect(litellmRoleToTier("")).toBe("none");
    expect(litellmRoleToTier("   ")).toBe("none");
  });
});

describe("mapLiteLLMRole", () => {
  it("role is purely litellmRoleToTier(litellmRole) — no IndexDO input", () => {
    expect(mapLiteLLMRole({ litellmRole: "proxy_admin", litellmTeamIds: [] }).role).toBe("admin");
    expect(mapLiteLLMRole({ litellmRole: "proxy_admin_viewer", litellmTeamIds: [] }).role).toBe("admin_viewer");
    expect(mapLiteLLMRole({ litellmRole: "internal_user", litellmTeamIds: [] }).role).toBe("user");
    expect(mapLiteLLMRole({ litellmRole: null, litellmTeamIds: [] }).role).toBe("none");
  });
  it("tenant facet: IndexDO invite teamId wins over LiteLLM teams[0]", () => {
    const r = mapLiteLLMRole({
      litellmRole: null,
      litellmTeamIds: ["llm-team-a", "llm-team-b"],
      indexTeamId: "idx-team-x",
    });
    expect(r.tenantTeamId).toBe("idx-team-x");
  });
  it("tenant facet: falls back to LiteLLM teams[0] when no IndexDO teamId", () => {
    const r = mapLiteLLMRole({
      litellmRole: "proxy_admin_viewer",
      litellmTeamIds: ["ea0e8075", "1255c10b"],
      indexTeamId: null,
    });
    expect(r.tenantTeamId).toBe("ea0e8075");
    expect(r.role).toBe("admin_viewer");
  });
  it("tenant facet: null when neither source has a team", () => {
    expect(mapLiteLLMRole({ litellmRole: "proxy_admin", litellmTeamIds: [] }).tenantTeamId).toBeNull();
  });
});
