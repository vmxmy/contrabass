import { describe, expect, it } from "vitest";
import {
  mintImpersonationToken,
  verifyImpersonationToken,
  type ImpersonationContext,
} from "./impersonation";

const SECRET = "test-secret-0123456789";

describe("impersonation token", () => {
  it("mint→verify round-trips the envelope", async () => {
    const now = 1_000_000;
    const token = await mintImpersonationToken(SECRET, {
      realActor: "owner@x.com",
      effectiveTeamId: "team-1",
      now,
    });
    const ctx = await verifyImpersonationToken(SECRET, token, now + 1000);
    expect(ctx).not.toBeNull();
    const c = ctx as ImpersonationContext;
    expect(c.realActor).toBe("owner@x.com");
    expect(c.effectiveTeamId).toBe("team-1");
    expect(c.viaImpersonation).toBe(true);
  });

  it("rejects a tampered token", async () => {
    const token = await mintImpersonationToken(SECRET, {
      realActor: "owner@x.com",
      effectiveTeamId: "team-1",
      now: 1_000_000,
    });
    const tampered = token.slice(0, -2) + "xx";
    expect(await verifyImpersonationToken(SECRET, tampered, 1_000_100)).toBeNull();
  });

  it("rejects past the idle deadline (30 min idle)", async () => {
    const now = 1_000_000;
    const token = await mintImpersonationToken(SECRET, {
      realActor: "owner@x.com",
      effectiveTeamId: "team-1",
      now,
    });
    const afterIdle = now + 31 * 60 * 1000;
    expect(await verifyImpersonationToken(SECRET, token, afterIdle)).toBeNull();
  });

  it("rejects past the absolute deadline (2 h cap)", async () => {
    const now = 1_000_000;
    const token = await mintImpersonationToken(SECRET, {
      realActor: "owner@x.com",
      effectiveTeamId: "team-1",
      now,
    });
    const afterAbsolute = now + 121 * 60 * 1000;
    expect(await verifyImpersonationToken(SECRET, token, afterAbsolute)).toBeNull();
  });
});
