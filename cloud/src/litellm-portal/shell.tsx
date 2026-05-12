import React from "react";
import type { JsonValue } from "./types";

const FOUC_SCRIPT = `(()=>{try{const s=localStorage.getItem('litellm-portal-mode');const p=window.matchMedia?.('(prefers-color-scheme: dark)').matches;const m=s==='dark'||s==='light'?s:p?'dark':'light';document.documentElement.dataset.mode=m;}catch{document.documentElement.dataset.mode='light';}})();`;

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
};

export function Shell({ title, nonce, initialData, children, locale = "zh-CN" }: ShellProps) {
  return (
    <html lang={locale} data-theme="kumo">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
        <link rel="stylesheet" href="/kumo.css" />
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: FOUC_SCRIPT }} />
        {initialData !== null && (
          <script
            type="application/json"
            id="initial-data"
            dangerouslySetInnerHTML={{ __html: serializeForScript(initialData) }}
          />
        )}
      </head>
      <body className="min-h-screen bg-kumo-canvas text-kumo-default">
        <div id="root">
          {children}
        </div>
        <script type="module" src="/portal.js" />
      </body>
    </html>
  );
}
