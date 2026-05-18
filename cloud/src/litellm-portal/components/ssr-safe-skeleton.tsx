import React from "react";
import { SkeletonLine } from "@cloudflare/kumo/components/loader";
import { useHasHydrated } from "../a11y/use-has-hydrated";

export type SsrSafeSkeletonProps = {
  minWidth?: number;
  maxWidth?: number;
  blockHeight?: number;
  className?: string;
};

/**
 * #418-safe wrapper for Kumo `SkeletonLine` (Phase-3 Task 0B / pre-existing
 * shipped defect fix). Kumo `SkeletonLine` derives --skeleton-width /
 * --shimmer-* from UNSEEDED Math.random() at render → SSR ≠ client first
 * render → React #418. This wrapper renders a DETERMINISTIC, random-free
 * placeholder on SSR + the client's first (hydration) render (identical on
 * both sides), then swaps to the real animated `SkeletonLine` post-hydration
 * (client-only, so its randomness never participates in hydration). NO
 * `suppressHydrationWarning` — this is a real deterministic-SSR fix.
 */
export function SsrSafeSkeleton({ minWidth = 80, maxWidth, blockHeight = 16, className }: SsrSafeSkeletonProps) {
  const hydrated = useHasHydrated();
  if (!hydrated) {
    // Deterministic placeholder: fixed geometry from props, NO Math.random,
    // NO inline random style — byte-identical on SSR and client-first-render.
    // Uses the same Kumo skeleton surface token so the visual swap is subtle.
    return (
      <div
        data-ssr-skeleton-placeholder
        aria-hidden="true"
        className={`animate-none rounded bg-kumo-recessed${className ? " " + className : ""}`}
        style={{ width: `${minWidth}px`, height: `${blockHeight}px` }}
      />
    );
  }
  return <SkeletonLine minWidth={minWidth} maxWidth={maxWidth} blockHeight={blockHeight} />;
}
