import React from "react";
import { Banner } from "@cloudflare/kumo/components/banner";
import { Button } from "@cloudflare/kumo/components/button";
import { Trans } from "@lingui/react/macro";

/**
 * §F.4 (V2.0 §2.4): per-critical-block render/runtime isolation. LAYERED ON
 * TOP of the MAJOR-1 client.tsx `try{await warmUsageCharts()}catch{}` (that
 * stays as the chunk-FETCH white-screen floor). This catches the orthogonal
 * case: the block's code FETCHED but THREW at render/runtime → degrade THIS
 * block to an inline panel, siblings/page intact (no region crash / blank).
 * One boundary per critical block (chart / audit / dashboard core) — never a
 * single god-boundary (V2.0 §4#8). Transparent on the happy path (incl. the
 * normal Suspense loading path → does NOT alter SSR/hydrate first render, so
 * the §E-1 #418 loading-parity is unaffected: a boundary with no error is a
 * pass-through).
 */
type Props = { blockLabel: string; children: React.ReactNode };
type State = { errored: boolean };

export class BlockErrorBoundary extends React.Component<Props, State> {
  state: State = { errored: false };

  static getDerivedStateFromError(): State {
    return { errored: true };
  }

  componentDidCatch(error: unknown): void {
    // Log for diagnostics; NEVER surface the raw error to the user (§F.3).
    console.error("[BlockErrorBoundary]", this.props.blockLabel, error);
  }

  private reset = (): void => this.setState({ errored: false });

  render(): React.ReactNode {
    if (!this.state.errored) return this.props.children;
    return (
      <div data-block-error-boundary>
        <Banner
          variant="error"
          title={<Trans>该模块加载出错</Trans>}
          description={
            <Trans>
              {this.props.blockLabel}暂时无法显示，页面其余部分仍可使用。请点击重试，或稍后刷新。
            </Trans>
          }
          action={
            <Button variant="secondary" size="sm" onClick={this.reset}>
              <Trans>重试</Trans>
            </Button>
          }
        />
      </div>
    );
  }
}
