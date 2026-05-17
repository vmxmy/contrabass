/**
 * Shell-level density scale (Phase-3 §A.2 + §F.1 V2.0 §1.2 fold-in).
 *
 * Tenant Portal = `comfortable` (outward, editorial whitespace); Ops Console =
 * `compact` (inward, B-端 information-dense cockpit). Density is a SHELL
 * decision pushed via context; screens read it, never hard-code padding.
 * Names map only to EXISTING DESIGN.md spacing tokens — no new numbers.
 *
 * §F.1: a user-chosen preference can override the shell default (persisted via
 * the existing preferences channel — see Step 9b). `resolveDensity` is the
 * PURE, SSR-safe resolver (no window/localStorage) so server and client first
 * render the SAME density for the same hydrated preference (#418-safe — same
 * discipline as the rest of the SSR tree).
 */
import React from "react";

export type Density = "comfortable" | "compact";

const DENSITIES: readonly Density[] = ["comfortable", "compact"];

/**
 * Pure resolver: a valid persisted preference wins; otherwise the shell
 * default. Tolerates undefined/garbage (old cached prefs, bad input).
 */
export function resolveDensity(
  pref: Density | undefined,
  shellDefault: Density,
): Density {
  return pref !== undefined && DENSITIES.includes(pref) ? pref : shellDefault;
}

const DensityContext = React.createContext<Density>("comfortable");

export function DensityProvider({
  density,
  children,
}: {
  density: Density;
  children: React.ReactNode;
}) {
  return <DensityContext.Provider value={density}>{children}</DensityContext.Provider>;
}

export function useDensity(): Density {
  return React.useContext(DensityContext);
}

export type DensityClasses = {
  card: string;
  stack: string;
  grid: string;
  /** §F.1 table cell padding (B-端 cockpit vs editorial). */
  cell: string;
  /** §F.1 table row height (compact = fixed dense ≤36px). */
  row: string;
};

export function densityClasses(d: Density): DensityClasses {
  return d === "compact"
    ? { card: "p-4", stack: "space-y-4", grid: "gap-4", cell: "px-3 py-1.5", row: "h-9" }
    : { card: "p-6", stack: "space-y-6", grid: "gap-4", cell: "px-4 py-3", row: "h-auto" };
}
