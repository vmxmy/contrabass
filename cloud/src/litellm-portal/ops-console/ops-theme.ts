import type React from "react";

/**
 * Fixed steel accent for the Operations Console.
 *
 * The Ops Console is platform-internal and Owner-only. Unlike the Tenant
 * Portal it never adopts per-tenant branding — a single, deliberately neutral
 * steel accent signals "internal / privileged platform surface". Only the two
 * real Kumo brand tokens (`--kumo-brand`, `--kumo-brand-hover`) are emitted, so
 * no Kumo fork or semantic-token override is needed. Applied as an inline
 * `style` on the shell root; pure, SSR-safe (no DOM/window).
 */
export const OPS_STEEL_ACCENT: React.CSSProperties = {
  "--kumo-brand": "#475569",
  "--kumo-brand-hover": "#334155",
} as React.CSSProperties;
