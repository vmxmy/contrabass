import type React from "react";

/**
 * Tenant brand → `--kumo-brand*` CSS custom property mapper.
 *
 * Safety contract:
 *   - Only strict `#rrggbb` hex accepted (regex-validated). All other forms
 *     (3-digit, named, rgb(), var(), url(), whitespace, injection payloads) are
 *     rejected and produce `{}` (Kumo default branding).
 *   - Only `--kumo-brand` and `--kumo-brand-hover` are emitted — both are real
 *     Kumo tokens confirmed in @cloudflare/kumo theme-kumo.css. No other CSS
 *     vars are ever set.
 *   - WCAG-AA Non-text Contrast (SC 1.4.11, ratio ≥ 3:1) is enforced against
 *     BOTH the light canvas surface and the dark canvas surface. A color that
 *     fails either mode falls back to `{}`.
 *   - Pure function: no DOM, no window, SSR-safe.
 *
 * Surface colors used for contrast checks (from theme-kumo.css):
 *   Light: --color-kumo-canvas light = oklch(98.75% 0 0) ≈ #fafafa
 *   Dark:  --color-kumo-canvas dark  = oklch(10% 0 0)    ≈ #1a1a1a
 *
 * WCAG threshold: 3:1 (Non-text Contrast, SC 1.4.11) — chosen because
 * --kumo-brand is used as a UI accent (CTA backgrounds, chart strokes, focus
 * rings), not as body text against its containing surface.
 */

/** Strict 6-digit hex regex — rejects 3-digit, injection, whitespace etc. */
const HEX6_RE = /^#[0-9a-fA-F]{6}$/;

/**
 * Light canvas surface for contrast check.
 * oklch(98.75% 0 0) is achromatic near-white; sRGB ≈ #fafafa.
 */
const LIGHT_CANVAS_LUMINANCE = relativeLuminanceFromHex("#fafafa");

/**
 * Dark canvas surface for contrast check.
 * oklch(10% 0 0) is achromatic near-black; sRGB ≈ #1a1a1a.
 */
const DARK_CANVAS_LUMINANCE = relativeLuminanceFromHex("#1a1a1a");

/** WCAG 2.1 SC 1.4.11 Non-text Contrast threshold. */
const WCAG_AA_UI_RATIO = 3.0;

// ---------------------------------------------------------------------------
// WCAG math — no external deps
// ---------------------------------------------------------------------------

/** Convert an 8-bit channel [0-255] to a linear-light value per WCAG 2.x. */
function channelToLinear(c8: number): number {
  const c = c8 / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * WCAG relative luminance of an sRGB triplet (each channel 0–255).
 * Formula: https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
 */
function relativeLuminance(r8: number, g8: number, b8: number): number {
  return (
    0.2126 * channelToLinear(r8) +
    0.7152 * channelToLinear(g8) +
    0.0722 * channelToLinear(b8)
  );
}

/**
 * Parse a validated `#rrggbb` string into [r, g, b] (0–255 each).
 * Caller must ensure `hex` matches HEX6_RE before calling.
 */
function parseHex(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

/** Relative luminance from a validated `#rrggbb` string. */
function relativeLuminanceFromHex(hex: string): number {
  const [r, g, b] = parseHex(hex);
  return relativeLuminance(r, g, b);
}

/** WCAG contrast ratio between two relative luminance values. */
function contrastRatio(l1: number, l2: number): number {
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

// ---------------------------------------------------------------------------
// Hover derivation
// ---------------------------------------------------------------------------

/**
 * Produce a darker variant of the brand color for `--kumo-brand-hover`.
 * Reduces each channel by 15% (clamped to 0) — a simple, deterministic
 * darkening that does not require a color library.
 */
function darkenHex(hex: string): string {
  const [r, g, b] = parseHex(hex);
  const d = (c: number) =>
    Math.max(0, Math.round(c * 0.85))
      .toString(16)
      .padStart(2, "0");
  return `#${d(r)}${d(g)}${d(b)}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return `true` if `color` is a valid strict `#rrggbb` hex AND achieves
 * WCAG AA Non-text Contrast (≥ 3:1) against BOTH the Kumo light canvas and
 * the Kumo dark canvas surfaces.
 */
export function isAccessibleBrand(color: string): boolean {
  if (!HEX6_RE.test(color)) return false;
  const brandL = relativeLuminanceFromHex(color);
  const lightContrast = contrastRatio(brandL, LIGHT_CANVAS_LUMINANCE);
  const darkContrast = contrastRatio(brandL, DARK_CANVAS_LUMINANCE);
  return lightContrast >= WCAG_AA_UI_RATIO && darkContrast >= WCAG_AA_UI_RATIO;
}

/**
 * Map a tenant brand into `--kumo-brand*` CSS custom properties to apply on
 * the tenant portal shell root element.
 *
 * Returns `{}` (Kumo defaults) when:
 *   - `primaryColor` is absent / null
 *   - `primaryColor` is not strict `#rrggbb` (injection safety)
 *   - The color fails WCAG AA Non-text Contrast on either light or dark canvas
 *
 * Only emits `--kumo-brand` and `--kumo-brand-hover` — real Kumo tokens
 * confirmed in @cloudflare/kumo@2.1.0 theme-kumo.css. Never emits semantic,
 * surface, text, or hierarchy tokens.
 */
export function applyBrandVars(b: {
  name: string;
  logoUrl: string | null;
  primaryColor: string | null;
}): React.CSSProperties {
  if (b.primaryColor === null) return {};
  if (!isAccessibleBrand(b.primaryColor)) return {};

  return {
    "--kumo-brand": b.primaryColor,
    "--kumo-brand-hover": darkenHex(b.primaryColor),
  } as React.CSSProperties;
}
