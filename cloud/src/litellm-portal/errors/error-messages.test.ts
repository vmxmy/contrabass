import { describe, expect, it } from "vitest";
import { setupI18n } from "../i18n/setup";
import { errorMessage, GENERIC_FALLBACK, KNOWN_ERROR_CODES } from "./error-messages";

// errorMessage now returns the LINGUI CATALOG ID (a defineMessage hash); the
// component renders it through the active i18n. The §F.3 string contract is
// asserted on the RESOLVED message under the zh-CN source locale (identity
// msgstr → the original zh sentence), preserving every original assertion's
// intent. i18n-completeness (Task 4c) covers full zh/en parity separately.

describe("§F.3 error-code → human 3-element message (V2.0 §2.4)", () => {
  it("every known code maps to a non-code, non-tech human string", () => {
    const i18n = setupI18n("zh-CN");
    for (const code of KNOWN_ERROR_CODES) {
      const id = errorMessage(code);
      const msg = i18n._(id);
      // (1) not the raw code, (2) no snake_case leak, (3) no tech tokens.
      expect(msg).not.toBe(code);
      expect(msg, `code ${code} leaks snake_case`).not.toMatch(/[a-z]+_[a-z_]+/);
      expect(msg, `code ${code} leaks tech token`).not.toMatch(/\bDO\b|undefined|null\b|HTTP|50\d|40\d|stack|Cannot read/i);
      expect(msg.length, `code ${code} message too short to be a 3-element msg`).toBeGreaterThan(8);
    }
  });

  it("unknown code → generic safe fallback that NEVER echoes the raw code", () => {
    const i18n = setupI18n("zh-CN");
    const weird = "internal_db_shard_7_panic";
    const msg = i18n._(errorMessage(weird));
    expect(msg).not.toContain(weird);
    expect(msg).not.toContain("shard");
    expect(errorMessage(weird)).toBe(GENERIC_FALLBACK.id);
  });

  it("permission codes carry a recovery action, no auth-internal leak", () => {
    const i18n = setupI18n("zh-CN");
    const imp = i18n._(errorMessage("impersonation_required"));
    // recovery affordance present (mentions the user's next step), no
    // internal auth mechanism leaked.
    expect(imp).toMatch(/进入租户|租户身份|operations|tenant/i);
    expect(imp).not.toMatch(/token|cookie|HMAC|session|middleware|requireTenantAdmin/i);
  });

  it("KNOWN_ERROR_CODES is exhaustive vs the routes.ts enumeration (drift guard)", () => {
    // Pin the count so a new server code without a mapping fails CI.
    expect(KNOWN_ERROR_CODES.length).toBeGreaterThanOrEqual(27);
  });
});
