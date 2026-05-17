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
