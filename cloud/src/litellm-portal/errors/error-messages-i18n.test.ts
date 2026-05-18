// Repo test-path idiom: this suite does NOT readFileSync source — it
// exercises the live runtime (errorMessage + the compiled catalog via
// setupI18n), the same idiom as errors/error-messages.test.ts which already
// imports setupI18n. RED before the defineMessage refactor (errorMessage
// returns a zh source string, not a catalog id, so i18n._ echoes the raw
// zh and the en assertion fails); GREEN after (returns descriptor.id; the
// compiled en catalog resolves it).
import { describe, expect, it } from "vitest";
import { setupI18n } from "../i18n/setup";
import { errorMessage, KNOWN_ERROR_CODES } from "./error-messages";

describe("§F.3 errorMessage returns a catalog id that resolves per-locale", () => {
  it("a known code resolves to its English string under the en locale", () => {
    const i18n = setupI18n("en");
    const id = errorMessage("admin_required");
    // errorMessage now returns the Lingui catalog id (a hash), present in
    // the compiled en catalog → i18n._ yields the authored English.
    expect(i18n.messages[id], `id ${id} must be a known en catalog key`).toBeDefined();
    const en = i18n._(id);
    expect(en).toBe(
      "Platform administrator access is required for this action. Sign in with an administrator account and try again.",
    );
    // never the zh source, never the raw code
    expect(en).not.toContain("管理员权限");
    expect(en).not.toBe("admin_required");
  });

  it("every known code resolves to a non-empty, non-code en string", () => {
    const i18n = setupI18n("en");
    for (const code of KNOWN_ERROR_CODES) {
      const id = errorMessage(code);
      expect(i18n.messages[id], `code ${code} → id ${id} not in en catalog`).toBeDefined();
      const en = i18n._(id);
      expect(en.length, `code ${code} en too short`).toBeGreaterThan(8);
      expect(en, `code ${code} leaks snake_case`).not.toMatch(/[a-z]+_[a-z_]+/);
    }
  });

  it("§F.3 leak guard preserved: a raw non-catalog technical string is NOT a catalog id", () => {
    // PanelError narrows on `i18n.messages[raw] !== undefined`. A fetch-layer
    // Error message is not a Lingui hash id → undefined → generic fallback.
    const i18n = setupI18n("en");
    const raw = "TypeError: Failed to fetch";
    expect(i18n.messages[raw]).toBeUndefined();
    // and an unknown code still routes to the generic fallback id, which IS
    // a catalog id (so it localizes), never the raw code.
    const fallbackId = errorMessage("internal_db_shard_7_panic");
    expect(fallbackId).not.toContain("shard");
    expect(i18n.messages[fallbackId], "generic fallback must be a catalog id").toBeDefined();
  });
});
