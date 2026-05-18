import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanRawCardChrome } from "./ratchet-scan";

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ratchet-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function put(rel: string, content: string): void {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

describe("scanRawCardChrome", () => {
  it("flags a screen file with rounded-xl + ring-1", () => {
    put(
      "ops-console/screens/audit.tsx",
      `export const C = () => <article className="overflow-hidden rounded-xl bg-kumo-base ring-1 ring-kumo-line">x</article>;`,
    );
    expect(scanRawCardChrome(root)).toEqual(["ops-console/screens/audit.tsx"]);
  });

  it("flags rounded-xl + 'border border-kumo-line'", () => {
    put(
      "dashboard/views/x.tsx",
      `<div className="mb-4 rounded-xl border border-kumo-line bg-kumo-base" />`,
    );
    expect(scanRawCardChrome(root)).toEqual(["dashboard/views/x.tsx"]);
  });

  it("does NOT flag a file without both tokens", () => {
    put("screens/clean.tsx", `<div className="rounded-xl p-4">ok</div>`);
    expect(scanRawCardChrome(root)).toEqual([]);
  });

  it("skips the ui/ seam directory", () => {
    put(
      "ui/panel-card.tsx",
      `<section className="rounded-xl border border-kumo-line bg-kumo-base" />`,
    );
    expect(scanRawCardChrome(root)).toEqual([]);
  });

  it("skips *.test.tsx and *.stories.tsx", () => {
    put("a/b.test.tsx", `className="rounded-xl ring-1"`);
    put("a/c.stories.tsx", `className="rounded-xl ring-1"`);
    expect(scanRawCardChrome(root)).toEqual([]);
  });

  it("skips the allow-listed legacy dashboard/components/panel.tsx", () => {
    put(
      "dashboard/components/panel.tsx",
      `<div className="mb-4 rounded-xl border border-kumo-line bg-kumo-base" />`,
    );
    expect(scanRawCardChrome(root)).toEqual([]);
  });

  it("returns sorted, POSIX-separated relative paths", () => {
    put("z/late.tsx", `className="rounded-xl ring-1"`);
    put("a/early.tsx", `className="rounded-xl ring-1"`);
    expect(scanRawCardChrome(root)).toEqual([
      "a/early.tsx",
      "z/late.tsx",
    ]);
  });
});
