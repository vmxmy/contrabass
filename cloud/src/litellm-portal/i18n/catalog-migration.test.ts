// NOTE: uses the repo's established test path idiom — plain cwd-relative
// string paths to readFileSync/existsSync (cwd = cloud/ when vitest runs),
// mirroring src/litellm-portal/a11y/type-scale.test.ts. The
// fileURLToPath(new URL(..., import.meta.url)) idiom does NOT typecheck under
// cloud/tsconfig.json (@cloudflare/workers-types, no node URL→fileURLToPath
// overload) for an included `.ts` test — it would add non-baseline TS2769.
import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";

const EN_PO = "src/litellm-portal/i18n/locales/en/messages.po";
const ZH_PO = "src/litellm-portal/i18n/locales/zh-CN/messages.po";
const enPo = () => readFileSync(EN_PO, "utf8");
const enMsgstrFor = (msgid: string): string => {
  const po = enPo();
  const escaped = msgid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = po.match(
    new RegExp(`msgid "${escaped}"\\nmsgstr ("(?:[^"\\\\]|\\\\.)*"(?:\\n"(?:[^"\\\\]|\\\\.)*")*)`),
  );
  if (!m) throw new Error(`no en .po entry for msgid ${JSON.stringify(msgid)}`);
  return JSON.parse(`[${m[1].replace(/"\n"/g, '","')}]`).join("");
};

describe("F1 catalog migration", () => {
  it("po catalogs exist for both locales", () => {
    expect(existsSync(ZH_PO)).toBe(true);
    expect(existsSync(EN_PO)).toBe(true);
  });
  it("carries the human English translation for a representative key", () => {
    const po = enPo();
    expect(po).toContain('msgid "登录"');
    expect(po).toMatch(/msgid "登录"\nmsgstr "Sign in"/);
  });
  it("carries the Phase-3 net-new English translation 'Sign in' and a placeholder message", () => {
    const po = enPo();
    expect(po).toContain("Operations Console arrives in Phase 2");
  });
  it("reconciles the 3 placeholder messages whose en translation the exact-match seed lost", () => {
    expect(enMsgstrFor("下载 {period}")).toBe("Download {period}");
    expect(enMsgstrFor("请输入「{email}」以确认撤销")).toBe(
      'Enter "{email}" to confirm revocation',
    );
    expect(enMsgstrFor("{0} 正在代表团队 {1} 操作。所有操作均被审计。")).toBe(
      "{0} is acting on behalf of team {1}. All actions are audited.",
    );
  });
});
