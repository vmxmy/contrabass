import { describe, it, expect } from "vitest";
import { handleLoginGet, handleLoginPost } from "./login-routes";

// loginPage() is a private string fn; assert via the public handlers that
// return htmlResp(loginPage(...)). Security-invariant markup MUST persist;
// the restyle is asserted by the new Kumo-aligned visual contract.

async function getLoginHtml(): Promise<string> {
  const res = await handleLoginGet(new Request("http://localhost/login"), {} as never);
  return res.text();
}

describe("§D.2 restyled /login (presentation-only; security flow byte-unchanged)", () => {
  it("preserves the magic-link POST form (security invariant — UNCHANGED)", async () => {
    const html = await getLoginHtml();
    expect(html).toContain('method="POST"');
    expect(html).toContain('action="/login"');
    expect(html).toMatch(/<input[^>]+type="email"[^>]+name="email"/);
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>/); // no-JS submit invariant
  });

  it("is restyled to the Kumo visual language: NO box-shadow, branded button, dark-safe", async () => {
    const html = await getLoginHtml();
    // §B.0: no decorative shadow — depth via hairline/surface, not shadow.
    expect(html).not.toMatch(/box-shadow\s*:/i);
    // Dark-safe: a prefers-color-scheme dark rule exists (standalone no-Kumo
    // SSR page → media-query, the spec-sanctioned local deterministic style).
    expect(html).toMatch(/@media \(prefers-color-scheme: dark\)/);
    // Branded primary button color is the Kumo-aligned brand hex (the
    // sanctioned local constant — see Step 3), not the legacy #0f62fe.
    expect(html).not.toContain("#0f62fe");
  });

  it("still serves a complete no-JS HTML document (SSR/no-JS functional)", async () => {
    const html = await getLoginHtml();
    expect(html).toMatch(/^<!DOCTYPE html>/i);
    expect(html).toContain("</html>");
    expect(html).not.toMatch(/<script\b/i); // no JS dependency introduced
  });
});
