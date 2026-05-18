import { describe, expect, it } from "vitest";
import { setupI18n } from "@lingui/core";
import { messages as zhMessages } from "./locales/zh-CN/messages.mjs";
import { messages as enMessages } from "./locales/en/messages.mjs";

// Mirror the SHIPPED bundle: NODE_ENV=production strips the runtime message
// compiler (@lingui/core/dist/index.mjs:237-241). setupI18n() from the package
// root does NOT auto-register a compiler, so this instance has none — exactly
// the production condition. If catalogs were string-valued (pre-F1), placeholder
// messages would return raw "{realActor} ..." and en would fall back to the
// zh source. Token-array compiled catalogs interpolate without a compiler.
//
// `lingui compile` keys this catalog by content hash, so per the plan's Step-3
// note each `id:` literal below is the compiled hash id read from the generated
// catalogs (verified against locales/{en,zh-CN}/messages.mjs):
//   z5ZpTL = ["请输入「", ["email"], "」以确认撤销"] / ["Enter \"", ["email"], "\" to confirm revocation"]
//   yIs0M9 = ["登录"] / ["Sign in"]
//   Md5UlF = [["0"], " 正在代表团队 ", ["1"], " 操作。..."] / [["0"], " is acting on behalf of team ", ["1"], ". All actions are audited."]
describe("F1 production-mode i18n (no runtime compiler)", () => {
  it("interpolates a placeholder message in production form", () => {
    const i18n = setupI18n();
    i18n.load({ "zh-CN": zhMessages });
    i18n.activate("zh-CN");
    const out = i18n._({
      id: "z5ZpTL",
      values: { email: "a@b.com" },
    });
    expect(out).toBe("请输入「a@b.com」以确认撤销");
    expect(out).not.toContain("{email}");
  });

  it("renders English (not the Chinese source) for the en locale", () => {
    const i18n = setupI18n();
    i18n.load({ en: enMessages });
    i18n.activate("en");
    const out = i18n._({ id: "yIs0M9" });
    expect(out).toBe("Sign in");
    expect(out).not.toBe("登录");
  });

  it("interpolates the impersonation banner message in en", () => {
    // shell.tsx:204-206 is <Trans>{imp.realActor} ... {imp.effectiveTeamId} ...</Trans>.
    // The macro extracts JSX member expressions as POSITIONAL ICU args, so the
    // compiled msgid is "{0} 正在代表团队 {1} ..." and the compiled <Trans> binds
    // values positionally ({0: imp.realActor, 1: imp.effectiveTeamId}). Query
    // with the positional id + positional values — consistent with Task 3b's
    // reconciled positional en string.
    const i18n = setupI18n();
    i18n.load({ en: enMessages });
    i18n.activate("en");
    const out = i18n._({
      id: "Md5UlF",
      values: { 0: "ops@x.com", 1: "team-9" },
    });
    expect(out).toBe("ops@x.com is acting on behalf of team team-9. All actions are audited.");
    expect(out).not.toContain("{0}");
    expect(out).not.toContain("{1}");
  });
});
