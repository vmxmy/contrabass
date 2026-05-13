## 1. Admin status header

- [ ] 1.1 Add a `AdminStatusHeader` component placed above metric cards in the admin overview.
- [ ] 1.2 Badges: `read-only`, `admin-only access`, `data freshness` (e.g. "缓存 30s 内").
- [ ] 1.3 Health summary one-liner derived from `AdminSummary`: e.g. "1 团队超预算，5 用户接近阈值" / "系统正常".

## 2. Hero metrics

- [ ] 2.1 Add budget progress + remaining budget to the global spend hero tile (`AdminHeroStats`).
- [ ] 2.2 Risk status: badge color is `success` when risk count is 0; `warning` for moderate; `danger` for severe (driven by data, not constant).
- [ ] 2.3 Resource coverage tile expresses users / teams / unassigned users explicitly, not raw counts.

## 3. Global usage layout

- [ ] 3.1 Remove `Brush native` label from chart toolbar (and any other implementation-leak strings).
- [ ] 3.2 Reorder `AdminGlobalUsage` into: filters → KPIs → chart → Top Models panel → collapsed bucket table.
- [ ] 3.3 New `TopModelsPanel` (rank + share + spend) replacing the inline ranking.
- [ ] 3.4 Bucket table is collapsed by default; expansion is controlled by a `<Collapsible />` with explicit label.

## 4. Tables

- [ ] 4.1 `AdminUsersTable` first column: an `AccountCell` showing email when present, else `userId`, else "(unknown)".
- [ ] 4.2 `AdminUsersTable` role column: kumo `Badge` mapping admin / user / unmanaged.
- [ ] 4.3 `AdminTeamsTable` models column: chip list with `+N more` overflow and tooltip listing the rest.

## 5. Row actions

- [ ] 5.1 Audit every visible `查看详情` / `查看` / `详情` row action; remove or wire to:
  - `/admin/users/:userId`
  - `/admin/teams/:teamId`
  - `/admin/audit/:eventId`
- [ ] 5.2 If a detail route does not yet have meaningful content, the action MUST NOT be displayed.

## 6. Audit empty / detail state

- [ ] 6.1 Replace bare `暂无审计日志` empty-state text with explanatory copy ("尚未记录管理员操作，admin 写操作开启后此处会出现条目").
- [ ] 6.2 Audit detail row (`/admin/audit/:eventId`): render fields as a definition list (actor / action / target / IP / 时间 / reason) above the raw JSON.

## 7. Tests

- [ ] 7.1 Unit: `AdminStatusHeader` derives summary correctly across "healthy" / "risk" / "limited" data.
- [ ] 7.2 Unit: `AccountCell` fallback hierarchy.
- [ ] 7.3 Unit: `TopModelsPanel` rank + share + spend display.
- [ ] 7.4 Unit: bucket table collapsed-by-default + expandable.
- [ ] 7.5 Existing admin component tests stay green or are updated to the new layout.
- [ ] 7.6 a11y: `expectNoAxe()` passes for refactored admin views (sidebar, users, teams, audit, usage).

## 8. Bundle gate

- [ ] 8.1 `node scripts/build-litellm-portal-app.mjs` succeeds with admin chunk ≤ 80KB gzip (existing CB-13 budget).
- [ ] 8.2 No new top-level lazy chunks introduced that would push the user main chunk over 100KB gzip.

## 9. Verification

- [ ] 9.1 `cd cloud && node_modules/.bin/vitest run src/litellm-portal` — all pass.
- [ ] 9.2 Browser smoke-check: `/admin`, `/admin/users`, `/admin/teams`, `/admin/audit`, `/admin/usage`, `/admin/audit/:eventId` (with at least one event).
- [ ] 9.3 Visual: no `Brush native` / implementation-language labels visible anywhere.
