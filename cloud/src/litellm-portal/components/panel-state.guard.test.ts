import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SCREEN_DIRS = [
  "src/litellm-portal/tenant-portal/screens",
  "src/litellm-portal/ops-console/screens",
];

describe("§A.2 state-primitive convergence guard", () => {
  it("no screen directly imports SkeletonLine/Empty/Banner for state branches", () => {
    const offenders: string[] = [];
    for (const dir of SCREEN_DIRS) {
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".tsx") || f.endsWith(".test.tsx")) continue;
        const src = readFileSync(join(dir, f), "utf8");
        if (
          src.includes('from "@cloudflare/kumo/components/empty"') ||
          /import\s*\{[^}]*\bSkeletonLine\b[^}]*\}\s*from\s*"@cloudflare\/kumo\/components\/loader"/.test(src) ||
          src.includes('variant="error"')
        ) {
          offenders.push(join(dir, f));
        }
      }
    }
    expect(offenders, `Screens still using raw state primitives: ${JSON.stringify(offenders)}`).toHaveLength(0);
  });
});
