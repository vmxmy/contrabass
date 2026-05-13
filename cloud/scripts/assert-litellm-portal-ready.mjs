import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const cloudDir = resolve(scriptDir, "..");
const wranglerConfig = resolve(cloudDir, "wrangler.litellm-portal.toml");
const placeholder = "__TBD_OWNER_FILLS_BEFORE_DEPLOY__";

const config = await readFile(wranglerConfig, "utf8");

if (config.includes(placeholder)) {
  console.error([
    "LiteLLM portal deploy blocked: USER_PREFS_KV still uses placeholder namespace IDs.",
    "Owner pre-deploy actions:",
    "- Run `wrangler kv namespace create user-prefs` and `wrangler kv namespace create user-prefs --preview`.",
    "- Replace `__TBD_OWNER_FILLS_BEFORE_DEPLOY__` in `wrangler.litellm-portal.toml`.",
  ].join("\n"));
  process.exit(1);
}
