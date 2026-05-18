/**
 * The ONE card primitive for the LiteLLM Portal (UI seam, Layer-2).
 *
 * Replaces the 4 competing card implementations (audit S3 / supplementary
 * evidence A): Kumo LayerCard, hand-written <article rounded-xl ring-1>,
 * hand-written <div rounded-xl border>, Kumo Surface. Screens MUST use
 * PanelCard and MUST NOT hand-write card chrome (enforced by ratchet.test.ts).
 *
 * Chrome is inherited verbatim from the legacy dashboard `Panel`
 * (rounded-xl + border-kumo-line + bg-kumo-base; header band
 * border-b/bg-kumo-elevated) so this is a behaviour-preserving consolidation,
 * NOT a restyle. The card imposes NO outer margin — vertical rhythm belongs to
 * the parent layout, not the card (legacy Panel's `mb-4` is intentionally
 * dropped; the layout-grammar follow-on plan owns spacing).
 *
 * Body padding is density-driven (densityClasses().card) so the already-wired
 * DensityProvider finally takes effect for cards (audit S4). The four canonical
 * content states render INSIDE the card via the existing panel-state
 * primitives, so screens stop hand-writing "header + state branch"
 * (audit S3-C). #418 SSR-safety is preserved transitively: PanelSkeleton
 * already uses SsrSafeSkeleton.
 */
import React from "react";
import { useDensity, densityClasses } from "../components/density";
import {
  PanelSkeleton,
  PanelEmpty,
  PanelError,
  PanelLoading,
} from "../components/panel-state";

export type PanelCardState =
  | { kind: "ready" }
  | { kind: "loading"; lines?: number }
  | { kind: "inlineLoading"; label: string }
  | {
      kind: "empty";
      title: string;
      description?: string;
      action?: React.ReactNode;
    }
  | { kind: "error"; error: unknown };

export type PanelCardProps = {
  /** Header title. String only — also feeds PanelError's required title. */
  title?: string;
  /** Optional sub-line under the title. */
  subtitle?: string;
  /** Optional leading icon node in the header. */
  icon?: React.ReactNode;
  /** Optional right-aligned header actions (buttons, links). */
  actions?: React.ReactNode;
  /** Content-state machine. Default { kind: "ready" } renders children. */
  state?: PanelCardState;
  /** Set false to remove body padding (e.g. flush tables). Default true. */
  padded?: boolean;
  children?: React.ReactNode;
};

const CONTAINER = "rounded-xl border border-kumo-line bg-kumo-base";
const HEADER =
  "flex items-center gap-3 border-b border-kumo-line bg-kumo-elevated px-5 py-3";

function renderState(
  state: PanelCardState,
  title: string | undefined,
): React.ReactNode {
  switch (state.kind) {
    case "loading":
      return <PanelSkeleton lines={state.lines} />;
    case "inlineLoading":
      return <PanelLoading label={state.label} />;
    case "empty":
      return (
        <PanelEmpty
          title={state.title}
          description={state.description}
          action={state.action}
        />
      );
    case "error":
      return <PanelError title={title ?? "加载失败"} error={state.error} />;
    case "ready":
    default:
      return null;
  }
}

export function PanelCard({
  title,
  subtitle,
  icon,
  actions,
  state = { kind: "ready" },
  padded = true,
  children,
}: PanelCardProps): React.ReactElement {
  const density = useDensity();
  const isReady = state.kind === "ready";
  const bodyClass = isReady && padded ? densityClasses(density).card : undefined;
  const hasHeader =
    title !== undefined || icon !== undefined || actions !== undefined;

  return (
    <section className={CONTAINER} data-panel-card>
      {hasHeader ? (
        <div className={HEADER} data-panel-card-header>
          {icon ? (
            <span className="shrink-0 text-kumo-subtle" aria-hidden="true">
              {icon}
            </span>
          ) : null}
          <div className="min-w-0 flex-1">
            {title !== undefined ? (
              <p className="truncate text-sm font-semibold text-kumo-strong">
                {title}
              </p>
            ) : null}
            {subtitle !== undefined ? (
              <p className="truncate text-xs text-kumo-subtle">{subtitle}</p>
            ) : null}
          </div>
          {actions ? (
            <div className="shrink-0" data-panel-card-actions>
              {actions}
            </div>
          ) : null}
        </div>
      ) : null}
      <div className={bodyClass} data-panel-card-body>
        {isReady ? children : renderState(state, title)}
      </div>
    </section>
  );
}
