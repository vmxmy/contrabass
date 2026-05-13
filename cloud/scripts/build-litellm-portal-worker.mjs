#!/usr/bin/env node
/**
 * Pre-bundle the LiteLLM Portal Worker with Lingui macro transformation
 * applied to every portal source file. This produces dist/litellm-portal-worker/index.js
 * which can then be deployed with `wrangler deploy --no-bundle`.
 *
 * Wrangler's built-in esbuild pipeline does not run our `lingui-macro-transform`
 * plugin, so any `import { Trans } from "@lingui/react/macro"` reachable from the
 * SSR codepath throws at runtime ("The macro you imported from
 * @lingui/core/macro is being executed outside the context of compilation").
 *
 * Run via `npm run build:litellm-portal-worker` then deploy with
 * `wrangler deploy --no-bundle --config wrangler.litellm-portal.toml`.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { transformAsync } from "@babel/core";
import linguiMacroPlugin from "@lingui/babel-plugin-lingui-macro";
import { makeConfig } from "@lingui/conf";
import { build } from "esbuild";

const entryPoint = fileURLToPath(new URL("../src/litellm-portal/index.ts", import.meta.url));
const outdir = fileURLToPath(new URL("../dist/litellm-portal-worker/", import.meta.url));
const outfile = `${outdir}index.js`;
const litellmPortalRoot = fileURLToPath(new URL("../src/litellm-portal/", import.meta.url));
const repoRoot = fileURLToPath(new URL("../", import.meta.url));

const linguiConfig = makeConfig({
  locales: ["zh-CN", "en"],
  sourceLocale: "zh-CN",
  catalogs: [{ path: "src/litellm-portal/i18n/messages/{locale}", include: ["src/litellm-portal"] }],
});

const linguiMacroTransformPlugin = {
  name: "lingui-macro-transform",
  setup(buildContext) {
    buildContext.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async (args) => {
      if (!args.path.startsWith(litellmPortalRoot)) return undefined;
      const result = await transformAsync(readFileSync(args.path, "utf8"), {
        filename: args.path,
        babelrc: false,
        configFile: false,
        parserOpts: { plugins: ["typescript", "jsx"] },
        plugins: [[linguiMacroPlugin, { linguiConfig }]],
        sourceMaps: false,
      });
      return {
        contents: result?.code ?? "",
        loader: args.path.endsWith(".tsx") || args.path.endsWith(".jsx") ? "tsx" : "ts",
      };
    });
  },
};

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

const result = await build({
  entryPoints: [entryPoint],
  bundle: true,
  format: "esm",
  target: "es2022",
  platform: "browser",
  conditions: ["workerd", "worker", "browser"],
  outfile,
  minify: true,
  sourcemap: false,
  external: ["cloudflare:*", "node:*"],
  legalComments: "none",
  define: {
    "process.env.NODE_ENV": "\"production\"",
  },
  plugins: [linguiMacroTransformPlugin],
  metafile: true,
  logLevel: "warning",
});

const sizeBytes = result.outputFiles?.[0]?.contents.byteLength ?? null;
const fileLabel = relative(repoRoot, outfile);
console.log(`✓ wrote ${fileLabel}`);
