/**
 * Ratchet scanner (UI seam enforcement).
 *
 * Returns the sorted POSIX-relative paths of `.tsx` files under `root` that
 * hand-write card chrome — the audited signature is `rounded-xl` co-occurring
 * with `ring-1` or `border border-kumo-line`. The ratchet test (ratchet.test.ts)
 * asserts this set never grows beyond the committed baseline, so NEW files can
 * never introduce a 5th hand-rolled card while existing offenders are
 * grandfathered until the migration plan removes them.
 *
 * Excluded: the `ui/` seam itself, `*.test.*` / `*.stories.*`, and the
 * allow-listed legacy `dashboard/components/panel.tsx` (sanctioned card,
 * migrated in a follow-on plan).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SKIP_DIRS = new Set<string>(["ui", "node_modules"]);
const ALLOW_FILES = new Set<string>(["dashboard/components/panel.tsx"]);

function isCandidateFile(name: string): boolean {
  if (!name.endsWith(".tsx")) return false;
  if (name.endsWith(".test.tsx")) return false;
  if (name.endsWith(".stories.tsx")) return false;
  return true;
}

function hasRawCardChrome(text: string): boolean {
  if (!text.includes("rounded-xl")) return false;
  return text.includes("ring-1") || text.includes("border border-kumo-line");
}

function walk(dir: string, rootLen: number, acc: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      walk(full, rootLen, acc);
      continue;
    }
    if (!isCandidateFile(entry)) continue;
    const rel = full.slice(rootLen).replace(/\\/g, "/").replace(/^\/+/, "");
    if (ALLOW_FILES.has(rel)) continue;
    if (hasRawCardChrome(readFileSync(full, "utf8"))) acc.push(rel);
  }
}

export function scanRawCardChrome(root: string): string[] {
  const acc: string[] = [];
  walk(root, root.length, acc);
  return acc.sort();
}
