/**
 * PageShell — the ONE surface-chrome primitive for the LiteLLM Portal (UI seam).
 *
 * Closes audit S2 (4 divergent shells / supplementary evidence B). It is a
 * THIN PRESENTATIONAL wrapper: canvas wrapper + optional header band + nav slot
 * + unified content region. It carries NO SSR/#418/impersonation/identity
 * logic — each shell keeps that and composes PageShell inside its own gating
 * (mirrors PanelCard not owning panel-state).
 *
 * Documented design decisions (overridable in review):
 *  - The `/` landing (__root.tsx, centered, sidebar-less) is intentionally a
 *    different surface and is NOT migrated to PageShell.
 *  - The tenant pure-Owner `max-w-5xl` variant is intentional and stays.
 *  - The 3 sidebar-bearing shells (tenant normal / ops / manage) have
 *    ACCIDENTAL content-token drift; PageShell is their single answer. `header`
 *    is optional so `manage` keeps its intentional header-less layout.
 *
 * Canonical tokens are taken verbatim from the current ops shell (the cleanest
 * existing header+sidebar instance) so migration is a behaviour-preserving swap.
 */
import React from "react";

export type PageShellProps = {
  /** Optional brand/status band. Omit for an intentionally header-less surface. */
  header?: React.ReactNode;
  /** The fully-formed navigation element (the shell supplies its own SideNav). */
  nav: React.ReactNode;
  children: React.ReactNode;
};

const ROOT = "flex min-h-screen flex-col bg-kumo-canvas text-kumo-default";
const HEADER =
  "flex items-center gap-3 border-b border-kumo-line bg-kumo-elevated px-6 py-4";
const MAIN =
  "min-w-0 flex-1 px-6 py-8 opacity-100 motion-safe:transition-opacity motion-safe:duration-150";

export function PageShell({
  header,
  nav,
  children,
}: PageShellProps): React.ReactElement {
  return (
    <div className={ROOT} data-page-shell>
      {header !== undefined ? (
        <div className={HEADER} data-page-shell-header>
          {header}
        </div>
      ) : null}
      <div className="flex flex-1">
        {nav}
        <main className={MAIN} data-page-shell-main>
          {children}
        </main>
      </div>
    </div>
  );
}
