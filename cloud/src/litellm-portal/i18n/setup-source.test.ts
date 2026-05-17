// repo test path idiom: plain cwd-relative string readFileSync (cwd = cloud/
// when vitest runs), per src/litellm-portal/a11y/type-scale.test.ts. The
// fileURLToPath(new URL(...)) idiom adds non-baseline TS2769 under
// cloud/tsconfig.json (@cloudflare/workers-types) for an included `.ts` test.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const setup = readFileSync("src/litellm-portal/i18n/setup.ts", "utf8");

describe("F1 setup loads compiled catalogs", () => {
  it("imports the compiled .mjs catalogs, not the legacy source-text maps", () => {
    expect(setup).not.toContain('./messages/zh-CN');
    expect(setup).not.toContain('./messages/en');
    expect(setup).toContain('./locales/zh-CN/messages');
    expect(setup).toContain('./locales/en/messages');
  });
});
