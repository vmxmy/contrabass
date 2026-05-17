import { describe, it, expect } from "vitest";
import { applyBrandVars, isAccessibleBrand } from "./branding";

describe("tenant branding", () => {
  // --- plan-spec tests (exact) ---

  it("maps a valid brand color to --kumo-brand* CSS vars only", () => {
    const v = applyBrandVars({
      name: "ACME",
      logoUrl: null,
      primaryColor: "#1f6feb",
    }) as Record<string, string>;
    expect(v["--kumo-brand"]).toBe("#1f6feb");
    expect(Object.keys(v).every((k) => k.startsWith("--kumo-brand"))).toBe(true);
  });

  it("falls back to default brand when color missing or low-contrast (both modes)", () => {
    expect(applyBrandVars({ name: "X", logoUrl: null, primaryColor: null })).toEqual({});
    expect(isAccessibleBrand("#ffffff")).toBe(false);
    expect(isAccessibleBrand("#1f6feb")).toBe(true);
  });

  it("rejects malformed color (no injection)", () => {
    expect(applyBrandVars({ name: "X", logoUrl: null, primaryColor: "red;}<script>" })).toEqual({});
  });

  // --- extra edge cases ---

  it("rejects 3-digit hex (strict 6-digit only)", () => {
    expect(applyBrandVars({ name: "X", logoUrl: null, primaryColor: "#fff" })).toEqual({});
    expect(isAccessibleBrand("#fff")).toBe(false);
  });

  it("accepts uppercase 6-digit hex (case-insensitive)", () => {
    const v = applyBrandVars({
      name: "ACME",
      logoUrl: null,
      primaryColor: "#1F6FEB",
    }) as Record<string, string>;
    // normalize to the value passed in (lowercase or uppercase doesn't matter; we just echo it)
    expect(v["--kumo-brand"]).toBe("#1F6FEB");
    expect(Object.keys(v).every((k) => k.startsWith("--kumo-brand"))).toBe(true);
  });

  it("rejects a color that fails dark-mode contrast even if light passes (white)", () => {
    // #ffffff: contrast vs light canvas ≈1.03 (fail) AND vs dark canvas ≈17 (pass)
    // Fails light → should return {}
    expect(applyBrandVars({ name: "X", logoUrl: null, primaryColor: "#ffffff" })).toEqual({});
  });

  it("rejects a near-white color that passes dark but fails light", () => {
    // #f0f0f0 is very light; contrast vs light canvas ≈1.07 (fail)
    expect(applyBrandVars({ name: "X", logoUrl: null, primaryColor: "#f0f0f0" })).toEqual({});
    expect(isAccessibleBrand("#f0f0f0")).toBe(false);
  });

  it("rejects injection attempts: whitespace, missing hash, rgb(), var(), url()", () => {
    const bad = [
      " #1f6feb",
      "#1f6feb ",
      "1f6feb",
      "rgb(31, 111, 235)",
      "var(--x)",
      "url(//evil)",
      "#1f6feb;<script>",
      "expression(alert(1))",
      "",
    ];
    for (const c of bad) {
      expect(applyBrandVars({ name: "X", logoUrl: null, primaryColor: c })).toEqual({});
    }
  });

  it("isAccessibleBrand: rejects pure black (fails dark-canvas contrast)", () => {
    // #000000 vs light canvas: ~20:1 (passes), vs dark canvas #1a1a1a: ~1.2:1 (fails).
    // Black-on-near-black is invisible in dark mode → correctly rejected.
    expect(isAccessibleBrand("#000000")).toBe(false);
  });

  it("applyBrandVars emits only --kumo-brand* keys, never semantic/hierarchy tokens", () => {
    const v = applyBrandVars({
      name: "Corp",
      logoUrl: "https://example.com/logo.png",
      primaryColor: "#1f6feb",
    }) as Record<string, string>;
    const keys = Object.keys(v);
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) {
      expect(k.startsWith("--kumo-brand")).toBe(true);
      // Never semantic tokens
      expect(k).not.toMatch(/--kumo-(canvas|elevated|recessed|base|strong|default|subtle|line)/);
    }
  });
});

describe("§C extended 6-surface brand guard", () => {
  it("still rejects every non-#rrggbb form → {} (injection contract unchanged)", () => {
    for (const bad of [
      "#fff", "red", "rgb(0,0,0)", "var(--x)", "url(x)", " #112233 ",
      "#11223", "#1122334", "#gggggg", "</style>", "#112233;color:red",
    ]) {
      expect(applyBrandVars({ name: "n", logoUrl: null, primaryColor: bad })).toEqual({});
    }
  });

  it("a color passing canvas+elevated+tint on BOTH modes is accepted and emits ONLY brand vars", () => {
    // Witness swapped from #1f3a8a → #1f6feb per Step-1's explicit
    // "swap the witness if it does not land on the intended side of 3:1"
    // allowance: #1f3a8a empirically fails the stricter 6-surface guard
    // (min ratio 1.46 against the dark-tint surface), whereas #1f6feb —
    // the canonical Phase-1 accepted brand — clears all 6 surfaces
    // (min 3.27). The invariant under test ("6-surface all-or-nothing
    // accept") is unchanged; only the literal witness hex changed.
    const out = applyBrandVars({ name: "n", logoUrl: null, primaryColor: "#1f6feb" });
    expect(Object.keys(out).sort()).toEqual(["--kumo-brand", "--kumo-brand-hover"]);
    expect((out as Record<string, string>)["--kumo-brand"]).toBe("#1f6feb");
  });

  it("ALL-OR-NOTHING: a color passing canvas but failing elevated OR tint on either mode → {}", () => {
    // Mid-tone that clears the canvas-only Phase-1 bar but fails on the
    // lighter elevated/tint surface (the accepted §E-3 trade-off: some
    // Phase-1-passing tenants now fall back).
    const midtone = "#8a8f99";
    expect(isAccessibleBrand("#8a8f99")).toBe(false);
    expect(applyBrandVars({ name: "n", logoUrl: null, primaryColor: midtone })).toEqual({});
  });

  it("regression: a documented Phase-1-passing color may now fall back (accepted, still WCAG-AA)", () => {
    // This color cleared Phase-1 canvas-only (3:1 on #fafafa & #1a1a1a) but
    // fails the stricter elevated/tint surfaces → {} under §C. Asserting the
    // accepted trade-off explicitly so it is a conscious, tested behavior.
    const phase1OnlyPass = "#9ca3af";
    expect(applyBrandVars({ name: "n", logoUrl: null, primaryColor: phase1OnlyPass })).toEqual({});
  });
});
