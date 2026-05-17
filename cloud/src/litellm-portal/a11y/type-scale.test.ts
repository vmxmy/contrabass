import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * §F.5 (V2.0 §1.1): the DESIGN.md Typography Hierarchy table IS the token
 * source of truth for the portal's type scale. Parse its rows and assert the
 * V2.0 ceilings. Reads the real file (no fixture drift).
 */
function typographyTiers(): Array<{ token: string; maxPx: number }> {
  const md = readFileSync("src/litellm-portal/DESIGN.md", "utf8");
  const start = md.indexOf("### Hierarchy");
  expect(start, "DESIGN.md must have a Typography ### Hierarchy table").toBeGreaterThan(-1);
  const block = md.slice(start, md.indexOf("\n## ", start));
  const rows = block
    .split("\n")
    .filter((l) => l.startsWith("| ") && !/^\|\s*Token\s*\|/.test(l) && !/^\|\s*-+/.test(l));
  return rows.map((l) => {
    const cols = l.split("|").map((c) => c.trim());
    const token = cols[1];
    // Size cell e.g. "30px → 36px desktop" / "14px → 16px" / "18px" — take the
    // largest px number present (the desktop/ceiling value).
    const pxs = [...cols[2].matchAll(/(\d+)px/g)].map((m) => Number(m[1]));
    return { token, maxPx: Math.max(...pxs) };
  });
}

describe("§F.5 type-scale audit (V2.0 §1.1)", () => {
  it("DESIGN.md Typography Hierarchy has at most 7 token tiers", () => {
    const tiers = typographyTiers();
    expect(
      tiers.length,
      `Type scale has ${tiers.length} tiers (${tiers.map((t) => t.token).join(", ")}); V2.0 §1.1 ceiling is 7`,
    ).toBeLessThanOrEqual(7);
  });

  it("largest heading tier is at most 2x the body tier (V2.0 §1.1: 1.5–2x)", () => {
    const tiers = typographyTiers();
    const body = tiers.find((t) => /^Body$/i.test(t.token));
    expect(body, "a 'Body' tier must exist").toBeTruthy();
    const headingPx = Math.max(
      ...tiers.filter((t) => /title|heading/i.test(t.token)).map((t) => t.maxPx),
    );
    const ratio = headingPx / (body as { maxPx: number }).maxPx;
    expect(
      ratio,
      `heading:body ratio is ${ratio.toFixed(2)}x (heading ${headingPx}px / body ${(body as { maxPx: number }).maxPx}px); V2.0 §1.1 ceiling is 2.0x`,
    ).toBeLessThanOrEqual(2.0);
  });
});
