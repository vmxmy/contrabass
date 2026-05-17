import { describe, expect, it } from "vitest";
import enMessages from "./i18n/messages/en";
import zhCNMessages from "./i18n/messages/zh-CN";
import { PHASE3_KEYS } from "./i18n/__fixtures__/phase3-keys";

const UNIQUE = [...new Set<string>(PHASE3_KEYS)];

describe("phase-3 i18n completeness", () => {
  it("every phase-3 key exists in en catalog", () => {
    const missing = UNIQUE.filter((k) => !(k in enMessages));
    expect(missing, `Missing from en: ${JSON.stringify(missing)}`).toHaveLength(0);
  });
  it("every phase-3 key exists in zh-CN catalog", () => {
    const missing = UNIQUE.filter((k) => !(k in zhCNMessages));
    expect(missing, `Missing from zh-CN: ${JSON.stringify(missing)}`).toHaveLength(0);
  });
  it("en and zh-CN catalogs still have an identical key set", () => {
    const enKeys = new Set(Object.keys(enMessages));
    const zhKeys = new Set(Object.keys(zhCNMessages));
    expect([...enKeys].filter((k) => !zhKeys.has(k)), "en-only").toHaveLength(0);
    expect([...zhKeys].filter((k) => !enKeys.has(k)), "zh-only").toHaveLength(0);
  });
});
