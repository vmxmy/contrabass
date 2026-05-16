import React from "react";
import type { JsonValue } from "./types";
import type { UserPreferences } from "./schemas";

function foucScript(theme: UserPreferences["theme"]): string {
  const serializedTheme = JSON.stringify(theme);
  return `(()=>{try{const s=${serializedTheme};const p=window.matchMedia?.('(prefers-color-scheme: dark)').matches;const m=s==='dark'||s==='light'?s:p?'dark':'light';document.documentElement.dataset.mode=m;}catch{document.documentElement.dataset.mode='light';}})();`;
}

const LINE_SEP = String.fromCharCode(0x2028);
const PARA_SEP = String.fromCharCode(0x2029);

function serializeForScript(value: JsonValue): string {
  return JSON.stringify(value)
    .replaceAll("&", "\\u0026")
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll(LINE_SEP, "\\u2028")
    .replaceAll(PARA_SEP, "\\u2029");
}

export type ShellProps = {
  title: string;
  nonce: string;
  initialData: JsonValue | null;
  children: React.ReactNode;
  locale?: string;
  initialTheme?: UserPreferences["theme"];
};

export function Shell({ title, nonce, initialData, children, locale = "zh-CN", initialTheme = "auto" }: ShellProps) {
  // foucScript sets documentElement.dataset.mode before hydration, so the live
  // <html> has a data-mode attribute the SSR markup lacks. Without
  // suppressHydrationWarning, React 19 treats it as a hydration mismatch and
  // regenerates the whole tree client-side (React #418). The suppression scopes
  // the tolerance to <html>'s own attributes; children still hydrate normally.
  return (
    <html lang={locale} data-theme="kumo" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
        <link rel="stylesheet" href="/kumo.css" />
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: foucScript(initialTheme) }} />
        {initialData !== null && (
          <script
            type="application/json"
            id="initial-data"
            nonce={nonce}
            dangerouslySetInnerHTML={{ __html: serializeForScript(initialData) }}
          />
        )}
      </head>
      {/* The /portal.js entry is injected by React via renderToReadableStream's
          `bootstrapModules` (see server-impl.tsx), NOT rendered as a child here.
          React appends bootstrap scripts outside the hydrated tree, so they
          can't cause a <body>-level whitespace/script hydration mismatch
          (React #418). Do not re-add a manual <script src="/portal.js">. */}
      <body className="min-h-screen bg-kumo-canvas text-kumo-default">
        <div id="root">
          {children}
        </div>
      </body>
    </html>
  );
}
