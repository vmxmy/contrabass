# Phase 3 §D — Public-Entry Restyle (UserView + /login) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. **Both tasks are RETAINED-REVIEW** (public-entry + #418-LOCKED-INVARIANT-ADJACENT + login-security-adjacent): spec + #418/security review FIRST, code-quality review after — same tier as Phase-3 Task-2C / Task-0B.

**Goal:** Bring the two un-restyled public entry points into the Phase-3 design language so the first thing anyone sees is the new design: (1) `routes/index.tsx` `UserView` (the `me===undefined` SSR/unauth/auth-loading branch at `/`) becomes a deterministic branded welcome + sign-in CTA — NOT the legacy fake-`$0.00` dashboard; (2) `auth/login-routes.ts` `loginPage()` (SSR string, no-JS magic-link page) is restyled to the same Kumo visual language, security flow byte-unchanged.

**Architecture:** Same Cloudflare-Worker SSR + React-island + Kumo stack, same branch `feat/litellm-portal-phase3-design-restyle`, same whole-branch re-review before PR #141. `UserView` is a React component in the `renderPortalSSR("/")` tree — #418-CRITICAL (SSR == client-first-render). `loginPage()` is a standalone SSR HTML string outside the React tree — no #418 surface, presentation-only.

**Tech Stack:** TypeScript, Cloudflare Workers SSR, React, `@cloudflare/kumo@^2.1.0`, Lingui (zh-CN/en macros, the established `<Trans>`/`t` pattern), TanStack Router, Vitest (`bun run test`), the Phase-3 `useHasHydrated`/`SsrSafeSkeleton`/`Panel*` discipline (reused, not re-created).

---

## Prerequisites (read before Task D1)

- **Branch:** `feat/litellm-portal-phase3-design-restyle` (the Phase-3 branch). §D folds in here, NOT a new branch/PR. Whole-branch re-review (single critic pass) before PR #141 covers §D too.
- **Sequence (LOCKED):** §D lands AFTER the two in-flight Phase-3 blocker fixes — **B1** (stale §F.3 tests) and **B2** (perf-spec real-auth, which adds the **session-cookie test helper**). §D Task D1's authenticated-preview verification (confirming `me`-resolves → §B shell, and the auth-loading flash is now the branded welcome not the legacy dashboard) DEPENDS on B2's session-cookie helper. Do NOT start §D until B1+B2 are committed on the branch. (This plan does not duplicate B1/B2 — only declares the order.)
- **§D runs after the §A GATE + §B** (it consumes §B's design vocabulary + Task-0B `useHasHydrated`/`SsrSafeSkeleton` + Task-2 `Panel*`). It is NOT a §A-hygiene-gate item.
- **SAME-FILE SERIALIZATION (critical):** §D Task D1 edits `cloud/src/litellm-portal/hydration.test.tsx` (the `UserView` case). Phase-3 **Task-0B also edits `hydration.test.tsx`** (the shell-skeleton 7/7 case) and **Task-3 extends it** (NEW-C-A `/usage` parity + negative control). §D Task D1's hydration-test edit MUST be serialized AFTER Task-0B and Task-3 (never concurrent — same file). Re-anchor by symbol; preserve every Task-0B/Task-3 case verbatim — §D only renames/retargets the ONE pre-existing `"unauthenticated → legacy UserView at /"` case.
- **Toolchain HARD RULES (from `cloud/`):** tests `cd /Users/xumingyang/github/contrabass/cloud && bun run test <path>` — **NEVER** `npx vitest`/`bun test`. Typecheck `bun run typecheck` (only the pre-existing `server.ts → server-impl.tsx --jsx` baseline error allowed; ZERO new). Commits `<type>(litellm-portal): <imperative ≤72 chars>`, lowercase, no trailing period, `git -c commit.gpgsign=false`, explicit paths only. `git merge main` (never rebase/squash) if conflicts.
- **§B.0 boundary (carried):** no Kumo fork; no semantic/hierarchy/typography/radius token override; NO `shadow-*` (use surface layering + hairline for depth); bilingual (new copy → i18n catalogs first, Phase-3 `i18n-completeness-phase3.test.ts` + `i18n/__fixtures__/phase3-keys.ts` guard); dark-mode; WCAG-AA.
- **Verified anchors (re-confirm by symbol before editing — line numbers drift on the Phase-3 branch):**
  - `cloud/src/litellm-portal/routes/index.tsx`: `PortalIndex`@~34 (`if (me === undefined) return <UserView />;`@~37-39), `UserView`@~69-78 (`<IdentityBar/>` + `<section id="usage-panel-root"><UsageDashboard/></section>`), `toTenantBrand`@~65, imports@1-10 (NO Lingui import currently).
  - `cloud/src/litellm-portal/hooks/use-me.ts`: single `useQuery`, `data===undefined` on unresolved/401 — NO unauth-vs-loading signal (verified).
  - `cloud/src/litellm-portal/server-impl.tsx`@54-74: seeds `ME_QUERY_KEY` ONLY when `dataWithIdentity !== null` (authenticated) — unauth SSR never seeds → `useMe()` undefined on SSR+client → `UserView` both sides (the #418 contract).
  - `cloud/src/litellm-portal/hydration.test.tsx`: `TASK_1W_CASES`@~267, the `"unauthenticated → legacy UserView at /"` case@~317-329 (`identity` empty, `initialData: null`; its comment cites `#usage-panel-root` as the UserView marker), the parametrized `it`@~331-366 (`renderPortalSSR(makeEnv(), tc.identity, tc.initialData, "test-nonce", "http://localhost/", "zh-CN")` → `loadSsrDocument` → `hydrateLikeClient` → `captured` hydration-error filter → `expect(hydrationErrors).toEqual([])`). Task-0B's shell-skeleton case + Task-3's `USAGE_LAZY_PARITY_CASES`@~382 are in the SAME file — DO NOT touch them.
  - `cloud/src/litellm-portal/auth/login-routes.ts`: `loginPage(errorMsg?, successEmail?): string`@~109-175 (pure string fn: `<!DOCTYPE html>` + inline `<style>` hardcoded hex `#f5f5f5`/`#fff`/`#0f62fe`/`#da1e28`/`#198038` + `box-shadow` + `<form method="POST" action="/login">` email-input/submit, success/error 三态, `maskEmail`@~101). `handleLoginGet`@~211 / `handleLoginPost`@~278 call `htmlResp(loginPage(...))`. Magic-link/CSRF/rate-limit/allowlist (`./allowlist`, `./magic-link`, `isEmailAllowed`, `issueMagicLink`/`sendMagicLink`/`verifyMagicLink`) — **NOT touched**; only the `loginPage()` returned string body changes.
  - `cloud/src/litellm-portal/auth/login-routes.test.ts`: existing tests assert `handleMagicCallback` flow (302/set-cookie) — NOT `loginPage()` markup. §D adds a new presentation-regression `describe` to a NEW colocated test (do not entangle the security tests).
  - i18n: `cloud/src/litellm-portal/i18n/__fixtures__/phase3-keys.ts` (`PHASE3_KEYS` array), `cloud/src/litellm-portal/i18n-completeness-phase3.test.ts` (asserts each key in BOTH `i18n/messages/{en,zh-CN}.ts`), catalogs `i18n/messages/en.ts` + `zh-CN.ts` (`const messages: Record<string,string>`). Lingui pattern: `import { t } from "@lingui/core/macro"; import { Trans } from "@lingui/react/macro";` then `<Trans>中文</Trans>` / `` t`中文` `` (as `tenant-portal/shell.tsx` does).
  - Kumo button: `import { Button, LinkButton } from "@cloudflare/kumo/components/button";` (as `routes/__root.tsx` `HeaderActions` uses `LinkButton href=… variant=…`).

---

## Task list (2 tasks, both RETAINED-REVIEW)

- **Task D1 (§D.1 + §D.3) — restyle `UserView` to a branded welcome + sign-in CTA; update + prove the `hydration.test.tsx` UserView case (10/10).** [RETAINED-REVIEW]
- **Task D2 (§D.2) — restyle `loginPage()` to the Kumo visual language; security flow byte-unchanged; presentation-regression test.** [RETAINED-REVIEW]

(File-disjoint: D1 = `routes/index.tsx` + `hydration.test.tsx` + i18n; D2 = `auth/login-routes.ts` + a new login-presentation test. May run in either order or parallel — but D1's `hydration.test.tsx` edit serializes AFTER Phase-3 Task-0B + Task-3, per Prerequisites.)

---

## Task D1 (§D.1 + §D.3): restyle `UserView` → branded welcome; #418 10/10 [RETAINED-REVIEW]

**Files:**
- Modify: `cloud/src/litellm-portal/routes/index.tsx` (`UserView` only; `PortalIndex`/`toPortalIdentity`/`toTenantBrand`/`indexRoute` UNCHANGED), `cloud/src/litellm-portal/hydration.test.tsx` (rename+retarget the ONE `UserView` case — serialized after Task-0B/Task-3), `cloud/src/litellm-portal/i18n/messages/en.ts`, `cloud/src/litellm-portal/i18n/messages/zh-CN.ts`, `cloud/src/litellm-portal/i18n/__fixtures__/phase3-keys.ts`
- Create: `cloud/src/litellm-portal/routes/user-view.test.tsx` (focused component test for the new welcome — deterministic markup, sign-in link, no data-dashboard)
- **NOT touched:** `PortalIndex` branch logic, `useMe`, `server-impl.tsx`, Task-0B's shell-skeleton hydration case, Task-3's NEW-C-A cases, `IdentityBar`/`UsageDashboard` (just no longer rendered by `UserView`).

> **RETAINED-REVIEW (LOCKED-INVARIANT-ADJACENT, public entry):** `UserView` IS the SSR-emitted `/` state for `me===undefined`. The reviewer MUST verify: (a) the new markup is fully deterministic — NO `Math.random`/`Date.now`/`new Date()`/`window`/`document`/effect controlling first render (the design is a static welcome → trivially satisfied; any dynamic bit MUST go through Task-0B `useHasHydrated`/`SsrSafeSkeleton`); (b) `hydration.test.tsx` is GREEN incl. the retargeted welcome case AND every untouched Task-0B/Task-3 case (10/10 semantics = the whole file green, UserView case migrated to the new marker, SSR==client); (c) no data/PII/`$`-amounts shown to a logged-out visitor.

- [ ] **Step 1: Write the failing UserView component test** — `cloud/src/litellm-portal/routes/user-view.test.tsx`. Asserts the new welcome (branded heading + sign-in link to `/login`) and the ABSENCE of the legacy dashboard markers. (Export `UserView` from `routes/index.tsx` for testability — it is currently a private fn; add `export` in Step 3, the test imports it.)

```tsx
/**
 * @vitest-environment happy-dom
 */
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { I18nProvider } from "@lingui/react";
import { setupI18n } from "../i18n/setup";
import { UserView } from "./index";

const i18n = setupI18n("zh-CN");
afterEach(cleanup);

function wrap(ui: React.ReactElement) {
  return render(<I18nProvider i18n={i18n}>{ui}</I18nProvider>);
}

describe("§D.1 restyled UserView (unauth/auth-loading welcome)", () => {
  it("renders a branded welcome with a sign-in CTA to /login", () => {
    const { container } = wrap(<UserView />);
    expect(container.querySelector("#portal-welcome-root")).not.toBeNull();
    const cta = screen.getByRole("link", { name: /登录|sign in/i });
    expect(cta.getAttribute("href")).toBe("/login");
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
```

- [ ] **Step 2: Run → FAIL** — `cd /Users/xumingyang/github/contrabass/cloud && bun run test src/litellm-portal/routes/user-view.test.tsx` → FAIL (`UserView` not exported; `#portal-welcome-root`/sign-in link absent; legacy `#usage-panel-root` still present).

- [ ] **Step 3: Restyle `UserView` in `cloud/src/litellm-portal/routes/index.tsx`.** Re-anchor by symbol. Add the Lingui macro imports (the established pattern — `routes/index.tsx` has none yet) and a Kumo `LinkButton`; remove the `IdentityBar`/`UsageDashboard` imports IF nothing else in the file uses them (grep the file — `PortalIndex` does not; both were only used by `UserView`). Replace `function UserView()` with the exported, restyled, fully-static welcome:

```tsx
// add to imports (top of routes/index.tsx) — established Phase-3 pattern:
import { LinkButton } from "@cloudflare/kumo/components/button";
import { Text } from "@cloudflare/kumo/components/text";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { FOCUS_RING } from "../a11y/focus";
// REMOVE these two imports (only UserView used them; PortalIndex does not):
//   import { IdentityBar } from "../identity-bar";
//   import { UsageDashboard } from "../dashboard/views/usage-dashboard";
```

```tsx
/**
 * Public welcome — the SSR-emitted `/` state when `me === undefined`
 * (logged-out visitor OR the brief auth-resolving window; useMe() exposes no
 * signal to tell them apart — Phase-3 §D, locked). Fully STATIC and
 * deterministic: NO Math.random / Date / window / effect controlling the first
 * render, so SSR === client first render (#418-safe by construction — the
 * same OQ-(b) discipline; this view has zero dynamic content so it needs no
 * useHasHydrated/SsrSafeSkeleton gate). Never shows data/PII/$-amounts to a
 * logged-out visitor — it is a branded welcome + a clear sign-in CTA, NOT a
 * dashboard. Once `me` resolves, PortalIndex swaps to the §B TenantPortalShell
 * (unchanged); the brief pre-resolve flash is now this branded welcome instead
 * of the legacy fake-$0.00 dashboard.
 */
export function UserView() {
  return (
    <main
      id="portal-welcome-root"
      className="mx-auto flex min-h-[60vh] max-w-2xl flex-col items-center justify-center gap-6 px-6 py-16 text-center motion-safe:transition-opacity motion-safe:duration-150"
    >
      <div className="flex flex-col items-center gap-3">
        <Text as="h1" variant="heading1" className="text-kumo-strong">
          <Trans>智云 AI 管理平台</Trans>
        </Text>
        <Text as="p" variant="secondary" className="max-w-prose text-kumo-subtle">
          <Trans>面向团队的 AI 能力自助台。请登录以查看你的用量、密钥与团队管理。</Trans>
        </Text>
      </div>
      <LinkButton
        href="/login"
        variant="primary"
        className={`rounded-full ${FOCUS_RING}`}
        aria-label={t`登录`}
      >
        <Trans>登录</Trans>
      </LinkButton>
    </main>
  );
}
```

> Notes: (i) `LinkButton` renders a real `<a href>` (verified — `routes/__root.tsx` uses `LinkButton href=… variant=…`) so the test's `getByRole("link")` resolves and it is keyboard-reachable + no-JS. (ii) `variant="primary"` consumes the Kumo brand token (no token override). (iii) `motion-safe:transition-opacity duration-150` mirrors §B.4 (≤200ms, reduced-motion-safe) — optional polish, no dynamic state. (iv) The heading text reuses the platform name copy already used by `__root.tsx`'s generic chrome (`智云AI管理平台`) — if that exact string is already a catalog key, reuse it (Step 5 reconciles; do not duplicate a key). (v) NO `useDashboard`/`useMe`/data — a logged-out visitor sees zero protected content. (vi) `id="portal-welcome-root"` is the new stable marker the hydration test (Step 6) keys off, replacing the legacy `#usage-panel-root`.

- [ ] **Step 4: Run the component test → PASS** — `cd /Users/xumingyang/github/contrabass/cloud && bun run test src/litellm-portal/routes/user-view.test.tsx` → PASS (3 tests). `bun run typecheck` → baseline-only (confirm the removed `IdentityBar`/`UsageDashboard` imports caused no other breakage in `routes/index.tsx` — `PortalIndex` does not reference them; if `typecheck` flags an unused/over-removed import, the grep in Step 3 was the gate — re-confirm and fix imports, do NOT re-add dead code).

- [ ] **Step 5: i18n — add the new keys to BOTH catalogs + the Phase-3 fixture.** New zh source strings introduced by Step 3: `智云 AI 管理平台`, `面向团队的 AI 能力自助台。请登录以查看你的用量、密钥与团队管理。`, `登录`. For EACH: (a) confirm whether it already exists in `i18n/messages/zh-CN.ts`/`en.ts` (e.g. a platform-name string may already be a key from `__root.tsx`) — `rg -n "智云" src/litellm-portal/i18n/messages/*.ts`; if present, REUSE it (do not re-add — the Phase-3 completeness test only asserts presence in both catalogs). (b) For each genuinely-new key add it to `i18n/messages/zh-CN.ts` (identity-mapped: `"…": "…"` same zh string) AND `i18n/messages/en.ts` (the English translation: e.g. `"登录": "Sign in"`, `"智云 AI 管理平台": "Zhiyun AI Management Platform"`, `"面向团队的 AI 能力自助台。请登录以查看你的用量、密钥与团队管理。": "Your team's AI self-service console. Sign in to view your usage, keys, and team management."`). (c) Append every genuinely-new key to `PHASE3_KEYS` in `cloud/src/litellm-portal/i18n/__fixtures__/phase3-keys.ts` under a new comment block `// §D public welcome (routes/index.tsx UserView)`. Run `cd /Users/xumingyang/github/contrabass/cloud && bun run test src/litellm-portal/i18n-completeness-phase3.test.ts` → PASS (every PHASE3_KEYS entry present in both catalogs; the test fails loudly if a key is missing from either — that is the guard). Also re-run `bun run test src/litellm-portal/i18n-completeness.test.ts` (Phase-1/2 namespace) → still PASS (no key removed).

- [ ] **Step 6: Update the `hydration.test.tsx` UserView case (SERIALIZED after Task-0B + Task-3 — same file).** Re-anchor by symbol: in `TASK_1W_CASES` find the object `{ name: "unauthenticated → legacy UserView at /", identity: { …empty… }, initialData: null }` and its preceding comment block (it cites `#usage-panel-root`). Make EXACTLY these minimal edits, touching nothing else in the file (every Task-0B / Task-3 case stays verbatim):
  - Rename `name: "unauthenticated → legacy UserView at /"` → `name: "unauthenticated → restyled welcome at /"`.
  - Rewrite the preceding comment to: `// Mirrors the index.ts unauthenticated request path: empty identity + null initialData. server-impl.tsx skips seeding ME_QUERY_KEY (dataWithIdentity null), so useMe() resolves undefined on BOTH server and client → PortalIndex renders the restyled UserView welcome (#portal-welcome-root) deterministically on both sides (§D.1; fully static, no Math.random/Date — #418-safe by construction).`
  - The parametrized `it` already only asserts `expect(html).toContain("<!doctype html>")` + `expect(hydrationErrors).toEqual([])` (no `#usage-panel-root` literal in the `it` body — verified; the marker was only in the comment). So NO code change to the `it` is needed beyond the case rename. **Add ONE positive assertion inside the `it`, gated to this case only, to PIN the new SSR marker** (so a future regression that loses the welcome is caught): immediately after `expect(html).toContain("<!doctype html>");` add:

```tsx
      if (tc.name === "unauthenticated → restyled welcome at /") {
        // §D.3: the restyled welcome IS the SSR-emitted unauth `/` state.
        expect(html).toContain('id="portal-welcome-root"');
        expect(html).not.toContain('id="usage-panel-root"');
      }
```

  This block is inert for every other `TASK_1W_CASES` entry (and for Task-0B/Task-3 loops, which are separate `for` blocks) — it ONLY adds an assertion for the §D case, leaving all other cases byte-identical.

- [ ] **Step 7: Run the FULL hydration suite → 10/10 (the #418 proof step).** `cd /Users/xumingyang/github/contrabass/cloud && bun run test src/litellm-portal/hydration.test.tsx` → **ALL cases GREEN**: the renamed `"unauthenticated → restyled welcome at /"` case passes (SSR contains `#portal-welcome-root`, not `#usage-panel-root`; `hydrateLikeClient` produces ZERO captured hydration mismatches because the static welcome is byte-identical SSR vs client first render) AND every untouched case stays green — the other `TASK_1W_CASES` (`tenant_admin full-nav shell at /`, `member 3-item-nav`, `pure-Owner Phase-2 notice` — all `TenantPortalShell` paths, NOT `UserView`, unaffected), Task-0B's shell-skeleton 7/7, Task-3's NEW-C-A `/usage`/`/ops/usage` parity + negative control. "10/10" = the whole `hydration.test.tsx` file green with the UserView case migrated to the new welcome marker and SSR==client. If the renamed case shows a hydration mismatch, `UserView` has a non-deterministic bit (it must not — the design is fully static; re-inspect Step 3, NO `Math.random`/`Date`/`window`); if a non-UserView case regresses, Step 6 touched too much (it must touch ONLY the §D case rename + the gated assertion). `bun run typecheck` → baseline-only.

- [ ] **Step 8: Authenticated-preview verification note (DEPENDS on Blocker-2 session-cookie helper).** Document (not a code step — a verification the lead/executor performs once B2's session-cookie helper exists): with an authenticated session, hitting `/` resolves `me` → `PortalIndex` swaps from the brief `#portal-welcome-root` flash to the §B `TenantPortalShell` (no legacy fake-`$0.00` dashboard flash anymore). This confirms §D.1's auth-loading-flash fix. If B2 is not yet landed, this is a deferred manual check recorded in the whole-branch re-review checklist (NOT a blocker for D1's automated acceptance, which is Steps 4/5/7).

- [ ] **Step 9: Commit**
```bash
cd /Users/xumingyang/github/contrabass
git add cloud/src/litellm-portal/routes/index.tsx cloud/src/litellm-portal/routes/user-view.test.tsx cloud/src/litellm-portal/hydration.test.tsx cloud/src/litellm-portal/i18n/messages/en.ts cloud/src/litellm-portal/i18n/messages/zh-CN.ts cloud/src/litellm-portal/i18n/__fixtures__/phase3-keys.ts
git -c commit.gpgsign=false commit -m "feat(litellm-portal): restyle public UserView to branded welcome (#418-safe)"
```

---

## Task D2 (§D.2): restyle `loginPage()` to Kumo visual language; security byte-unchanged [RETAINED-REVIEW]

**Files:**
- Modify: `cloud/src/litellm-portal/auth/login-routes.ts` (`loginPage()` returned-string body ONLY)
- Create: `cloud/src/litellm-portal/auth/login-page.test.ts` (presentation-regression — NOT entangled with the existing security tests in `login-routes.test.ts`)
- **NOT touched (security — byte-unchanged):** `handleLoginGet`/`handleLoginPost`/`handleMagicCallback`/`handleLogout`, `htmlResp`, `maskEmail`, `isEmailAllowed`, `issueMagicLink`/`sendMagicLink`/`verifyMagicLink`, CSRF, rate-limit, `BOOTSTRAP_ADMIN_EMAILS` allowlist, every call site (`htmlResp(loginPage(...))`), success/error branching. The diff is confined to the `loginPage()` string body (HTML/CSS) + optional pure style helper.

> **RETAINED-REVIEW (login-security-adjacent, public entry):** the reviewer MUST verify the diff is presentation-only — `git diff` for `login-routes.ts` shows changes ONLY inside `loginPage()`'s returned template string (and at most a new pure `const`/style helper); ZERO change to any handler, token, cookie, CSRF, rate-limit, allowlist, or call site; the `<form method="POST" action="/login">` + email input + submit + error/success branches remain functionally identical (only restyled).

- [ ] **Step 1: Write the failing presentation-regression test** — `cloud/src/litellm-portal/auth/login-page.test.ts`. Pins the security-invariant markup AND the restyle (the existing `login-routes.test.ts` does NOT assert `loginPage()` markup — verified; this is additive, separate file):

```ts
import { describe, it, expect } from "vitest";
import { handleLoginGet, handleLoginPost } from "./login-routes";

// loginPage() is a private string fn; assert via the public handlers that
// return htmlResp(loginPage(...)). Security-invariant markup MUST persist;
// the restyle is asserted by the new Kumo-aligned visual contract.

async function getLoginHtml(): Promise<string> {
  const res = await handleLoginGet(new Request("http://localhost/login"), {} as never);
  return res.text();
}

describe("§D.2 restyled /login (presentation-only; security flow byte-unchanged)", () => {
  it("preserves the magic-link POST form (security invariant — UNCHANGED)", async () => {
    const html = await getLoginHtml();
    expect(html).toContain('method="POST"');
    expect(html).toContain('action="/login"');
    expect(html).toMatch(/<input[^>]+type="email"[^>]+name="email"/);
    expect(html).toMatch(/<button[^>]*>[\s\S]*?<\/button>/); // submit present
  });

  it("is restyled to the Kumo visual language: NO box-shadow, branded button, dark-safe", async () => {
    const html = await getLoginHtml();
    // §B.0: no decorative shadow — depth via hairline/surface, not shadow.
    expect(html).not.toMatch(/box-shadow\s*:/i);
    // Dark-safe: a prefers-color-scheme dark rule exists (standalone no-Kumo
    // SSR page → media-query, the spec-sanctioned local deterministic style).
    expect(html).toMatch(/@media \(prefers-color-scheme: dark\)/);
    // Branded primary button color is the Kumo-aligned brand hex (the
    // sanctioned local constant — see Step 3), not the legacy #0f62fe.
    expect(html).not.toContain("#0f62fe");
  });

  it("still serves a complete no-JS HTML document (SSR/no-JS functional)", async () => {
    const html = await getLoginHtml();
    expect(html).toMatch(/^<!DOCTYPE html>/i);
    expect(html).toContain("</html>");
    expect(html).not.toMatch(/<script\b/i); // no JS dependency introduced
  });
});
```

- [ ] **Step 2: Run → FAIL** — `cd /Users/xumingyang/github/contrabass/cloud && bun run test src/litellm-portal/auth/login-page.test.ts` → FAIL (current `loginPage()` has `box-shadow`, `#0f62fe`, no `prefers-color-scheme: dark`).

- [ ] **Step 3: Restyle `loginPage()`'s returned string in `cloud/src/litellm-portal/auth/login-routes.ts`.** Re-anchor by symbol (`function loginPage(errorMsg?: string, successEmail?: string): string`). Change ONLY the returned template literal: rewrite the inline `<style>` + card markup to the Kumo visual language. Constraints: keep `${formSection}` (the `<form method="POST" action="/login">` / success / error branching) STRUCTURALLY UNCHANGED — only its wrapping/classes/copy-language stay as-is (do NOT introduce an i18n runtime to this no-React string page — copy language behavior is byte-unchanged per spec §D.2); remove ALL `box-shadow` (use a `1px` hairline border + surface contrast for depth, §B.0); replace the legacy hex with a small set of named local constants at the top of `login-routes.ts` (a spec-§D.2-sanctioned local exception — this page is OUTSIDE the Kumo runtime, cannot use Kumo utility classes; these are the page's self-contained Kumo-visually-aligned deterministic constants, analogous to the §F.6 `ops-theme` sanctioned-exception — document them as such); add a `@media (prefers-color-scheme: dark)` block (dark-safe, since no portal `data-mode` runtime here). Concrete shape (executor adjusts exact values to the Kumo light/dark canvas/elevated/brand to match the portal — keep them deterministic constants, NO `Math.random`):

```ts
// near the top of login-routes.ts, after imports — SANCTIONED local style
// constants (§D.2): /login is a standalone SSR HTML doc OUTSIDE the Kumo
// runtime (no React/Kumo class can apply), so its inline style uses these
// self-contained, Kumo-visually-aligned, DETERMINISTIC hex constants. This is
// the documented per-page exception (analogous to §F.6 ops-theme). NO other
// raw hex; NO Math.random; presentation-only — zero auth-logic coupling.
const LOGIN_STYLE = {
  bg: "#fafafa", card: "#ffffff", border: "#e5e5e5", ink: "#1a1a1a",
  subtle: "#555555", brand: "#1f3a8a", brandHover: "#162a63",
  error: "#b42318", success: "#177245",
  // dark-mode counterparts (prefers-color-scheme: dark)
  dBg: "#1a1a1a", dCard: "#242424", dBorder: "#3a3a3a", dInk: "#f4f4f4",
  dSubtle: "#a0a0a0",
} as const;
```

Then inside `loginPage()`, replace the `<style>…</style>` body with a Kumo-aligned stylesheet built from `LOGIN_STYLE` (centered branded card, `border: 1px solid ${LOGIN_STYLE.border}` NO `box-shadow`, `border-radius` ~12–16px to match DESIGN.md `md/lg`, `system-ui` font, accessible focus ring on the input/button — `:focus-visible { outline: 2px solid ${LOGIN_STYLE.brand}; outline-offset: 2px; }`, WCAG-AA contrast for `ink`/`subtle`/button), and add a trailing `@media (prefers-color-scheme: dark){ body{background:${LOGIN_STYLE.dBg}} .card{background:${LOGIN_STYLE.dCard};border-color:${LOGIN_STYLE.dBorder}} h1{color:${LOGIN_STYLE.dInk}} label{color:${LOGIN_STYLE.dSubtle}} … }`. Keep the `<h1>Sign in</h1>` / labels / button text strings AS-IS (existing language behavior, per spec — no new i18n runtime). The `${formSection}`, `${errorMsg}`, `maskEmail(successEmail)` interpolations and the success/error conditional are STRUCTURALLY UNCHANGED.

> **HARD invariant for the executor:** the `git diff` of `login-routes.ts` MUST be confined to (a) the new `LOGIN_STYLE` const and (b) the `<style>`/card markup inside `loginPage()`'s returned string. If the diff touches `handleLoginGet`/`handleLoginPost`/`handleMagicCallback`/`htmlResp`/`maskEmail`/CSRF/rate-limit/allowlist/`sendMagicLink`/`issueMagicLink`/`verifyMagicLink` or any call site — STOP, that violates §D.2 (presentation-only). The form's `method`/`action`/input `name`/submit and the error/success branches are functionally identical.

- [ ] **Step 4: Run the presentation test → PASS** — `cd /Users/xumingyang/github/contrabass/cloud && bun run test src/litellm-portal/auth/login-page.test.ts` → PASS (3 tests: POST form preserved; no box-shadow + dark media query + branded button; complete no-JS doc). `bun run typecheck` → baseline-only.

- [ ] **Step 5: Security-flow non-regression — run the existing auth suites UNCHANGED → all green.** `cd /Users/xumingyang/github/contrabass/cloud && bun run test src/litellm-portal/auth/login-routes.test.ts src/litellm-portal/auth/magic-link.test.ts src/litellm-portal/auth/csrf.test.ts src/litellm-portal/auth/allowlist.test.ts src/litellm-portal/auth/session.test.ts src/litellm-portal/e2e-flow.test.ts` → ALL PASS, UNCHANGED (these assert the magic-link/CSRF/rate-limit/allowlist/callback flow; §D.2 is presentation-only so they MUST stay green with zero edits — this is the proof the security flow is byte-unchanged). If ANY of these change behavior, Step 3 violated the presentation-only boundary — revert and confine the diff to `loginPage()`'s string.

- [ ] **Step 6: Commit**
```bash
cd /Users/xumingyang/github/contrabass
git add cloud/src/litellm-portal/auth/login-routes.ts cloud/src/litellm-portal/auth/login-page.test.ts
git -c commit.gpgsign=false commit -m "feat(litellm-portal): restyle /login to Kumo visual language (presentation-only)"
```

---

## End-to-End Verification (§D, folds into the whole-branch re-review before PR #141)

Order: **typecheck → §D test sweep → manual staging check → (whole-branch re-review covers §D)**.

- [ ] `cd /Users/xumingyang/github/contrabass/cloud && bun run typecheck` → only the pre-existing `server.ts → server-impl.tsx --jsx` baseline; ZERO new.
- [ ] `bun run test src/litellm-portal/routes/user-view.test.tsx src/litellm-portal/hydration.test.tsx src/litellm-portal/i18n-completeness-phase3.test.ts src/litellm-portal/i18n-completeness.test.ts src/litellm-portal/auth/login-page.test.ts src/litellm-portal/auth/login-routes.test.ts src/litellm-portal/auth/magic-link.test.ts src/litellm-portal/auth/csrf.test.ts src/litellm-portal/auth/allowlist.test.ts src/litellm-portal/auth/session.test.ts src/litellm-portal/e2e-flow.test.ts` → ALL GREEN. **`hydration.test.tsx` is the #418 oracle and MUST be fully green (10/10 semantics: UserView case migrated to `#portal-welcome-root`, SSR==client, every Task-0B/Task-3 case untouched & green).** The auth suites are UNCHANGED and green = the §D.2 presentation-only proof. NO CI runs `cd cloud && bun run test` (verified Phase-3 fact: `ci.yml`=`make test-quick`) — this local sweep is the authoritative §D gate; "CI covers it" is FALSE. The only tolerated reds are the two Phase-3 by-name isolated-confirmed exclusions (kumo.css fetch flake; pre-existing-on-`main` `?window=90d`); everything §D-touched must be genuinely green.
- [ ] Manual staging (in the whole-branch re-review): hit `/` logged-out → branded welcome (`#portal-welcome-root`) + working `登录`/Sign-in link to `/login`, NO `$0.00`/KPI/`加载中…`; light AND dark; zh AND en. Hit `/login` → restyled branded card, no shadow, dark-safe, the magic-link form still submits (POST flow works end-to-end with a real allowed email — security unchanged). With B2's session-cookie helper: authenticated `/` shows the §B shell after a brief branded-welcome flash (NOT the legacy dashboard) — confirms the §D.1 auth-loading-flash fix.
- [ ] Both tasks are **RETAINED-REVIEW** → the whole-branch critic does the spec + #418/security pass on §D before the code-quality pass; PR #141 only after the single whole-branch re-review is green.

---

## Self-Review

- **Spec §D.1–§D.4 → task coverage:**

| Spec | Locked content | Task | Status |
|---|---|---|---|
| §D.1 | `UserView` → deterministic branded welcome + `/login` CTA; no IdentityBar/UsageDashboard/$-data; comfortable density; §B.4 motion; i18n | Task D1 Steps 3/5 | ✓ |
| §D.2 | `loginPage()` Kumo-aligned restyle; no `shadow-*`; dark-safe; SSR/no-JS; security flow byte-unchanged; sanctioned local style consts | Task D2 Steps 3/5 | ✓ |
| §D.3 | `UserView` SSR==client (#418); rename+retarget the ONE `hydration.test.tsx` UserView case (`#usage-panel-root`→`#portal-welcome-root`); 10/10; Task-0B/Task-3 cases untouched; serialized after them | Task D1 Steps 6/7 | ✓ |
| §D.4 | after B1/B2; B2 session-cookie helper enables auth-preview verify; folds into single whole-branch re-review/PR #141; D1 hydration-test edit serialized after Task-0B/Task-3 | Prerequisites + Task D1 Step 8 + E2E | ✓ |

- **Placeholder scan:** no TBD/"figure it out". The welcome is fully static (zero dynamic content → trivially #418-safe; no `useHasHydrated`/`SsrSafeSkeleton` NEEDED here, and the spec/plan say so explicitly — they're available if a future dynamic bit is added, but this design has none). The `loginPage()` restyle gives concrete `LOGIN_STYLE` constants + an explicit "diff confined to the string body" hard invariant with the security-suite-stays-green proof. The i18n step reconciles new-vs-existing keys against the live catalogs (e.g. a pre-existing platform-name key is REUSED, not duplicated — the `rg` check is specified). Every test/code block is complete and runnable; exact `bun run test <path>` commands; explicit-path commits.
- **Internal consistency:** `useMe()` has no unauth/auth-loading signal (verified) → single welcome state (§D.1/D2-locked) — consistent across spec+plan. #418 contract grounded in verified `server-impl.tsx`@54-74 (unauth never seeds `ME_QUERY_KEY`) + the real `hydration.test.tsx` harness (the `it` asserts only doctype + `toEqual([])`; the `#usage-panel-root` marker was comment-only — so the case-rename + a §D-gated positive assertion is sufficient and touches nothing else). `loginPage()` is a pure string outside the React tree (verified) → no #418 surface, presentation-only, security suites prove non-regression. The sanctioned local hex is explicitly analogized to the Phase-3 §F.6 `ops-theme` exception (consistent precedent, not a new license to hardcode). Same-file serialization with Task-0B/Task-3 in `hydration.test.tsx` declared in Prerequisites + Task D1 Step 6.
- **Untouched (verified):** Phase-3 §A/§B/§C/§E/§F, Task-0/0B, Task-3 #418 workstream — §D only ADDS the welcome + restyles `loginPage()` and RENAMES+retargets the ONE pre-existing UserView hydration case (Task-0B 7/7 + Task-3 NEW-C-A cases are separate `for` blocks, byte-unchanged). `PortalIndex` branch logic, `useMe`, `server-impl.tsx`, all auth handlers — byte-unchanged.
- **Out-of-bounds check:** spec + plan only; no code/build/test/commit performed; two files written; no second-order scope creep (no new IA/routes/i18n-runtime-for-login/auth-logic).
