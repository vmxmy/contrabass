## Why

Local UI review on 2026-05-13 of the `/admin` global management page surfaced usability and information-architecture issues that landed after the CB-2..15 modernization but before any read-only-experience polish pass:

- First screen has many metrics and tables but no top-line indicator of whether the system is healthy, over budget, or needs attention.
- Global usage compresses filters, summary cards, the chart, model ranking, and the bucket table into one heavy card.
- Tables fall back to `—` for empty fields (notably user email), making rows hard to identify.
- Several row actions show 查看详情 buttons with empty handlers, creating fake interactions.
- Implementation-language strings (e.g. `Brush native`) leak into the user surface.

Scope is read-only admin dashboard UI / information architecture. No data API change required for the first pass.

## What Changes

- **Admin status header**: a one-line health summary above the metric cards, with badges for read-only mode, admin-only access, and cache/data freshness.
- **Hero metrics**: add budget progress / remaining budget to global spend; make risk status `success` when risk count is 0 and `warning`/`danger` only when needed; express resource coverage as users/teams/unassigned users.
- **Global usage layout**: remove `Brush native`; keep filters and key totals at top; promote the chart to the main visual; move model ranking into a dedicated **Top Models** panel with rank and share; collapse the bucket table by default.
- **Tables**: change the user-table first column to an account cell with email + `userId` fallback; render `role` as a badge; shorten team model lists into chips with `+N` overflow and tooltip.
- **Row actions**: either remove fake `查看详情` actions or wire them to the existing routes `/admin/users/:userId`, `/admin/teams/:teamId`, `/admin/audit/:eventId`.
- **Audit empty/detail state**: replace bare `暂无审计日志` with explanatory copy; render expanded audit rows as labeled fields above raw JSON.

## Capabilities

### New Capabilities
- **admin-status-header**: top-of-page health badges describing mode/coverage/data freshness.
- **admin-table-account-cell**: durable identity rendering with fallback hierarchy email → userId → "(unknown)".

### Modified Capabilities
- **admin-overview**: hero metrics show budget progress and resource coverage; risk badge color tracks actual risk count.
- **admin-global-usage**: layout split into filters / KPIs / chart / Top Models / collapsed bucket table; no implementation labels exposed.
- **admin-users/teams/audit tables**: weak fallbacks replaced; team models use chip+overflow; `查看详情` wired to detail routes or removed.
- **admin-audit-empty/detail**: empty-state copy and labeled-field detail rendering.

## Impact

- **Modified**: `cloud/src/litellm-portal/app.tsx` (AdminHeroStats, AdminUsersTable, AdminTeamsTable, AdminGlobalUsage, AdminAuditFeed, AdminSection), `cloud/src/litellm-portal/admin-components.tsx` (extracted admin views), `cloud/src/litellm-portal/chart.tsx` (UsageChart removes Brush native exposure), `cloud/src/litellm-portal/routes/__root.tsx` (admin shell/header), admin sub-route detail pages where needed.
- **No new bindings, no new data API surface.** Existing admin GETs supply everything the new UI shows.
- **No wrangler.toml change.** No DO / KV / Cron / Secret additions.
- **Read-only behavior preserved.** Existing admin role guard and CB-16 feature-flagged write endpoints remain unchanged. CB-16 row actions (disable key, change team limits) MUST continue to work where already wired.
- **Tests**: unit tests for new presentation components (status header, account cell, top-models panel, collapsible bucket table); existing admin component tests updated for the new layout where they regress.
- **a11y**: keep `expectNoAxe()` passing for refactored admin views.
- **Bundle**: admin chunk size budget (CB-13) of 80KB gzip must continue to pass.
