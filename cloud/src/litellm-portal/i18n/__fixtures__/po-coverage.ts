// Post-F1 source-of-truth for the i18n-completeness gates. The compiled
// catalogs are hash-id-keyed; the .po msgid IS the source string. We parse
// the two .po files once and expose: the msgid set per locale (for the
// "source string is covered" check, modulo Lingui normalization) and the
// set of msgids whose msgstr is non-empty (for the "actually translated"
// check). Repo test-path idiom: plain cwd-relative readFileSync (cwd=cloud/
// under vitest), per src/litellm-portal/a11y/type-scale.test.ts:10 — NOT
// fileURLToPath(new URL(...)), which adds non-baseline TS2769 under
// @cloudflare/workers-types for an included .ts.
import { readFileSync } from "node:fs";

export interface PoCatalog {
  /** Every msgid present, plus a brace-de-escaped alias for each. */
  readonly msgids: ReadonlySet<string>;
  /** msgids whose msgstr is a non-empty string. */
  readonly translated: ReadonlySet<string>;
}

function deEscapeBraces(s: string): string {
  // Lingui escapes literal ICU braces in .po as '{' / '}'.
  return s.replace(/'\{'/g, "{").replace(/'\}'/g, "}");
}

/**
 * Map a fixture's NAMED ICU placeholders to positional `{0},{1},…` in
 * first-appearance order. Lingui's placeholder form is construct-dependent
 * and the choice is NOT recoverable from the fixture string alone (every
 * fixture placeholder is the structurally-identical `{simpleIdent}` form):
 *  - `t` macro / `<Trans>` whose interpolation is a SIMPLE identifier
 *    (`{period}`, `{email}`) → Lingui keeps the msgid NAMED. Live `.po`
 *    evidence (laneA HEAD d68ce3e1): en/messages.po
 *    `msgid "下载 {period}"`, `msgid "请输入「{email}」以确认撤销"`,
 *    `msgid "将撤销「{email}」的邀请。此操作不可撤销。"`.
 *  - `<Trans>` whose interpolation is a MEMBER expression
 *    (`{imp.realActor}`, `{this.props.blockLabel}`) or a composite →
 *    Lingui emits POSITIONAL args. Live `.po` evidence:
 *    `msgid "{0} 正在代表团队 {1} 操作。所有操作均被审计。"` with
 *    `#. placeholder {0}: imp.realActor` / `#. placeholder {1}:
 *    imp.effectiveTeamId`; the OPS fixture for this string is the NAMED
 *    `"{realActor} 正在代表团队 {effectiveTeamId} …"`.
 * Because a single deterministic rewrite cannot satisfy both (the named
 * t-macro strings must NOT be positionalized, the impersonation `<Trans>`
 * MUST be), `normalizeFixtureKey` instead returns the FULL candidate set
 * (named-collapsed AND positional) and the gate asserts ANY candidate is
 * covered. This function produces the positional candidate only. A token
 * that is already all-digits keeps its value (pure-positional fixtures are
 * unaffected); ordering is stable by first appearance.
 */
function namedToPositional(key: string): string {
  const order: string[] = [];
  return key.replace(/\{([^}]+)\}/g, (_m, name: string) => {
    if (/^\d+$/.test(name)) return `{${name}}`; // already positional
    let idx = order.indexOf(name);
    if (idx === -1) {
      idx = order.length;
      order.push(name);
    }
    return `{${idx}}`;
  });
}

/**
 * Fixture → set of candidate `.po` msgid forms. Membership is checked as
 * "ANY candidate ∈ msgids / ∈ translated", because Lingui's named-vs-
 * positional choice depends on the emitting construct (`t`/named-`<Trans>`
 * → NAMED; member-expr `<Trans>` → POSITIONAL) and that information is
 * absent from the fixture string. Candidates, in order:
 *  1. The `${x}`→`{x}` dollar-collapsed form (covers `t`-macro / named
 *     `<Trans>` whose msgid Lingui keeps NAMED — `下载 {period}`,
 *     `请输入「{email}」以确认撤销`, `将撤销「{email}」的邀请。…`; also the
 *     identity for no-placeholder §F.3 `msg\`\`` descriptors).
 *  2. The positional form of (1) (covers member-expr `<Trans>` whose msgid
 *     Lingui emits POSITIONAL — `{0} 正在代表团队 {1} …`).
 * The literal-ICU-brace fixture (`phase3-keys.ts:42`, `{window}/{points}/
 * {grain}`) is matched via candidate (1) against the brace-de-escaped
 * alias `parsePo` already indexes for the `'{'window'}'`-escaped msgid —
 * it is NOT positionalized (candidate (2) is simply unused there). The
 * set is deliberately small and fixed; this is a disjunction over the two
 * possible emit shapes, NOT a relaxation — the gate still fails when EVERY
 * candidate is absent (truly unextracted) or untranslated.
 */
export function normalizeFixtureKey(key: string): ReadonlySet<string> {
  const dollarCollapsed = key.replace(/\$\{([^}]+)\}/g, "{$1}");
  return new Set<string>([dollarCollapsed, namedToPositional(dollarCollapsed)]);
}

function parsePo(path: string): PoCatalog {
  const raw = readFileSync(path, "utf8");
  const msgids = new Set<string>();
  const translated = new Set<string>();
  // Entries are blank-line separated; we only need single-line msgid/msgstr,
  // which is the form @lingui/cli emits for this catalog (verified: no
  // multi-line continuation in either messages.po).
  const blocks = raw.split(/\n\n+/);
  for (const block of blocks) {
    const idMatch = block.match(/^msgid "((?:[^"\\]|\\.)*)"/m);
    const strMatch = block.match(/^msgstr "((?:[^"\\]|\\.)*)"/m);
    if (!idMatch) continue;
    const id = idMatch[1];
    if (id === "") continue; // header
    msgids.add(id);
    msgids.add(deEscapeBraces(id));
    if (strMatch && strMatch[1] !== "") {
      translated.add(id);
      translated.add(deEscapeBraces(id));
    }
  }
  return { msgids, translated };
}

export const EN_PO = parsePo("src/litellm-portal/i18n/locales/en/messages.po");
export const ZH_PO = parsePo("src/litellm-portal/i18n/locales/zh-CN/messages.po");

/**
 * Fixture source strings that are intentionally absent from the en
 * translation (empty msgstr) post-extract: net-new / non-macro / zh-only
 * strings the seed had no English for. Documented & bounded — adding to
 * this list is a reviewed decision, not a silent escape hatch. zh-CN is the
 * source locale and has ZERO empty msgstr, so there is no zh allowlist.
 *
 * The implementer MUST populate this from the actual extract: run
 *   grep -B1 '^msgstr ""$' src/litellm-portal/i18n/locales/en/messages.po \
 *     | grep '^msgid ' | sed 's/^msgid "//; s/"$//'
 * then keep only the empty msgids for which SOME candidate of a fixture
 * string (`normalizeFixtureKey(fixture)` over PHASE1_TENANT_KEYS ∪
 * PHASE3_KEYS ∪ OPS_KEYS) equals that msgid — i.e. the empty msgid IS the
 * .po form a live fixture resolves to. Store the EXACT raw `.po` msgid
 * string here (that is the value the gate's `.some(c => …has(c))` check
 * compares a candidate against). Non-fixture empties never reach an
 * assertion and are NOT listed.
 * NOTE: the raw empty-msgstr count is NOT fixed at 52. That number was the
 * T3b (commit 60309d44) snapshot; Task 4d (runs BEFORE this task) seeds the
 * 37 previously-blocked strings (36 §F.3 + "我的"/"团队管理") with authored
 * English, so the intersection — and this allowlist — SHRINKS toward empty
 * relative to that snapshot. Re-derive the count from the live `.po` at
 * Task-4c execution time; do NOT hardcode 52 (or any number) — the only
 * source of truth is the current extract.
 * Do NOT add a fixture string here merely to make a red test green — that
 * would re-introduce the vacuity this task removes.
 */
export const EN_UNTRANSLATED_ALLOWLIST: ReadonlySet<string> = new Set<string>([
  // Sole live-fixture intersection post-T4d. The phase-3 chart-aria template
  // (phase3-keys.ts, usage-dashboard.tsx:132) is a net-new zh-only string the
  // seed had no English for: en `.po` line 68-69 has `msgstr ""`. Its `.po`
  // msgid is the brace-escaped `'{'window'}'…` form, but the gate compares the
  // fixture's normalized CANDIDATE (de-escaped `{window}…`, the form
  // `normalizeFixtureKey` emits — it never re-escapes) against this set, so the
  // stored value is that de-escaped candidate. Only this one fixture string
  // resolves to an empty en msgstr; every other empty en msgid is a non-fixture
  // (command-palette / preferences) string that never reaches an assertion.
  "Token 用量趋势图，时间范围为 {window}，共 {points} 个 {grain} 粒度数据点。",
]);
