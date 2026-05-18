import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = "src/litellm-portal";

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === "node_modules" ? [] : walk(p);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
  });
}

describe("F5/D7 /login must use a native anchor, never a TanStack/Kumo Link", () => {
  it('no Link to="/login" or to="/magic-callback" anywhere in portal source', () => {
    const offenders = walk(root).filter((file) => {
      const s = readFileSync(file, "utf8");
      return /<Link\b[^>]*\bto=["'](\/login|\/magic-callback)["']/.test(s);
    });
    expect(offenders).toEqual([]);
  });
});
