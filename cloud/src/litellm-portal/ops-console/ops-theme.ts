import type React from "react";

/**
 * Fixed steel accent for the Operations Console.
 *
 * SANCTIONED RAW-HEX EXCEPTION (V2.0 §1.3 / Phase-3 §F.6): V2.0 forbids
 * hardcoded colors (everything via tokens). These two hex values are the
 * SINGLE approved exception in the entire portal source: the Ops fixed-steel
 * brand-voltage override. The Ops Console is platform-internal and Owner-only;
 * unlike the Tenant Portal it NEVER adopts per-tenant branding — a deliberately
 * neutral steel signals "internal / privileged" (Phase-2 invariant: Ops
 * ignores tenant branding, §C.3). Only the two real Kumo brand tokens are
 * emitted (no Kumo fork, no semantic-token override). Any OTHER raw #rrggbb in
 * portal source is a defect — guarded by ops-theme.test.ts. Pure, SSR-safe.
 */
export const OPS_STEEL_BRAND = "#475569";
export const OPS_STEEL_BRAND_HOVER = "#334155";

export const OPS_STEEL_ACCENT: React.CSSProperties = {
  "--kumo-brand": OPS_STEEL_BRAND,
  "--kumo-brand-hover": OPS_STEEL_BRAND_HOVER,
} as React.CSSProperties;
