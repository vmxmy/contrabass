/**
 * Single source of the shared focus-visible ring.
 *
 * Phase-3 §A.1 promotes DESIGN.md's existing `select` focus convention
 * (`focus-visible:ring-2 focus-visible:ring-kumo-brand`) to a portal-wide
 * utility so navigation, panel actions and clickable cards no longer rely on
 * the browser-default outline. `--kumo-brand` resolves to the tenant brand on
 * the Tenant Portal and to fixed steel on Ops (the shell sets the var); its
 * non-text contrast (>=3:1) on both light and dark canvas is enforced for any
 * legal brand by tenant-portal/branding.ts (extended in Task 8). Pure string,
 * no DOM, SSR-safe.
 */
export const FOCUS_RING =
  "focus-visible:ring-2 focus-visible:ring-kumo-brand focus-visible:ring-offset-2 focus-visible:outline-none";
