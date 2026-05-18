import { describe, expect, it } from "vitest";
import { PHASE1_TENANT_KEYS } from "../i18n/__fixtures__/phase1-keys";
import {
  EN_PO,
  ZH_PO,
  EN_UNTRANSLATED_ALLOWLIST,
  normalizeFixtureKey,
} from "../i18n/__fixtures__/po-coverage";

// Each fixture string maps to a SET of candidate .po msgid forms (named-
// collapsed AND positional); a fixture is satisfied if ANY candidate is
// present. Lingui keeps `t`/named-`<Trans>` msgids NAMED but emits
// member-expr `<Trans>` POSITIONAL, and the fixture string alone cannot
// say which — so we test the disjunction over both shapes.
const UNIQUE_KEYS = [...new Set(PHASE1_TENANT_KEYS)].map((k) => ({
  fixture: k,
  candidates: [...normalizeFixtureKey(k)],
}));

describe("tenant-portal i18n completeness", () => {
  it("every tenant-portal source string is an extracted .po msgid (both locales)", () => {
    const missingEn = UNIQUE_KEYS.filter(
      ({ candidates }) => !candidates.some((c) => EN_PO.msgids.has(c)),
    ).map((e) => e.fixture);
    const missingZh = UNIQUE_KEYS.filter(
      ({ candidates }) => !candidates.some((c) => ZH_PO.msgids.has(c)),
    ).map((e) => e.fixture);
    expect(missingEn, `Not extracted into en .po: ${JSON.stringify(missingEn)}`).toHaveLength(0);
    expect(missingZh, `Not extracted into zh-CN .po: ${JSON.stringify(missingZh)}`).toHaveLength(0);
  });

  it("every tenant-portal string is translated in both locales (modulo the documented en allowlist)", () => {
    const untranslatedZh = UNIQUE_KEYS.filter(
      ({ candidates }) => !candidates.some((c) => ZH_PO.translated.has(c)),
    ).map((e) => e.fixture);
    const untranslatedEn = UNIQUE_KEYS.filter(
      ({ candidates }) =>
        !candidates.some((c) => EN_PO.translated.has(c)) &&
        !candidates.some((c) => EN_UNTRANSLATED_ALLOWLIST.has(c)),
    ).map((e) => e.fixture);
    expect(untranslatedZh, `Empty zh-CN msgstr: ${JSON.stringify(untranslatedZh)}`).toHaveLength(0);
    expect(
      untranslatedEn,
      `Empty en msgstr and NOT on the documented allowlist: ${JSON.stringify(untranslatedEn)}`,
    ).toHaveLength(0);
  });

  it("en and zh-CN .po have an identical msgid set", () => {
    const enOnly = [...EN_PO.msgids].filter((k) => !ZH_PO.msgids.has(k));
    const zhOnly = [...ZH_PO.msgids].filter((k) => !EN_PO.msgids.has(k));
    expect(enOnly, `msgid in en but not zh-CN: ${JSON.stringify(enOnly)}`).toHaveLength(0);
    expect(zhOnly, `msgid in zh-CN but not en: ${JSON.stringify(zhOnly)}`).toHaveLength(0);
  });
});
