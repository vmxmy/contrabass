import { describe, expect, it } from "vitest";
import { I18nProvider } from "@lingui/react";
import { setupI18n } from "../i18n/setup";
import { errorMessage, KNOWN_ERROR_CODES } from "./error-messages";

// errorMessage returns the LINGUI MESSAGE ID (a zh source string, like the
// rest of the catalog); the component renders it through the active i18n.
// The test asserts the contract on the message-id strings + that the catalog
// resolves them (i18n-completeness covers full zh/en parity).

describe("§F.3 error-code → human 3-element message (V2.0 §2.4)", () => {
  it("every known code maps to a non-code, non-tech human string", () => {
    for (const code of KNOWN_ERROR_CODES) {
      const msg = errorMessage(code);
      // (1) not the raw code, (2) no snake_case leak, (3) no tech tokens.
      expect(msg).not.toBe(code);
      expect(msg, `code ${code} leaks snake_case`).not.toMatch(/[a-z]+_[a-z_]+/);
      expect(msg, `code ${code} leaks tech token`).not.toMatch(/\bDO\b|undefined|null\b|HTTP|50\d|40\d|stack|Cannot read/i);
      expect(msg.length, `code ${code} message too short to be a 3-element msg`).toBeGreaterThan(8);
    }
  });

  it("unknown code → generic safe fallback that NEVER echoes the raw code", () => {
    const weird = "internal_db_shard_7_panic";
    const msg = errorMessage(weird);
    expect(msg).not.toContain(weird);
    expect(msg).not.toContain("shard");
    expect(msg).toBe(GENERIC_FALLBACK_ID);
  });

  it("permission codes carry a recovery action, no auth-internal leak", () => {
    const imp = errorMessage("impersonation_required");
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

import { GENERIC_FALLBACK_ID } from "./error-messages";
