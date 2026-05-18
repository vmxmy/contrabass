import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, copyFileSync, rmSync } from "node:fs";

const generated = "src/litellm-portal/app.generated.ts";

describe("F4 embedded bundle must match a fresh rebuild", () => {
  it("app.generated.ts is byte-identical to build:litellm-portal output", () => {
    const before = readFileSync(generated, "utf8");
    const backup = `${generated}.drifttest.bak`;
    copyFileSync(generated, backup);
    try {
      // vitest sets NODE_ENV=test; two cascading effects: (1) @lingui/cli 6.0.1 resolves a non-shipped .jiti.js worker → build crash; (2) @lingui/babel-plugin-lingui-macro tree-shakes differently under "test" vs undefined → different chunk hashes vs the standalone build. Delete NODE_ENV so the nested build runs under the same undefined default as `bun run build:litellm-portal` in a plain shell.
      const envWithoutNodeEnv = { ...process.env };
      delete envWithoutNodeEnv["NODE_ENV"];
      execFileSync("bun", ["run", "build:litellm-portal"], {
        cwd: ".",
        stdio: "pipe",
        env: envWithoutNodeEnv,
      });
      const after = readFileSync(generated, "utf8");
      expect(after).toBe(before);
    } finally {
      copyFileSync(backup, generated);
      rmSync(backup, { force: true });
    }
  }, 180000);
});
