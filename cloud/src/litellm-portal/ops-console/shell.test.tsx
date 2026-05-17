/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, it, expect } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { I18nProvider } from "@lingui/react";
import { setupI18n } from "../i18n/setup";
import { OpsConsoleShell } from "./shell";
import type { PortalIdentity } from "../types";

const i18n = setupI18n("zh-CN");

function renderShell(identity: PortalIdentity) {
  return render(
    <I18nProvider i18n={i18n}>
      <OpsConsoleShell identity={identity}>
        <div>child</div>
      </OpsConsoleShell>
    </I18nProvider>,
  );
}

const owner: PortalIdentity = {
  email: "owner@x.com", userId: "u1", domain: "x.com", litellmUserId: "u1",
  role: "admin", tenantRole: null, tenantTeamId: null,
};
const nonOwner: PortalIdentity = {
  email: "user@x.com", userId: "u2", domain: "x.com", litellmUserId: "u2",
  role: "user", tenantRole: "member", tenantTeamId: "t1",
};

afterEach(cleanup);

describe("OpsConsoleShell", () => {
  it("Owner sees all seven nav items + ops chip", () => {
    renderShell(owner);
    for (const label of ["租户总览", "发放与邀请", "全局用量", "审计", "平台设置"]) {
      expect(screen.getByText(new RegExp(label))).toBeTruthy();
    }
    expect(screen.getByText(/运营控制台/)).toBeTruthy();
  });

  it("non-Owner sees a 403 card + link to / (no nav)", () => {
    renderShell(nonOwner);
    expect(screen.getByText(/仅平台 Owner 可访问/)).toBeTruthy();
    expect(screen.queryByText(/租户总览/)).toBeNull();
  });
});
