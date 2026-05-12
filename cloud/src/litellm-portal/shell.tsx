import React from "react";
import type { JsonValue } from "./types";

const FOUC_SCRIPT = `(()=>{try{const s=localStorage.getItem('litellm-portal-mode');const p=window.matchMedia?.('(prefers-color-scheme: dark)').matches;const m=s==='dark'||s==='light'?s:p?'dark':'light';document.documentElement.dataset.mode=m;}catch{document.documentElement.dataset.mode='light';}})();`;

export type ShellProps = {
  title: string;
  nonce: string;
  initialData: JsonValue | null;
  children: React.ReactNode;
};

export function Shell({ title, nonce, initialData, children }: ShellProps) {
  const initialDataScript = initialData !== null
    ? `window.__INITIAL_DATA__=${JSON.stringify(initialData)};`
    : "";

  return (
    <html lang="zh-CN" data-theme="kumo">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
        <link rel="stylesheet" href="/kumo.css" />
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: FOUC_SCRIPT }} />
        {initialData !== null && (
          <script nonce={nonce} dangerouslySetInnerHTML={{ __html: initialDataScript }} />
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
