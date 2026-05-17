import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { OPS_STEEL_BRAND, OPS_STEEL_BRAND_HOVER, OPS_STEEL_ACCENT } from "./ops-theme";

describe("§F.6 ops-theme sanctioned hex exception (V2.0 §1.3)", () => {
  it("exposes named steel consts and OPS_STEEL_ACCENT composes from them (value unchanged)", () => {
    expect(OPS_STEEL_BRAND).toBe("#475569");
    expect(OPS_STEEL_BRAND_HOVER).toBe("#334155");
    expect(OPS_STEEL_ACCENT).toEqual({
      "--kumo-brand": OPS_STEEL_BRAND,
      "--kumo-brand-hover": OPS_STEEL_BRAND_HOVER,
    });
  });

  it("ops-theme.ts carries the sanctioned-exception doc comment", () => {
    const src = readFileSync("src/litellm-portal/ops-console/ops-theme.ts", "utf8");
    expect(src).toMatch(/sanctioned|唯一豁免|approved.*exception/i);
  });

  it("NO OTHER raw #rrggbb hex in portal source (only the two sanctioned ops-theme consts + branding.ts WCAG surface constants)", () => {
    // Allowlist: ops-theme.ts (the sanctioned exception) and branding.ts
    // (canvas/elevated/tint surface luminance inputs — documented WCAG math,
    // not styling). Test/story/generated files excluded.
    //
    // PRE-EXISTING ALLOWLIST (not styling-related, cannot use Kumo tokens):
    // - auth/login-routes.ts: standalone login-page HTML template strings
    //   (outside Kumo-styled React portal surface; no token pipeline).
    // - notifications.ts: email-notification HTML template strings
    //   (email clients cannot load Kumo CSS; inline hex is required).
    // - dashboard/charts/kumo-chart-theme.tsx: ECharts theme color map
    //   (ECharts API requires literal hex values; maps to Kumo palette by
    //   convention but must be hex for the chart renderer).
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    const out = execSync(
      `grep -rEn "#[0-9a-fA-F]{6}\\b" src/litellm-portal --include="*.ts" --include="*.tsx" ` +
        `--exclude="*.test.ts" --exclude="*.test.tsx" --exclude="*.stories.tsx" ` +
        `--exclude="app.generated.ts" --exclude="kumo-css.generated.ts" || true`,
      { cwd: process.cwd(), encoding: "utf8" },
    );
    const offenders = out
      .split("\n")
      .filter(Boolean)
      .filter(
        (l) =>
          !l.includes("ops-console/ops-theme.ts") &&
          !l.includes("tenant-portal/branding.ts") &&
          !l.includes("auth/login-routes.ts") &&
          !l.includes("notifications.ts") &&
          !l.includes("dashboard/charts/kumo-chart-theme.tsx"),
      );
    expect(offenders, `Raw hex outside the sanctioned allowlist:\n${offenders.join("\n")}`).toEqual([]);
  });
});
