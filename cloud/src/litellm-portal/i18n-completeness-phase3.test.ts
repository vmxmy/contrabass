import { describe, expect, it } from "vitest";
import { PHASE3_KEYS } from "./i18n/__fixtures__/phase3-keys";
import {
  EN_PO,
  ZH_PO,
  EN_UNTRANSLATED_ALLOWLIST,
  normalizeFixtureKey,
} from "./i18n/__fixtures__/po-coverage";

// Same candidate-set membership as the tenant-portal gate (Step 2). The
// phase-3 chart-aria fixture `Token …{window}…{points}…{grain}…` matches
// candidate (1) against parsePo's brace-de-escaped alias of the
// `'{'window'}'`-escaped msgid; it is never positionalized.
const UNIQUE = [...new Set<string>(PHASE3_KEYS)].map((k) => ({
  fixture: k,
  candidates: [...normalizeFixtureKey(k)],
}));

describe("phase-3 i18n completeness", () => {
  it("every phase-3 source string is an extracted .po msgid (both locales)", () => {
    expect(
      UNIQUE.filter(({ candidates }) => !candidates.some((c) => EN_PO.msgids.has(c))).map(
        (e) => e.fixture,
      ),
      "missing en",
    ).toHaveLength(0);
    expect(
      UNIQUE.filter(({ candidates }) => !candidates.some((c) => ZH_PO.msgids.has(c))).map(
        (e) => e.fixture,
      ),
      "missing zh-CN",
    ).toHaveLength(0);
  });
  it("every phase-3 string is translated in both locales (modulo the en allowlist)", () => {
    expect(
      UNIQUE.filter(({ candidates }) => !candidates.some((c) => ZH_PO.translated.has(c))).map(
        (e) => e.fixture,
      ),
      "empty zh-CN",
    ).toHaveLength(0);
    expect(
      UNIQUE.filter(
        ({ candidates }) =>
          !candidates.some((c) => EN_PO.translated.has(c)) &&
          !candidates.some((c) => EN_UNTRANSLATED_ALLOWLIST.has(c)),
      ).map((e) => e.fixture),
      "empty en, not allowlisted",
    ).toHaveLength(0);
  });
  it("en and zh-CN .po have an identical msgid set", () => {
    expect([...EN_PO.msgids].filter((k) => !ZH_PO.msgids.has(k)), "en-only").toHaveLength(0);
    expect([...ZH_PO.msgids].filter((k) => !EN_PO.msgids.has(k)), "zh-only").toHaveLength(0);
  });
});
