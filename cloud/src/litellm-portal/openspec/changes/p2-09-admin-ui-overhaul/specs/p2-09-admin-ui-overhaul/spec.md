## ADDED Requirements

### Requirement: Admin landing page surfaces a health summary
The admin landing page SHALL display a one-line summary indicating overall system health before any metric cards or tables.

#### Scenario: All clear
- **WHEN** the admin summary reports zero risk, no over-budget teams, and no over-budget users
- **THEN** the status header MUST show a success-toned "系统正常" summary line
- **AND** a read-only badge MUST be visible
- **AND** an admin-only access badge MUST be visible

#### Scenario: Risk present
- **WHEN** the admin summary reports at least one over-budget team or user
- **THEN** the status header MUST show a warning-toned summary that names the count of risky teams/users
- **AND** the risk badge MUST NOT be success-colored

### Requirement: Admin user table uses durable account cell
The admin user table SHALL show every row's identity through a fallback hierarchy: email → user_id → "(unknown)".

#### Scenario: Email present
- **WHEN** the user row has a non-empty email
- **THEN** the first column MUST show the email
- **AND** `userId` MAY be shown as a secondary label

#### Scenario: Email missing, userId present
- **WHEN** the user row has no email but has a `userId`
- **THEN** the first column MUST show the `userId`
- **AND** an indication that email is missing MUST be visible (badge or muted hint)

#### Scenario: Both missing
- **WHEN** neither email nor userId is present
- **THEN** the cell MUST show "(unknown)" without rendering "—"

### Requirement: Top Models panel separates ranking from the chart
Global admin usage SHALL render the top models in a dedicated panel that is visually distinct from the time-series chart.

#### Scenario: Panel content
- **WHEN** the global usage data contains model totals
- **THEN** the Top Models panel MUST list each model with rank, share, and spend
- **AND** the legacy inline ranking inside the chart card MUST NOT appear

## MODIFIED Requirements

### Requirement: Global admin usage avoids implementation-language labels
Strings shown to admins MUST NOT expose implementation details such as `Brush native`.

#### Scenario: Chart toolbar
- **WHEN** the chart renders with a brush/zoom control
- **THEN** the visible labels MUST use user-facing language (e.g. "选择时间段") or omit the label entirely
- **AND** the literal string "Brush native" MUST NOT appear in the rendered DOM

### Requirement: Bucket table is collapsed by default
The bucket-by-time table on the global usage page SHALL be hidden behind a collapsible control.

#### Scenario: First paint
- **WHEN** the global usage page loads with default data
- **THEN** the bucket table MUST NOT be visible by default
- **AND** the chart MUST occupy the primary visual area
- **AND** a labeled toggle MUST allow the admin to expand the bucket table

### Requirement: Admin row actions either work or are absent
Every visible row action button SHALL navigate to a working detail route. Actions with empty handlers MUST be removed.

#### Scenario: User row "查看详情"
- **WHEN** a user row exposes a 查看详情 action
- **THEN** clicking it MUST navigate to `/admin/users/:userId`

#### Scenario: Team row "查看详情"
- **WHEN** a team row exposes a 查看详情 action
- **THEN** clicking it MUST navigate to `/admin/teams/:teamId`

#### Scenario: Audit row "查看详情"
- **WHEN** an audit row exposes a 查看详情 action
- **THEN** clicking it MUST navigate to `/admin/audit/:eventId`

### Requirement: Admin audit empty state explains the cause
When the audit log has no events, the empty state SHALL explain what "no logs" means and not just show "暂无审计日志".

#### Scenario: Audit log empty
- **WHEN** the audit list is empty
- **THEN** the empty-state region MUST include a sentence describing when entries appear (e.g. after admin write operations land)
- **AND** the bare string "暂无审计日志" alone MUST NOT be the only content

## Constraints

- No new bindings, KV namespaces, Durable Objects, queues, or secrets.
- No `wrangler.litellm-portal.toml` changes.
- Existing admin role guard and CB-16 feature-flagged write endpoints remain unchanged in behavior.
- Admin chunk gzip size MUST remain ≤ 80KB (CB-13 budget).
- a11y axe checks MUST continue to pass for refactored admin views.
