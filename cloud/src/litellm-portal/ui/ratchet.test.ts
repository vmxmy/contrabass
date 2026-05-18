import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { scanRawCardChrome } from "./ratchet-scan";

const PORTAL_ROOT = join(process.cwd(), "src/litellm-portal");
const BASELINE_PATH = join(PORTAL_ROOT, "ui/ratchet-baseline.json");

describe("UI card-chrome ratchet", () => {
  it("no NEW file hand-writes card chrome (offenders ⊆ committed baseline)", () => {
    const current = scanRawCardChrome(PORTAL_ROOT);

    if (process.env.UPDATE_RATCHET_BASELINE === "1") {
      writeFileSync(
        BASELINE_PATH,
        JSON.stringify(current, null, 2) + "\n",
        "utf8",
      );
      return;
    }

    expect(existsSync(BASELINE_PATH)).toBe(true);
    const baseline = new Set<string>(
      JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as string[],
    );
    const introduced = current.filter((f) => !baseline.has(f));
    expect(
      introduced,
      `New raw card chrome introduced — use <PanelCard> from src/litellm-portal/ui instead of hand-writing rounded-xl+ring-1/border. Offending files:\n${introduced.join(
        "\n",
      )}`,
    ).toEqual([]);
  });
});
