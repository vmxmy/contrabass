/**
 * @vitest-environment happy-dom
 */
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { I18nProvider } from "@lingui/react";
import { LinkProvider, type LinkComponentProps } from "@cloudflare/kumo/utils";
import { setupI18n } from "../i18n/setup";
import { UserView } from "./index";

const i18n = setupI18n("zh-CN");
afterEach(cleanup);

function wrap(ui: React.ReactElement) {
  return render(<I18nProvider i18n={i18n}>{ui}</I18nProvider>);
}

// Mirrors __root.tsx:250's production wiring: the whole app tree is wrapped in
// <LinkProvider component={KumoRouterLink}>, where KumoRouterLink intercepts
// the click (preventDefault + SPA navigate). Rendering UserView inside the
// REAL Kumo LinkProvider with an intercepting component proves the CTA is a
// plain <a> that LinkProvider does NOT consume — a Kumo LinkButton WOULD be
// routed through this component and its click intercepted (test would fail).
const InterceptingRouterLink = React.forwardRef<HTMLAnchorElement, LinkComponentProps>(
  function InterceptingRouterLink({ href, to, ...props }, ref) {
    return (
      <a
        ref={ref}
        href={href ?? to ?? "/"}
        data-status="router-intercepted"
        {...props}
        onClick={(e) => {
          e.preventDefault();
          props.onClick?.(e);
        }}
      />
    );
  },
);

function wrapWithLinkProvider(ui: React.ReactElement) {
  return render(
    <I18nProvider i18n={i18n}>
      <LinkProvider component={InterceptingRouterLink}>{ui}</LinkProvider>
    </I18nProvider>,
  );
}

describe("§D.1 restyled UserView (unauth/auth-loading welcome)", () => {
  it("renders a branded welcome with a sign-in CTA to /login", () => {
    const { container } = wrap(<UserView />);
    expect(container.querySelector("#portal-welcome-root")).not.toBeNull();
    const cta = screen.getByRole("link", { name: /登录|sign in/i });
    expect(cta.getAttribute("href")).toBe("/login");
  });

  it("CTA is a PLAIN native <a> that escapes the router LinkProvider (FIX 1 — must hard-GET the server /login, NOT SPA-navigate)", () => {
    // The whole app wraps the tree in <LinkProvider component={KumoRouterLink}>
    // (__root.tsx:250). Kumo LinkButton → KumoRouterLink → TanStack <Link
    // to="/login">; /login is NOT a registered TanStack route (router.tsx) — it
    // is server-only (index.ts:67-68 handleLoginGet). A TanStack Link would
    // preventDefault + router.navigate to an unregistered route (broken). The
    // CTA MUST therefore be a plain <a> (native browser GET to the server
    // handler) — mirroring the __root.tsx:93 <form action="/logout"> precedent.
    // Assert the rendered CTA is a native <a> with NO TanStack/router
    // click-intercept marker. (TanStack's Link adds a `data-status` attr and is
    // produced via the LinkProvider; a plain <a> has neither. We assert the
    // POSITIVE structural contract: it is an <a>, href="/login", and carries
    // the sanctioned Kumo-primary class string — NOT a Kumo Button/LinkButton
    // wrapper which would nest a <button>/router <a>.) Rendered inside the REAL
    // production LinkProvider so a LinkButton revert is genuinely caught.
    wrapWithLinkProvider(<UserView />);
    const cta = screen.getByRole("link", { name: /登录|sign in/i }) as HTMLElement;
    expect(cta.tagName).toBe("A"); // native anchor
    expect(cta.getAttribute("href")).toBe("/login");
    expect(cta.getAttribute("data-status")).toBeNull(); // not a TanStack <Link>
    // Defense-in-depth: confirm clicking does NOT call preventDefault (a plain
    // <a> lets the browser navigate; a TanStack Link intercepts). This fails
    // loudly if someone reverts the CTA to LinkButton.
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    cta.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false); // browser navigation, not SPA intercept
  });

  it("does NOT render the legacy data dashboard (no IdentityBar / UsageDashboard / $ amounts)", () => {
    const { container } = wrap(<UserView />);
    // The legacy UserView markers must be gone.
    expect(container.querySelector("#usage-panel-root")).toBeNull();
    // No fake money/KPI content for a logged-out visitor.
    expect(container.textContent ?? "").not.toMatch(/\$\s?0\.00|总消费|模型数/);
  });

  it("is deterministic — no Math.random / Date in the rendered tree (smoke)", () => {
    // Render twice; identical innerHTML (no random width/shimmer/timestamp).
    const a = wrap(<UserView />).container.innerHTML;
    cleanup();
    const b = wrap(<UserView />).container.innerHTML;
    expect(a).toBe(b);
  });
});
