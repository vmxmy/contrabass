import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("§C only --kumo-brand* is ever emitted", () => {
  it("applyBrandVars source emits exactly --kumo-brand and --kumo-brand-hover", () => {
    const src = readFileSync("src/litellm-portal/tenant-portal/branding.ts", "utf8");
    const emitted = [...src.matchAll(/"(--kumo-[a-z-]+)":/g)].map((m) => m[1]);
    expect(new Set(emitted)).toEqual(new Set(["--kumo-brand", "--kumo-brand-hover"]));
  });
});
