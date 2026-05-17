/**
 * The four canonical panel-content state treatments (Phase-3 §A.2).
 *
 * Any data-panel / LayerCard query-state branch MUST use exactly one of
 * PanelSkeleton (first-paint placeholder), PanelEmpty (no rows),
 * PanelError (request failed) or PanelLoading (inline/partial). Screens no
 * longer hand-write SkeletonLine/Empty/Banner state branches — these wrap the
 * Kumo primitives once so density, centering, titles and dark-mode are
 * uniform. Contract documented in DESIGN.md ## State Treatments.
 *
 * #418 (Task-0B coupling): PanelSkeleton uses `SsrSafeSkeleton` (Task 0B), NOT
 * raw Kumo `SkeletonLine` — Kumo `SkeletonLine` derives --skeleton-width /
 * --shimmer-* from UNSEEDED Math.random() and is a genuine hydration-mismatch
 * source on the SSR path (pre-existing shipped #418, fixed in Task 0B). The
 * §A.2 convergence migrates screen skeletons INTO PanelSkeleton, so
 * PanelSkeleton MUST inherit the SSR-safety or the §A.2 work would re-introduce
 * the #418 Task 0B just fixed. `SsrSafeSkeleton` renders a deterministic
 * placeholder on SSR + client-first-render, swapping to the real animated
 * SkeletonLine post-hydration (client-only).
 */
import React from "react";
import { Banner } from "@cloudflare/kumo/components/banner";
import { Empty } from "@cloudflare/kumo/components/empty";
import { Loader } from "@cloudflare/kumo/components/loader";
import { SsrSafeSkeleton } from "./ssr-safe-skeleton";
import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";

export function PanelSkeleton({ lines = 2 }: { lines?: number }) {
  return (
    <div className="space-y-3 p-6" data-panel-skeleton>
      <div data-panel-skeleton-title>
        <SsrSafeSkeleton minWidth={80} maxWidth={160} blockHeight={12} />
      </div>
      {Array.from({ length: Math.max(1, lines) }).map((_, i) => (
        <div key={i} data-panel-skeleton-line>
          <SsrSafeSkeleton minWidth={160} maxWidth={400} blockHeight={16} />
        </div>
      ))}
    </div>
  );
}

export function PanelEmpty({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex justify-center py-10" data-panel-empty>
      <Empty size="sm" title={title} description={description} contents={action} />
    </div>
  );
}

export function PanelError({
  title,
  error,
}: {
  title: string;
  error: unknown;
}) {
  const { i18n } = useLingui();
  const raw = error instanceof Error ? error.message : "";
  // §F.3 leak guard: only resolve `raw` through the catalog when it IS a
  // catalog message id (humanized error-message contract / known i18n key).
  // An Error thrown OUTSIDE the extractError boundary — fetch-layer
  // `TypeError: Failed to fetch`, a TanStack Query network error, an aborted
  // request, a pre-extractError JSON parse throw — carries a raw technical
  // English string that is NOT a catalog id; Lingui would echo it verbatim
  // into the Banner (the §F.3 un-mediated-Error leak class). Narrowing to
  // catalog ids only ever REDUCES the leak surface: catalog id → localized,
  // non-catalog/raw → the generic, never-leaking fallback.
  const message =
    raw && i18n.messages[raw] !== undefined ? i18n._(raw) : t`网络请求失败`;
  return (
    <div data-panel-error>
      <Banner variant="error" title={title} description={message} />
    </div>
  );
}

export function PanelLoading({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center py-6" aria-live="polite" data-panel-loading>
      <Loader aria-label={label} />
    </div>
  );
}
