import { describe, expect, it } from "vitest";
import { FOCUS_RING } from "./focus";
import { relativeLuminanceFromHex, contrastRatio } from "../tenant-portal/branding";

describe("shared focus ring", () => {
  it("FOCUS_RING is the canonical Kumo focus-visible utility string", () => {
    expect(FOCUS_RING).toBe(
      "focus-visible:ring-2 focus-visible:ring-kumo-brand focus-visible:ring-offset-2 focus-visible:outline-none",
    );
  });

  it("a legal brand color's focus ring clears WCAG non-text contrast (>=3:1) on light AND dark canvas", () => {
    // Sample legal brand (passes Phase-1 isAccessibleBrand): Cloudflare-orange-ish.
    const brand = relativeLuminanceFromHex("#b45309");
    const light = relativeLuminanceFromHex("#fafafa");
    const dark = relativeLuminanceFromHex("#1a1a1a");
    expect(contrastRatio(brand, light)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(brand, dark)).toBeGreaterThanOrEqual(3);
  });
});
