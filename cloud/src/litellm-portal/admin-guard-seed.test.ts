import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const client = readFileSync("src/litellm-portal/client.tsx", "utf8");
const serverImpl = readFileSync("src/litellm-portal/server-impl.tsx", "utf8");

describe("F5/D4 router role seed (server-authoritative, client-optimized)", () => {
  it("client seeds context.role from the SSR hydration state", () => {
    expect(client).toContain("readClientHydrationState(document)");
    expect(client).toContain("createPortalRouter(history, { role })");
  });
  it("server seeds context.role from the resolved identity", () => {
    expect(serverImpl).toContain("createPortalRouter(history, { role })");
    expect(serverImpl).toContain("identity.role");
  });
});
