/**
 * i18n completeness test for the Tenant Portal namespace.
 *
 * Asserts that every key used by the tenant-portal screens, shell, and routes
 * is present in BOTH the `en` and `zh-CN` catalogs, and that the two catalogs
 * have exactly the same key set (no locale-only key).
 *
 * HOW IT WORKS
 * ============
 * We maintain an explicit allowlist of Lingui message IDs that belong to the
 * tenant-portal namespace. This is intentionally explicit rather than trying
 * to parse source ASTs — it is the safety-net sweep that catches any key
 * omitted from either catalog.
 *
 * When you add a new key used by tenant-portal code, add it here too.
 * The test will fail on the first run, which forces the author to also
 * add matching entries to BOTH catalogs before merging.
 */
import { describe, expect, it } from "vitest";
import enMessages from "../i18n/messages/en";
import zhCNMessages from "../i18n/messages/zh-CN";
import { PHASE1_TENANT_KEYS } from "../i18n/__fixtures__/phase1-keys";

// ---------------------------------------------------------------------------
// Tenant-portal message keys — the complete expected set for this namespace.
// The canonical allowlist now lives in the shared fixture so the ops-console
// completeness test can reason about Phase-1 ↔ Ops key overlap.
// ---------------------------------------------------------------------------
const TENANT_PORTAL_KEYS = PHASE1_TENANT_KEYS;

// Deduplicate (some keys like "告警 Webhook" appear in multiple screens)
const UNIQUE_KEYS = [...new Set(TENANT_PORTAL_KEYS)];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("tenant-portal i18n completeness", () => {
  it("every tenant-portal key exists in en catalog", () => {
    const missing = UNIQUE_KEYS.filter((key) => !(key in enMessages));
    expect(missing, `Missing from en: ${JSON.stringify(missing)}`).toHaveLength(0);
  });

  it("every tenant-portal key exists in zh-CN catalog", () => {
    const missing = UNIQUE_KEYS.filter((key) => !(key in zhCNMessages));
    expect(missing, `Missing from zh-CN: ${JSON.stringify(missing)}`).toHaveLength(0);
  });

  it("en and zh-CN catalogs have the same complete key set (no locale-only key in either)", () => {
    const enKeys = new Set(Object.keys(enMessages));
    const zhKeys = new Set(Object.keys(zhCNMessages));

    const enOnly = [...enKeys].filter((k) => !zhKeys.has(k));
    const zhOnly = [...zhKeys].filter((k) => !enKeys.has(k));

    expect(
      enOnly,
      `Keys in en but not zh-CN: ${JSON.stringify(enOnly)}`,
    ).toHaveLength(0);
    expect(
      zhOnly,
      `Keys in zh-CN but not en: ${JSON.stringify(zhOnly)}`,
    ).toHaveLength(0);
  });
});
