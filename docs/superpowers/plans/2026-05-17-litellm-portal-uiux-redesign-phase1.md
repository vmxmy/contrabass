# LiteLLM Portal UI/UX Redesign — Phase 1 (Tenant Portal) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the outward-facing **Tenant Portal** at `/` — a left-nav + tenant-brand-bar shell whose navigation is gated by the Phase-0 `{platformRole, tenantRole, tenantTeamId}` identity, with six screens (Overview, Usage, API Keys, Members & Invites, Budget & Alerts, Billing) wired to the Phase-0 `/api/tenant/*` endpoints, scoped immutably to the caller's own team.

**Architecture:** Evolve within the existing Cloudflare-Worker SSR + React-island + Kumo + TanStack-Router (#135) stack. SSR selects the Tenant Portal shell at `/` based on `resolveIdentity` (Phase 0). Screens reuse existing islands/components (`UsageDashboard`, `member-overlay`, `ApiKeysCard`, `BudgetBadge`) and the Phase-0 `/api/tenant/*` API; new screens (invites, webhook config, billing) are thin Kumo forms/tables. A tenant-branding layer overrides only `--kumo-brand*` CSS vars (semantic/hierarchy/type untouched), contrast-checked, dark-mode safe. Ops Console (`/ops`) + impersonation are **out of scope — Phase 2**.

**Tech Stack:** TypeScript, Cloudflare Workers (SSR), React islands, `@cloudflare/kumo`, TanStack Router (lazy routes), Zod, Lingui i18n (zh-CN/en), Vitest (happy-dom), Storybook, `bun run` toolchain.

---

## Prerequisites (read before Task 1)

- **HARD GATE: PR #138 (Phase 0 backend) MUST be merged into `main` first.** This plan anchors on Phase-0 symbols: `PortalIdentity.tenantRole/tenantTeamId` (`types.ts`, resolved in `role-cache.ts`/`roles.ts`), `/api/tenant/invites|alert-webhook|billing` sub-apps + `requireTenantAdmin` + `tenantTeamOr403` (`routes.ts`), `TenantRoleRecord` (`durable/schemas.ts`). If #138 is not merged, STOP and merge it (it also depends on #136, already merged). Phase-1 *planning* is complete (this doc); Phase-1 *implementation* cannot start until #138 is in `main`.
- Branch off updated `main` after #138 merges: `git checkout main && git pull && git checkout -b feat/litellm-portal-phase1-tenant-portal`.
- Toolchain: tests via `cd /Users/xumingyang/github/contrabass/cloud && bun run test <path>` (NEVER `npx vitest` nor `bun test` — both fail to resolve the env: no happy-dom / no `cloudflare:workers`). Typecheck `bun run typecheck` — the single pre-existing `src/litellm-portal/server.ts → server-impl.tsx --jsx` error is the known baseline; "zero new errors" means no others. Build `bun run build:litellm-portal` (regenerates `app.generated.ts`/`kumo-css.generated.ts`; editing `app.tsx`/islands requires a rebuild before deploy — and the rebuilt `app.generated.ts` must be committed, per repo convention).
- Symbol-anchored references: post-#138 line numbers will shift; anchor by symbol + landmark and `grep`/Read to confirm before editing.
- Commits: `<type>(litellm-portal): <imperative ≤72 chars>`, lowercase, no trailing period, `git -c commit.gpgsign=false`. History is load-bearing (merge, never rebase/squash).
- New user-facing strings: add to `cloud/src/litellm-portal/i18n/messages/zh-CN.ts` AND `.../en.ts` first (Lingui), then reference via the project's existing i18n macro/util (read an existing screen for the exact pattern — do NOT hardcode bilingual literals).
- Known flake: the full 37-file `vitest` run intermittently times out (5s) on `index.test.ts`/`security.test.ts`/`usage-overview-routes.test.ts` SSR tests (happy-dom fetching `http://localhost:3000/kumo.css`). Not a regression — confirm any such failure via an isolated re-run of the affected file(s); CI is the gate (consistent with #134/#135/#136/#138).

Repo root `/Users/xumingyang/github/contrabass`; portal `cloud/src/litellm-portal/`; commands from `cloud/`.

---

## Minimal explicit decision: Owner on `/` in Phase 1

The spec puts the Ops Console (`/ops`) + impersonation in Phase 2. **Phase-1 minimal rule:** at `/`, SSR renders the Tenant Portal shell for everyone authenticated. Navigation/screens are gated by identity:
- `tenantRole === "tenant_admin"` (own team): full Tenant Portal (all 6 screens, write screens enabled).
- `tenantRole === "member"` (own team): Overview/Usage/API Keys only (personal-scoped); Members/Budget/Billing hidden.
- `platformRole === "admin"` **with a `tenantTeamId`**: treated as tenant_admin of that team (superset, consistent with `requireTenantAdmin`).
- `platformRole === "admin"` **without `tenantTeamId`** (pure Owner, no tenant scope): Tenant Portal shows a single non-blocking notice card — "运营控制台将在 Phase 2 提供 / Operations Console arrives in Phase 2" — and a link to the legacy `/manage/*` (still 301-aliased + functional) so Owner ops are not regressed in Phase 1. No global dashboard is added to the Tenant Portal.
- Unknown/`none`: existing auth/login flow unchanged (Phase 0/F1 behavior).

This keeps Phase 1 strictly the outward tenant surface without prematurely building Phase 2, and never regresses Owner capability (legacy `/manage/*` remains reachable until Phase 2 replaces it).

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `cloud/src/litellm-portal/index.ts` (or the SSR entry that selects shells) | Request → which SSR shell | Select Tenant Portal shell at `/` from resolved identity |
| `cloud/src/litellm-portal/tenant-portal/shell.tsx` | Tenant Portal app shell: left nav + brand bar, identity-gated nav | Create |
| `cloud/src/litellm-portal/tenant-portal/routes.tsx` | TanStack route tree for the 6 tenant screens (lazy) | Create |
| `cloud/src/litellm-portal/tenant-portal/screens/overview.tsx` | Overview/Home screen | Create |
| `cloud/src/litellm-portal/tenant-portal/screens/usage.tsx` | Usage screen (wraps `UsageDashboard`, team-pinned) | Create |
| `cloud/src/litellm-portal/tenant-portal/screens/keys.tsx` | API Keys screen (wraps `ApiKeysCard`) | Create |
| `cloud/src/litellm-portal/tenant-portal/screens/members.tsx` | Members & Invites (→ `/api/tenant/invites`) | Create |
| `cloud/src/litellm-portal/tenant-portal/screens/alerts.tsx` | Budget & Alerts webhook config (→ `/api/tenant/alert-webhook`) | Create |
| `cloud/src/litellm-portal/tenant-portal/screens/billing.tsx` | Billing list + download (→ `/api/tenant/billing`) | Create |
| `cloud/src/litellm-portal/tenant-portal/branding.ts` | Tenant brand → `--kumo-brand*` CSS-var overrides + contrast guard | Create |
| `cloud/src/litellm-portal/tenant-portal/hooks.ts` | `@tanstack/react-query` hooks for `/api/tenant/*` | Create |
| `cloud/src/litellm-portal/schemas.ts` | (reuse F1/F2/F3 + P0 schemas) — add only client DTO schemas if a screen needs one not already exported | Modify (minimal) |
| `cloud/src/litellm-portal/routes/legacy/redirects.tsx` | Ensure `/manage/*`,`/admin/*`,`/preferences` 301s coexist with the new `/` shell | Modify |
| `cloud/src/litellm-portal/i18n/messages/{zh-CN,en}.ts` | All new screen copy | Modify |
| `cloud/src/litellm-portal/portal.stories.tsx` (or new `tenant-portal/*.stories.tsx`) | Stories for new screens/shell | Modify/Create |
| Test files colocated per the repo convention (`*.test.tsx` next to component; route/SSR tests in the existing harness) | TDD coverage | Create/Modify |

Decomposition principle: each screen is an independently testable island with a single `/api/tenant/*` data dependency; the shell owns only nav + branding + identity gating.

---

## Task 1: SSR shell selection + Tenant Portal shell + identity-gated nav + legacy redirects

**Files:**
- Modify: SSR entry that picks the rendered shell (confirm: `cloud/src/litellm-portal/index.ts` or `server-impl.tsx` — grep for where the `/` route's root component / `renderPortalSSR` shell is chosen post-#135).
- Create: `cloud/src/litellm-portal/tenant-portal/shell.tsx`, `cloud/src/litellm-portal/tenant-portal/routes.tsx`
- Modify: `cloud/src/litellm-portal/routes/legacy/redirects.tsx`
- Test: `cloud/src/litellm-portal/tenant-portal/shell.test.tsx`, extend the existing SSR/router test harness (`router.test.tsx` / `index.test.ts`)

- [ ] **Step 1: Write the failing test** — `tenant-portal/shell.test.tsx`

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { I18nProvider } from "@lingui/react";
import { i18n } from "../i18n/setup"; // confirm exact i18n test setup used by app.test.tsx
import { TenantPortalShell } from "./shell";

function nav(identity: { platformRole: "admin" | "user" | "none"; tenantRole: "tenant_admin" | "member" | null; tenantTeamId: string | null }) {
  return render(
    <I18nProvider i18n={i18n}>
      <TenantPortalShell identity={identity as never} brand={{ name: "ACME", logoUrl: null, primaryColor: null }}>
        <div>child</div>
      </TenantPortalShell>
    </I18nProvider>,
  );
}

describe("TenantPortalShell nav gating", () => {
  it("tenant_admin sees all six nav items", () => {
    nav({ platformRole: "user", tenantRole: "tenant_admin", tenantTeamId: "t1" });
    for (const label of ["概览", "用量", "API Key", "成员", "预算", "账单"]) {
      expect(screen.getByText(new RegExp(label))).toBeTruthy();
    }
  });
  it("member sees only Overview/Usage/API Keys (no Members/Budget/Billing)", () => {
    nav({ platformRole: "user", tenantRole: "member", tenantTeamId: "t1" });
    expect(screen.queryByText(/成员/)).toBeNull();
    expect(screen.queryByText(/预算/)).toBeNull();
    expect(screen.queryByText(/账单/)).toBeNull();
    expect(screen.getByText(/用量/)).toBeTruthy();
  });
  it("pure Owner (admin, no tenantTeamId) shows the Phase-2 notice + legacy link", () => {
    nav({ platformRole: "admin", tenantRole: null, tenantTeamId: null });
    expect(screen.getByText(/Operations Console arrives in Phase 2|Phase 2/)).toBeTruthy();
    expect(screen.getByText(/\/manage/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `cd /Users/xumingyang/github/contrabass/cloud && bun run test src/litellm-portal/tenant-portal/shell.test.tsx` → FAIL (module not found).

- [ ] **Step 3: Implement `shell.tsx`** — a Kumo left-nav + tenant-brand-bar shell. Props: `identity` (Phase-0 `PortalIdentity`), `brand` ({name, logoUrl, primaryColor}), children. Compute nav items from the Minimal-Decision rule above. Use existing Kumo nav/layout primitives (read `identity-bar.tsx` + `routes/manage/route.lazy.tsx` from #135 for the established Kumo chrome idiom; reuse, don't reinvent). All labels via i18n macro (add keys in Task 9; for now reference keys — Step 5 of Task 9 adds them; to keep this task green, add the six nav keys + the Phase-2 notice key to `i18n/messages/{zh-CN,en}.ts` HERE as part of this task since the shell can't render without them). Render `branding.applyBrandVars(brand)` wrapper (Task 8 provides the real impl; here import a stub `applyBrandVars` that returns `{}` and is fully implemented in Task 8 — declare its signature now: `export function applyBrandVars(b: Brand): React.CSSProperties`). Pure Owner branch renders a Kumo `Banner`/notice card with an i18n message + an `<a href="/manage">` legacy link.

- [ ] **Step 4: Run test to verify it passes** — same command → PASS (3 tests).

- [ ] **Step 5: SSR shell selection + routes + legacy redirects**
  - In the SSR entry, when the resolved identity is authenticated, render `TenantPortalShell` for `/` and the Tenant Portal route tree (`tenant-portal/routes.tsx`, lazy routes mirroring #135's `createRoute`/`*.lazy.tsx` pattern — read `routes/manage/*.lazy.tsx`). Routes: `/` (Overview), `/usage`, `/keys`, `/members`, `/alerts`, `/billing`. Member-hidden routes still register but their loader/component renders a Kumo `Empty`/403-style "无权限" if reached directly (defense-in-depth; server `/api/tenant/*` already enforces via `requireTenantAdmin`).
  - In `routes/legacy/redirects.tsx`: confirm/extend that `/admin/*`, `/manage/*`, `/preferences` still 301 and remain functional (Phase 1 does NOT delete them — Owner + un-migrated links depend on them until Phase 2). Add a test asserting a `/manage/keys` request still 301s (or serves) unchanged.

- [ ] **Step 6: Run** `cd /Users/xumingyang/github/contrabass/cloud && bun run test src/litellm-portal/tenant-portal/shell.test.tsx src/litellm-portal/router.test.tsx src/litellm-portal/index.test.ts && bun run typecheck` → all green; tsc only the server-impl baseline. (If `index.test.ts` flakes on the documented happy-dom timeout, re-run it isolated to confirm.)

- [ ] **Step 7: Commit**
```bash
cd /Users/xumingyang/github/contrabass
git add cloud/src/litellm-portal/tenant-portal cloud/src/litellm-portal/index.ts cloud/src/litellm-portal/routes/legacy/redirects.tsx cloud/src/litellm-portal/i18n/messages
git -c commit.gpgsign=false commit -m "feat(litellm-portal): Tenant Portal shell + identity-gated nav + SSR select"
```

---

## Task 2: `/api/tenant/*` React-Query hooks

**Files:** Create `cloud/src/litellm-portal/tenant-portal/hooks.ts`; Test `cloud/src/litellm-portal/tenant-portal/hooks.test.tsx`

- [ ] **Step 1: Failing test** — assert hooks call the right endpoints and parse with the existing P0/F1 schemas. Mock `fetch`; for each hook assert URL + method + that the response is validated.

```tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useTenantInvites, useTenantWebhook, useTenantBillingPeriods } from "./hooks";

const wrap = () => { const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>; };
const origFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = origFetch; vi.restoreAllMocks(); });

describe("tenant-portal hooks", () => {
  it("useTenantInvites GETs /api/tenant/invites", async () => {
    globalThis.fetch = vi.fn(async (u: RequestInfo | URL) => {
      expect(String(u)).toContain("/api/tenant/invites");
      return new Response(JSON.stringify({ invites: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const { result } = renderHook(() => useTenantInvites(), { wrapper: wrap() });
    await waitFor(() => expect(result.current.data).toEqual({ invites: [] }));
  });
  it("useTenantWebhook GETs /api/tenant/alert-webhook", async () => {
    globalThis.fetch = vi.fn(async (u: RequestInfo | URL) => {
      expect(String(u)).toContain("/api/tenant/alert-webhook");
      return new Response(JSON.stringify({ teamId: "t1", url: null, updatedAt: null }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const { result } = renderHook(() => useTenantWebhook(), { wrapper: wrap() });
    await waitFor(() => expect(result.current.data?.url).toBeNull());
  });
  it("useTenantBillingPeriods GETs /api/tenant/billing", async () => {
    globalThis.fetch = vi.fn(async (u: RequestInfo | URL) => {
      expect(String(u)).toContain("/api/tenant/billing");
      return new Response(JSON.stringify({ periods: ["2026-04"] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const { result } = renderHook(() => useTenantBillingPeriods(), { wrapper: wrap() });
    await waitFor(() => expect(result.current.data?.periods).toEqual(["2026-04"]));
  });
});
```

- [ ] **Step 2: Run → FAIL** (`hooks.ts` missing). `cd /Users/xumingyang/github/contrabass/cloud && bun run test src/litellm-portal/tenant-portal/hooks.test.tsx`

- [ ] **Step 3: Implement `hooks.ts`** — `useTenantInvites()` (GET), `useCreateTenantInvite()` (POST), `useRevokeTenantInvite()` (DELETE `/api/tenant/invites/:email`), `useTenantWebhook()` (GET), `useSetTenantWebhook()` (PUT), `useClearTenantWebhook()` (DELETE), `useTenantBillingPeriods()` (GET `/api/tenant/billing`), `downloadTenantBilling(yearMonth)` (GET `/api/tenant/billing/:yearMonth`, triggers file download). Reuse the project's existing fetch wrapper + the exported Zod result schemas from `schemas.ts` (`AdminInviteListSchema`, `TeamAlertWebhookResultSchema`, etc. — read what P0/F1 export; do NOT redefine). Mutations invalidate the matching query key. Follow the existing `hooks/use-dashboard.tsx`/`use-preferences.tsx` idiom (read them).

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit**
```bash
cd /Users/xumingyang/github/contrabass
git add cloud/src/litellm-portal/tenant-portal/hooks.ts cloud/src/litellm-portal/tenant-portal/hooks.test.tsx
git -c commit.gpgsign=false commit -m "feat(litellm-portal): tenant-portal react-query hooks for /api/tenant/*"
```

---

## Task 3: Usage screen (reuse `UsageDashboard`, team-pinned)

**Files:** Create `tenant-portal/screens/usage.tsx` + `.test.tsx`

- [ ] **Step 1: Failing test** — render `<TenantUsageScreen identity={tenant_admin t1}/>` and assert it renders the existing `UsageDashboard` with scope fixed to the caller's team and **no global/scope toggle** (the personal/global toggle from #135 must be absent here).

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
// reuse the app.test.tsx render-with-i18n+queryclient harness pattern
import { TenantUsageScreen } from "./usage";
describe("TenantUsageScreen", () => {
  it("renders UsageDashboard scoped to the team with no global toggle", () => {
    render(/* harness */ <TenantUsageScreen /> as never);
    expect(screen.queryByText(/全局|Global scope|个人视图|全局管理/)).toBeNull(); // no scope switch
  });
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — thin wrapper that mounts the existing `dashboard/views/usage-dashboard` component with props forcing team scope (read `usage-dashboard.tsx` for its scope prop; pass the tenant-scoped variant; suppress the personal/global tabs). Member variant: personal-scoped. No new chart code — reuse `member-overlay` for drill-down where the existing component supports it.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat(litellm-portal): tenant-portal usage screen (team-pinned UsageDashboard)`

---

## Task 4: API Keys screen (reuse `ApiKeysCard`)

**Files:** Create `tenant-portal/screens/keys.tsx` + `.test.tsx`

- [ ] **Step 1: Failing test** — renders the existing `ApiKeysCard` (with `BudgetBadge` pill, F5) inside the Tenant Portal screen; member sees own keys, tenant_admin sees the same card (server scopes). Assert the budget pill renders for a key with maxBudget.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — import and render `ApiKeysCard` from `app.tsx` (the shared component `/manage/keys` already reuses — confirm export). No logic duplication. Header/section chrome via Kumo to match the shell.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat(litellm-portal): tenant-portal API keys screen (reuse ApiKeysCard)`

---

## Task 5: Members & Invites screen (→ `/api/tenant/invites`)

**Files:** Create `tenant-portal/screens/members.tsx` + `.test.tsx`

- [ ] **Step 1: Failing test** — tenant_admin: renders members/invites table from `useTenantInvites`; "邀请" form POSTs via `useCreateTenantInvite` (email + role); revoke calls `useRevokeTenantInvite`; success invalidates the list. Member: screen not reachable (covered by Task 1 nav gating) — assert the component renders a Kumo `Empty`/forbidden state if mounted directly. Mock the hooks; assert calls + optimistic/refetch behavior + a typed-confirm on revoke (mirror the F1 admin delete confirm UX).

```tsx
// given mocked useTenantInvites→[{email,teamRole,status}], useCreateTenantInvite mutate spy
// when fill email + submit → expect create mutate called with {email, teamRole}
// when click revoke + confirm → expect revoke mutate called with email
// then list query invalidated
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — Kumo `Table` for invites (email, role, status pill, revoke action with `Dialog` typed-confirm mirroring `DeleteKeyButton`/F1 admin delete), Kumo `Dialog`+`Input`+`Select` create-invite form. Use the Task-2 hooks; all copy via i18n keys (added Task 9 or inline-in-this-task per the Task-1 precedent — add the member/invite keys here). Loading/empty/error via Kumo `SkeletonLine`/`Empty`/`Banner` (codebase idiom).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat(litellm-portal): tenant-portal members & invites screen`

---

## Task 6: Budget & Alerts webhook config screen (→ `/api/tenant/alert-webhook`)

**Files:** Create `tenant-portal/screens/alerts.tsx` + `.test.tsx`

- [ ] **Step 1: Failing test** — tenant_admin: shows current webhook (from `useTenantWebhook`), a form to set an https URL, a clear button. The URL input must surface server validation: submitting `http://` or an SSRF target → the screen shows the server's 422 `blocked_host`/`https_required` as an inline Kumo error (the client does NOT reimplement SSRF logic — it trusts/echoes the server P0 `SetTenantAlertWebhookBodySchema` rejection). Assert: set → `useSetTenantWebhook` mutate called with `{reason,url}`; 422 response → inline error rendered; clear → `useClearTenantWebhook` called; success invalidates `useTenantWebhook`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — Kumo `Field`+`Input` (type=url) + reason `Select` (reuse the F1 `WriteReason` presets) + Save/Clear `Button`s; render `data.url`/`updatedAt`/dedupe-cycle note from the GET; on mutation error parse the server JSON `{error}` and show a Kumo `Banner`/field error. No client-side SSRF logic (server is authoritative — document this in a code comment). Copy via i18n.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat(litellm-portal): tenant-portal budget & alert webhook screen`

---

## Task 7: Billing screen (→ `/api/tenant/billing`)

**Files:** Create `tenant-portal/screens/billing.tsx` + `.test.tsx`

- [ ] **Step 1: Failing test** — tenant_admin: lists available periods from `useTenantBillingPeriods`; clicking a period triggers `downloadTenantBilling(yearMonth)` (assert it requests `/api/tenant/billing/2026-04` and initiates a CSV download — mock the download util; assert filename `billing-2026-04.csv` and that the body is whatever the server returns, already team-filtered server-side). Empty periods → Kumo `Empty`. 404 → inline "该月暂无账单".
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — Kumo `Table`/list of periods + download `Button` per row using the Task-2 `downloadTenantBilling`. The client does NOT parse/aggregate the CSV (server already team-filters — comment this invariant). i18n copy.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat(litellm-portal): tenant-portal billing screen`

---

## Task 8: Overview / Home screen

**Files:** Create `tenant-portal/screens/overview.tsx` + `.test.tsx`

- [ ] **Step 1: Failing test** — tenant_admin: renders team identity (brand name), this-cycle spend vs budget ring (reuse the existing budget meter/`Meter` + `BudgetBadge` semantics), alert/webhook status (from `useTenantWebhook` — configured/not), top models + recent activity (reuse the dashboard summary data the existing `useDashboard`/usage source provides, team-scoped). member: personal-scoped variant (own spend/keys, no team budget/webhook). Assert the cycle spend ring + alert status render; member variant hides team-only tiles.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — compose existing KPI tiles / `Meter` / `BudgetBadge` / top-models list (reuse from `app.tsx`/`dashboard/panels` — no new chart code) fed by the existing team-scoped dashboard/usage hook + `useTenantWebhook` for alert status. Member variant gates the team-only tiles. i18n copy.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat(litellm-portal): tenant-portal overview screen`

---

## Task 9: Tenant branding layer (CSS-var override, contrast-guarded, dark-safe)

**Files:** Create `tenant-portal/branding.ts` + `branding.test.ts`; wire into `shell.tsx` (replace the Task-1 stub `applyBrandVars`)

- [ ] **Step 1: Failing test** — `branding.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { applyBrandVars, isAccessibleBrand } from "./branding";
describe("tenant branding", () => {
  it("maps a valid brand color to --kumo-brand* CSS vars only", () => {
    const v = applyBrandVars({ name: "ACME", logoUrl: null, primaryColor: "#1f6feb" }) as Record<string,string>;
    expect(v["--kumo-brand"]).toBe("#1f6feb");
    // does NOT override semantic/hierarchy tokens
    expect(Object.keys(v).every(k => k.startsWith("--kumo-brand"))).toBe(true);
  });
  it("falls back to default brand when color missing or low-contrast (both modes)", () => {
    expect(applyBrandVars({ name: "X", logoUrl: null, primaryColor: null })).toEqual({});
    expect(isAccessibleBrand("#ffffff")).toBe(false); // fails contrast → caller falls back
    expect(isAccessibleBrand("#1f6feb")).toBe(true);
  });
  it("rejects malformed color (no injection)", () => {
    expect(applyBrandVars({ name: "X", logoUrl: null, primaryColor: "red;}<script>" })).toEqual({});
  });
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement `branding.ts`** — `applyBrandVars(brand): React.CSSProperties` returns only `--kumo-brand`/`--kumo-brand-hover` (+ derived) overrides when `primaryColor` is a strict `#rrggbb` (regex-validated — reject anything else, no injection) AND `isAccessibleBrand` passes a WCAG-AA contrast check against both light (`kumo-canvas`) and dark (`data-mode=dark`) surfaces; else `{}` (Kumo default). Never touch semantic/hierarchy/type tokens. Replace the Task-1 stub import in `shell.tsx` with the real impl; the brand bar uses `brand.logoUrl` (validated https or omitted) + `brand.name`.
- [ ] **Step 4: Run → PASS** + re-run `shell.test.tsx` (still green with real branding).
- [ ] **Step 5: Commit** `feat(litellm-portal): tenant branding layer (kumo-brand var override, contrast-guarded)`

---

## Task 10: i18n completeness + Storybook + bundle check

**Files:** Modify `i18n/messages/{zh-CN,en}.ts`; add `tenant-portal/*.stories.tsx` (or extend `portal.stories.tsx`)

- [ ] **Step 1:** Audit every new screen/shell for hardcoded user-facing strings; ensure all keys exist in BOTH `zh-CN.ts` and `en.ts` (Lingui). Add a test asserting no missing key for the new namespace (mirror any existing i18n-completeness test; if none, add a small test importing both catalogs and asserting the new keys are present in each).
- [ ] **Step 2:** Add Storybook stories for the shell (tenant_admin / member / pure-Owner variants) + each screen (loading/empty/loaded/error) with inline fixtures (no network), mirroring the existing `portal.stories.tsx` SBv8 idiom.
- [ ] **Step 3:** `cd /Users/xumingyang/github/contrabass/cloud && bun run build:litellm-portal` — capture the bundle size delta; if the Tenant Portal materially grows the main bundle, ensure the screens are lazy-loaded route chunks (TanStack lazy routes from Task 1) so the entry bundle stays bounded (DESIGN.md bundle guidance). Commit the regenerated `app.generated.ts`/`kumo-css.generated.ts`.
- [ ] **Step 4: Commit** `chore(litellm-portal): tenant-portal i18n + stories + regenerate SPA`

---

## End-to-End Verification

- [ ] **Build → full test → typecheck (correct order: build THEN test):**
```bash
cd /Users/xumingyang/github/contrabass/cloud
bun run typecheck                  # only the server-impl --jsx baseline
bun run build:litellm-portal       # exit 0; commit regenerated app.generated.ts if not already
bun run test src/litellm-portal    # green; the known happy-dom localhost:3000/kumo.css full-suite
                                   # flake rotates across index/security/usage-overview SSR tests —
                                   # if it fires, re-run the affected file(s) ISOLATED to confirm pass:
bun run test src/litellm-portal/tenant-portal \
             src/litellm-portal/router.test.tsx \
             src/litellm-portal/index.test.ts
```
Expected: all Tenant Portal suites green; tsc baseline-only; build exit 0. Full-suite SSR-timeout flake (files this branch didn't touch, pass isolated) is the documented pre-existing condition — CI is the gate.

- [ ] **Behavioral E2E (manual, staging, after #138+P1 merged, deploy via `bun run deploy:litellm-portal`):**
  1. tenant_admin logs in → `/` shows Tenant Portal: all 6 nav items; brand bar shows tenant name/color (if configured) with correct contrast in light+dark.
  2. member logs in → `/` shows only Overview/Usage/API Keys; direct-navigating `/members` shows forbidden state; `/api/tenant/invites` returns 403 (server gate).
  3. pure Owner (admin, no tenantTeamId) → `/` shows the Phase-2 notice + working `/manage` legacy link (Owner ops not regressed).
  4. tenant_admin: send invite (Members) → appears pending → invitee magic-link login → invitee joins team (F1) with tenantRole seeded (P0 Task 6); revoke a pending invite with typed-confirm.
  5. tenant_admin: set alert webhook to an https request-bin → status shows configured; set `http://`/`169.254.169.254` → inline server 422 shown; clear → status cleared.
  6. tenant_admin: Billing → list periods → download a month → CSV contains ONLY this team's rows (P0 server filter); cross-tenant rows absent.
  7. legacy `/admin/*`,`/manage/*`,`/preferences` still 301/functional.

- [ ] **Open the PR (do NOT self-merge — user-locked policy, same as #136/#138):**
```bash
cd /Users/xumingyang/github/contrabass
git push -u origin feat/litellm-portal-phase1-tenant-portal
gh pr create --base main --head feat/litellm-portal-phase1-tenant-portal \
  --title "feat(litellm-portal): Phase 1 — Tenant Portal" \
  --body "Implements Phase 1 of docs/superpowers/specs/2026-05-17-litellm-portal-uiux-redesign-design.md §2: Tenant Portal shell + identity-gated nav + 6 screens on the Phase-0 /api/tenant/* API + tenant branding. Depends on #138 (Phase 0). Ops Console + impersonation = Phase 2. Tests: Tenant Portal suites green; tsc baseline; build clean. Known pre-existing full-suite happy-dom flake documented — CI is the gate. Do not merge without review."
```
Report PR URL + CI status to the user. Do not merge without explicit approval.

---

## Self-Review

**1. Spec coverage (spec §2 Tenant Portal IA + the Minimal Decision):**
- SSR shell at `/` + identity-gated left nav + brand bar → Task 1. ✓
- Overview/Home → Task 8 ✓ · Usage (team-pinned, no global toggle) → Task 3 ✓ · API Keys (reuse ApiKeysCard + budget pill) → Task 4 ✓ · Members & Invites → Task 5 ✓ · Budget & Alerts webhook → Task 6 ✓ · Billing → Task 7 ✓ (all wired to P0 `/api/tenant/*` via Task 2 hooks ✓).
- Tenant branding layer (kumo-brand var override only, contrast + dark, fallback, no injection) → Task 9. ✓
- Legacy `/admin|/manage|/preferences` 301 coexistence (no Owner regression) → Task 1 Step 5. ✓
- i18n zh-CN/en + Storybook + bundle/lazy → Task 10. ✓
- Ops Console / impersonation explicitly **out of scope (Phase 2)** — Minimal Decision documents Owner-on-`/` behavior without building Phase 2. No gap.
- Reuse mandate (UsageDashboard/member-overlay/ApiKeysCard/BudgetBadge/Kumo/#135 lazy routes/SSR-islands) honored across Tasks 3/4/8 and the shell.

**2. Placeholder scan:** Task 1 intentionally adds the shell's i18n keys within Task 1 (documented) rather than deferring — not a hidden TODO. The Task-1 `applyBrandVars` stub is explicitly declared with its final signature and replaced in Task 9 (build-clean: stub returns `{}`, real impl same signature) — documented, not a placeholder. No "TBD"/"add error handling"/uncoded steps. Hooks/screens steps reference exact endpoints + reuse named exported schemas (no undefined symbols). Acceptable.

**3. Type consistency:** `identity` is the Phase-0 `PortalIdentity` `{platformRole?/role, tenantRole: "tenant_admin"|"member"|null, tenantTeamId: string|null}` everywhere (Tasks 1/3/4/8). `Brand = {name:string; logoUrl:string|null; primaryColor:string|null}` consistent in shell + branding (Tasks 1/9). `applyBrandVars(Brand): React.CSSProperties` signature identical in the Task-1 stub and Task-9 impl. Hook names (`useTenantInvites/useCreateTenantInvite/useRevokeTenantInvite/useTenantWebhook/useSetTenantWebhook/useClearTenantWebhook/useTenantBillingPeriods/downloadTenantBilling`) defined in Task 2 and used verbatim in Tasks 5/6/7/8. Endpoints (`/api/tenant/invites|alert-webhook|billing[/:yearMonth]`) match P0. No drift.

> NOTE: tasks reference post-#138 symbols; exact line numbers must be confirmed against `main` after #138 merges. Implementation is gated on that merge (see Prerequisites). This plan completes Phase-1 *planning*; Phase-1 *execution* begins once #138 is in `main`.
