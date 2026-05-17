import { describe, expect, it } from "vitest";
import { app } from "./routes";

function reqOps(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost${path}`, { headers });
}

describe("ops backend gating", () => {
  it("unauthenticated /api/ops/tenants → 401", async () => {
    const res = await app.fetch(reqOps("/api/ops/tenants"), {} as never);
    expect(res.status).toBe(401);
  });

  it("authenticated NON-admin /api/ops/tenants → 403 owner_required (route-level gate)", async () => {
    const env = {
      PORTAL_ALLOWED_EMAIL_DOMAINS: "x.com",
      LITELLM_PORTAL_ALLOWED_EMAILS: "user@x.com",
    } as never;
    const res = await app.fetch(
      reqOps("/api/ops/tenants", { "cf-access-authenticated-user-email": "user@x.com" }),
      env,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "owner_required" });
  });

  it("owner with no INDEX_DO → 503 index_do_unavailable (gate passed, dependency missing)", async () => {
    const env = {
      LITELLM_PORTAL_ALLOWED_EMAILS: "owner@x.com",
      BOOTSTRAP_ADMIN_EMAILS: "owner@x.com",
    } as never;
    const res = await app.fetch(
      reqOps("/api/ops/tenants", { "cf-access-authenticated-user-email": "owner@x.com" }),
      env,
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "index_do_unavailable" });
  });
});
