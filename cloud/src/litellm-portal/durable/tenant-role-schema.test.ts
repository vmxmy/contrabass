import { describe, it, expect } from "vitest";
import { TenantRoleRecordSchema } from "./schemas";

describe("TenantRoleRecordSchema", () => {
  it("accepts a valid tenant_admin record", () => {
    const rec = {
      userId: "user_abc",
      teamId: "team_acme",
      tenantRole: "tenant_admin" as const,
      updatedBy: "owner@x.com",
      updatedAt: new Date().toISOString(),
    };
    expect(TenantRoleRecordSchema.parse(rec)).toEqual(rec);
  });

  it("accepts a member record", () => {
    expect(TenantRoleRecordSchema.parse({
      userId: "u", teamId: "t", tenantRole: "member",
      updatedBy: "o@x.com", updatedAt: new Date().toISOString(),
    }).tenantRole).toBe("member");
  });

  it("rejects an unknown role", () => {
    expect(() => TenantRoleRecordSchema.parse({
      userId: "u", teamId: "t", tenantRole: "boss",
      updatedBy: "o@x.com", updatedAt: new Date().toISOString(),
    })).toThrow();
  });

  it("rejects a bad datetime", () => {
    expect(() => TenantRoleRecordSchema.parse({
      userId: "u", teamId: "t", tenantRole: "member",
      updatedBy: "o@x.com", updatedAt: "not-a-date",
    })).toThrow();
  });

  it("rejects extra keys (strict)", () => {
    expect(() => TenantRoleRecordSchema.parse({
      userId: "u", teamId: "t", tenantRole: "member",
      updatedBy: "o@x.com", updatedAt: new Date().toISOString(), extra: 1,
    })).toThrow();
  });
});
