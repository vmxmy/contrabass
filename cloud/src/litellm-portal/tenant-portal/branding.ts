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
 *     the canvas, elevated AND tint surfaces, in BOTH light and dark modes —
 *     6 checks total, ALL-OR-NOTHING (Phase 3 §C / §E-3): if any one of the
 *     6 surface×mode pairs fails, the whole brand falls back to `{}`
 *     (Kumo default). The Phase-1 brandable surface set (CTA, chart stroke)
 *     was widened in Phase 3 to also cover the SideNav active accent bar,
 *     the primary panel-header left bar, the clickable-card active ring and
 *     the brand summary-bar budget meter — all referencing the SAME
 *     `--kumo-brand`, so this 6-surface guard protects every brandable
 *     surface. Accepted trade-off: some Phase-1-passing tenants now fall
 *     back (per-surface partial degradation was explicitly rejected — §E-3).
 *   - Pure function: no DOM, no window, SSR-safe.
 *
 * Surface colors used for contrast checks (from @cloudflare/kumo@2.1.0
 * theme-kumo.css `@theme` block, achromatic — chroma 0 — so the oklch
 * lightness maps directly to a neutral sRGB gray):
 *   canvas   light: --color-kumo-canvas   = oklch(98.75% 0 0) ≈ #fafafa
 *   canvas   dark:  --color-kumo-canvas   = oklch(10% 0 0)    ≈ #1a1a1a
 *   elevated light: --color-kumo-elevated = oklch(98% 0 0)    → #f8f8f8
 *   elevated dark:  --color-kumo-elevated = oklch(12% 0 0)    → #060606
 *   tint     light: --color-kumo-tint     = oklch(97% 0 0)    → #f5f5f5
 *   tint     dark:  --color-kumo-tint     = oklch(26.9% 0 0)  → #262626
 *
 * WCAG threshold: 3:1 (Non-text Contrast, SC 1.4.11) — chosen because
 * --kumo-brand is used as a UI accent (CTA backgrounds, chart strokes, focus
 * rings, active accent bars), not as body text against its containing surface.
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

/**
 * Light/dark elevated surface (theme-kumo.css @theme --color-kumo-elevated).
 * oklch(98% 0 0) → achromatic sRGB #f8f8f8; oklch(12% 0 0) → #060606.
 */
const LIGHT_ELEVATED_LUMINANCE = relativeLuminanceFromHex("#f8f8f8");
const DARK_ELEVATED_LUMINANCE = relativeLuminanceFromHex("#060606");

/**
 * Light/dark tint surface (theme-kumo.css @theme --color-kumo-tint).
 * oklch(97% 0 0) → achromatic sRGB #f5f5f5; oklch(26.9% 0 0) → #262626.
 */
const LIGHT_TINT_LUMINANCE = relativeLuminanceFromHex("#f5f5f5");
const DARK_TINT_LUMINANCE = relativeLuminanceFromHex("#262626");

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
 * WCAG AA Non-text Contrast (≥ 3:1) against the Kumo canvas, elevated AND
 * tint surfaces in BOTH light and dark modes — 6 checks, ALL-OR-NOTHING.
 */
export function isAccessibleBrand(color: string): boolean {
  if (!HEX6_RE.test(color)) return false;
  const brandL = relativeLuminanceFromHex(color);
  const surfaces = [
    LIGHT_CANVAS_LUMINANCE,
    DARK_CANVAS_LUMINANCE,
    LIGHT_ELEVATED_LUMINANCE,
    DARK_ELEVATED_LUMINANCE,
    LIGHT_TINT_LUMINANCE,
    DARK_TINT_LUMINANCE,
  ];
  // All-or-nothing (§E-3): every surface in BOTH modes must clear >=3:1, or
  // the whole brand falls back to Kumo default. Per-surface partial
  // degradation was explicitly rejected (contract complexity / untestable).
  return surfaces.every((s) => contrastRatio(brandL, s) >= WCAG_AA_UI_RATIO);
}

/**
 * Map a tenant brand into `--kumo-brand*` CSS custom properties to apply on
 * the tenant portal shell root element.
 *
 * Returns `{}` (Kumo defaults) when:
 *   - `primaryColor` is absent / null
 *   - `primaryColor` is not strict `#rrggbb` (injection safety)
 *   - The color fails WCAG AA Non-text Contrast on ANY of the 6
 *     surface×mode pairs (canvas/elevated/tint × light/dark) —
 *     all-or-nothing per §E-3
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

// ---------------------------------------------------------------------------
// Re-exports for a11y (Task 1) and the §C extended-surface guard (Task 8).
// Pure WCAG math; no behavior change — only widens visibility.
// ---------------------------------------------------------------------------

export { relativeLuminanceFromHex, contrastRatio, darkenHex };
