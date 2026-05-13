## 1. Admin status header

- [x] 1.1 Add a `AdminStatusHeader` component placed above metric cards in the admin overview.
- [x] 1.2 Badges: `read-only`, `admin-only access`, `data freshness` (e.g. "缓存 30s 内").
- [x] 1.3 Health summary one-liner derived from `AdminSummary`: e.g. "1 团队超预算，5 用户接近阈值" / "系统正常".

## 2. Hero metrics

- [x] 2.1 Add budget progress + remaining budget to the global spend hero tile (`AdminHeroStats`).
- [x] 2.2 Risk status: badge color is `success` when risk count is 0; `warning` for moderate; `danger` for severe (driven by data, not constant).
- [x] 2.3 Resource coverage tile expresses users / teams / unassigned users explicitly, not raw counts.

## 3. Global usage layout

- [x] 3.1 Remove `Brush native` label from chart toolbar (and any other implementation-leak strings).
- [x] 3.2 Reorder `AdminGlobalUsage` into: filters → KPIs → chart → Top Models panel → collapsed bucket table.
- [x] 3.3 New `TopModelsPanel` (rank + share + spend) replacing the inline ranking.
- [x] 3.4 Bucket table is collapsed by default; expansion is controlled by a `<Collapsible />` with explicit label.

## 4. Tables

- [x] 4.1 `AdminUsersTable` first column: an `AccountCell` showing email when present, else `userId`, else "(unknown)".
- [x] 4.2 `AdminUsersTable` role column: kumo `Badge` mapping admin / user / unmanaged.
- [x] 4.3 `AdminTeamsTable` models column: chip list with `+N more` overflow and tooltip listing the rest.

## 5. Row actions

- [x] 5.1 Audited every visible `查看详情` / `查看` / `详情` row action; removed all fake DropdownMenu row actions from `AdminUsersTable`, `AdminTeamsTable`, and `AdminAuditFeed` (no working detail page is wired yet).
- [x] 5.2 No empty-handler row action remains rendered.

## 6. Audit empty / detail state

- [x] 6.1 Replace bare `暂无审计日志` empty-state text with explanatory copy ("尚未记录管理员操作，admin 写操作开启后此处会出现条目").
- [x] 6.2 Expanded audit row in `AdminAuditFeed` renders fields as a labeled definition list (actor / action / target / IP / 时间 / reason) above the raw JSON. (`/admin/audit/:eventId` standalone detail route remains the existing placeholder; full detail page deferred to a follow-up.)

## 7. Tests

- [x] 7.1 Unit: `AdminStatusHeader` derives summary correctly across "healthy" / "risk" / "limited" data.
- [x] 7.2 Unit: `AccountCell` fallback hierarchy.
- [x] 7.3 Unit: `TopModelsPanel` rank + share + spend display.
- [x] 7.4 Unit: bucket table collapsed-by-default + expandable.
- [x] 7.5 Existing admin component tests stay green; updated 3 dropdown-related tests to match the removed actions.
- [x] 7.6 a11y: `expectNoAxe()` passes on the new components.

## 8. Bundle gate

- [x] 8.1 `node scripts/build-litellm-portal-app.mjs` succeeds; admin chunk **8.7 KB gzip** (≤ 80 KB).
- [x] 8.2 User main chunk **4.6 KB gzip** (≤ 100 KB).

## 9. Verification

- [x] 9.1 `cd cloud && node_modules/.bin/vitest run src/litellm-portal` — 206 / 206 passed across 11 files.
- [ ] 9.2 Browser smoke-check (post-merge, owner): `/admin`, `/admin/users`, `/admin/teams`, `/admin/audit`, `/admin/usage`, `/admin/audit/:eventId`.
- [ ] 9.3 Visual (post-merge, owner): confirm no `Brush native` / implementation-language labels visible anywhere.
