import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { basename, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { transformAsync } from "@babel/core";
import linguiMacroPlugin from "@lingui/babel-plugin-lingui-macro";
import { makeConfig } from "@lingui/conf";
import { build } from "esbuild";
import { visualizer } from "esbuild-visualizer";

const entryPoint = fileURLToPath(new URL("../src/litellm-portal/client.tsx", import.meta.url));
const entryPointRel = relative(process.cwd(), entryPoint);
const outputFile = new URL("../src/litellm-portal/app.generated.ts", import.meta.url);
const litellmPortalRoot = fileURLToPath(new URL("../src/litellm-portal/", import.meta.url));
const outdir = fileURLToPath(new URL("../dist/litellm-portal-app/", import.meta.url));
const reportDir = fileURLToPath(new URL("../dist/reports/", import.meta.url));
const reportFile = new URL("../dist/reports/litellm-portal-bundle.html", import.meta.url);
const metadataFile = new URL("../dist/reports/litellm-portal-metafile.json", import.meta.url);
const MAIN_GZIP_LIMIT = 100 * 1024;
const ADMIN_GZIP_LIMIT = 80 * 1024;

const linguiConfig = makeConfig({
  locales: ["zh-CN", "en"],
  sourceLocale: "zh-CN",
  catalogs: [{ path: "src/litellm-portal/i18n/locales/{locale}/messages", include: ["src/litellm-portal"] }],
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

function toExportName(path) {
  return basename(path).replace(/[^a-zA-Z0-9_$]/g, "_").replace(/^[0-9]/, "_$&");
}

function outputLabel(path) {
  return relative(fileURLToPath(new URL("../", import.meta.url)), path);
}

function gzipBytes(text) {
  return gzipSync(text, { level: 9 }).byteLength;
}

function formatBytes(bytes) {
  return `${(bytes / 1024).toFixed(1)}KB`;
}

function chunkKind(output) {
  if (output.entryPoint === entryPointRel) return "main";
  const inputPaths = Object.keys(output.inputs);
  if (inputPaths.some((input) => input.endsWith("src/litellm-portal/admin-components.tsx"))) return "admin";
  return "chunk";
}

function isAdminLazyInput(input) {
  return input.endsWith("src/litellm-portal/admin-components.tsx") ||
    input.endsWith("src/litellm-portal/routes/admin/navigation.tsx") ||
    /src\/litellm-portal\/routes\/admin\/.*\.lazy\.tsx$/.test(input);
}

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });
mkdirSync(reportDir, { recursive: true });

const result = await build({
  entryPoints: [entryPoint],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2020"],
  jsx: "automatic",
  minify: true,
  splitting: true,
  outdir,
  publicPath: "/portal-chunks",
  write: false,
  define: {
    "process.env.NODE_ENV": "\"production\"",
  },
  plugins: [linguiMacroTransformPlugin],
  legalComments: "none",
  metafile: true,
});

writeFileSync(metadataFile, JSON.stringify(result.metafile, null, 2));
writeFileSync(reportFile, await visualizer(result.metafile, { title: "LiteLLM Portal Bundle", template: "treemap" }));

const jsOutputs = result.outputFiles.filter((file) => file.path.endsWith(".js"));
const chunks = jsOutputs.map((file) => {
  const outputKey = relative(process.cwd(), file.path);
  const output = result.metafile.outputs[outputKey];
  if (!output) throw new Error(`missing metafile output for ${file.path}`);
  return {
    path: file.path,
    text: file.text,
    inputs: Object.keys(output.inputs).sort(),
    bytes: Buffer.byteLength(file.text),
    gzipBytes: gzipBytes(file.text),
    kind: chunkKind(output),
  };
});

const mainChunk = chunks.find((chunk) => chunk.kind === "main");
if (!mainChunk) throw new Error("missing main portal bundle");

const adminChunk = chunks.find((chunk) => chunk.kind === "admin");
if (!adminChunk) throw new Error("missing admin code-split chunk");

const forbiddenAdminMarkers = ["AdminUsersTable", "AdminAuditFeed", "AdminTeamsTable", "AdminGlobalUsage"];
const leakedMarkers = forbiddenAdminMarkers.filter((marker) => mainChunk.text.includes(marker));
if (leakedMarkers.length > 0) {
  throw new Error(`main user bundle contains admin markers: ${leakedMarkers.join(", ")}`);
}
const leakedAdminInputs = mainChunk.inputs.filter(isAdminLazyInput);
if (leakedAdminInputs.length > 0) {
  throw new Error(`main user bundle contains admin source inputs:\n${leakedAdminInputs.map((input) => `- ${input}`).join("\n")}`);
}

// ---------------------------------------------------------------------------
// Phase-3 §A.3 CI HARD GATE: echarts MUST NOT be in the main chunk, and MUST
// exist in some non-main split chunk (i.e. it is lazily code-split, not in the
// initial download). No KB threshold — observational gzip delta is logged
// below via the existing per-chunk report. Mirrors the admin-input throw idiom.
// ---------------------------------------------------------------------------
const ECHARTS_INPUT_RE = /node_modules\/echarts\//;
const echartsInMain = mainChunk.inputs.filter((input) => ECHARTS_INPUT_RE.test(input));
const echartsSplitChunk = chunks.find(
  (chunk) => chunk.kind !== "main" && chunk.inputs.some((input) => ECHARTS_INPUT_RE.test(input)),
);
if (echartsInMain.length > 0) {
  console.log("ECHARTS_LAZY_GATE: FAIL");
  throw new Error(
    `§A.3 gate: echarts is in the MAIN chunk (must be lazily code-split):\n${echartsInMain.map((i) => `- ${i}`).join("\n")}`,
  );
}
if (!echartsSplitChunk) {
  console.log("ECHARTS_LAZY_GATE: FAIL");
  throw new Error("§A.3 gate: echarts not found in any non-main split chunk (chart may be unreachable or wrongly bundled)");
}
console.log(
  `ECHARTS_LAZY_GATE: PASS (echarts isolated to split chunk ${basename(echartsSplitChunk.path)}, absent from main)`,
);

const budgetFailures = [
  mainChunk.gzipBytes > MAIN_GZIP_LIMIT
    ? `main user bundle gzip ${formatBytes(mainChunk.gzipBytes)} exceeds ${formatBytes(MAIN_GZIP_LIMIT)}`
    : null,
  adminChunk.gzipBytes > ADMIN_GZIP_LIMIT
    ? `admin chunk gzip ${formatBytes(adminChunk.gzipBytes)} exceeds ${formatBytes(ADMIN_GZIP_LIMIT)}`
    : null,
].filter((failure) => failure !== null);

const manifest = chunks.map((chunk) => ({
  exportName: toExportName(chunk.path),
  fileName: basename(chunk.path),
  kind: chunk.kind,
  bytes: chunk.bytes,
  gzipBytes: chunk.gzipBytes,
  inputs: chunk.inputs,
  text: chunk.text,
}));

const output = `// This file is generated by scripts/build-litellm-portal-app.mjs.
// Source: src/litellm-portal/client.tsx

${manifest.map((chunk) => `const ${chunk.exportName} = ${JSON.stringify(chunk.text)};`).join("\n\n")}

export const portalBundleChunks = ${JSON.stringify(manifest.map(({ exportName, text, ...chunk }) => ({ ...chunk, js: `__${exportName}__` })), null, 2).replace(/"__(.*?)__"/g, "$1")};

export const portalAppJs = ${toExportName(mainChunk.path)};
`;

writeFileSync(outputFile, output);

console.log("LiteLLM portal bundle report:");
for (const chunk of chunks.sort((a, b) => b.gzipBytes - a.gzipBytes)) {
  console.log(`- ${chunk.kind.padEnd(5)} ${outputLabel(chunk.path)} ${formatBytes(chunk.gzipBytes)} gzip (${formatBytes(chunk.bytes)} min)`);
}
console.log(`Analyzer report: ${outputLabel(fileURLToPath(reportFile))}`);

if (budgetFailures.length > 0) {
  throw new Error(`Bundle size budget failed:\n${budgetFailures.map((failure) => `- ${failure}`).join("\n")}`);
}
