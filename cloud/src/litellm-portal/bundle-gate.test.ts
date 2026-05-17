import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";

describe("§A.3 ECharts lazy HARD GATE (real client.tsx code-split build)", () => {
  it("build:litellm-portal-app succeeds and prints ECHARTS_LAZY_GATE: PASS", () => {
    // `bun run generate:litellm-portal-app` === `node scripts/build-litellm-portal-app.mjs`
    // (the real splitting:true build of client.tsx). It THROWS (non-zero) if
    // echarts is in the main chunk or absent from every split chunk. execSync
    // throws on non-zero, so a returned stdout containing the PASS marker IS
    // the gate. Run from cloud/ (the package root) via the bun alias.
    const out = execSync("bun run generate:litellm-portal-app", {
      cwd: __dirname.includes("/src/litellm-portal")
        ? __dirname.slice(0, __dirname.indexOf("/src/litellm-portal"))
        : process.cwd(),
      encoding: "utf8",
      timeout: 180_000,
    });
    expect(out).toMatch(/ECHARTS_LAZY_GATE: PASS/);
  }, 200_000);
});
