import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const billing = readFileSync(fileURLToPath(new URL("./billing.tsx", import.meta.url)), "utf8");
const members = readFileSync(fileURLToPath(new URL("./members.tsx", import.meta.url)), "utf8");

describe("F1 ICU placeholder normalization", () => {
  it("billing aria-label uses ICU named arg, not a bare JS template via t``", () => {
    expect(billing).not.toContain("t`下载 ${period}`");
    expect(billing).toContain('aria-label={t({ message: "下载 {period}", values: { period } })}');
  });
  it("members confirm copy uses ICU named arg", () => {
    expect(members).not.toContain("t`请输入「${email}」以确认撤销`");
    expect(members).toContain('t({ message: "请输入「{email}」以确认撤销", values: { email } })');
  });
});
