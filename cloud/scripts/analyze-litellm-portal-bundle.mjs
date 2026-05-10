import { build, analyzeMetafile } from "esbuild";
import { fileURLToPath } from "node:url";

const entryPoint = fileURLToPath(new URL("../src/litellm-portal/app.tsx", import.meta.url));

const result = await build({
  entryPoints: [entryPoint],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2020"],
  jsx: "automatic",
  minify: true,
  write: false,
  define: {
    "process.env.NODE_ENV": "\"production\"",
  },
  legalComments: "none",
  metafile: true,
});

const js = result.outputFiles[0]?.text ?? "";
console.log(`litellm-portal app bundle: ${Buffer.byteLength(js).toLocaleString("en-US")} bytes minified`);
console.log(await analyzeMetafile(result.metafile, { verbose: false }));
