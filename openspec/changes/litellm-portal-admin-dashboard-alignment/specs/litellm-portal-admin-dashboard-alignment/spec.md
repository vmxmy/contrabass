## ADDED Requirements

### Requirement: Admin and personal dashboard tabs share one mental model
The LiteLLM portal SHALL label the personal dashboard and admin dashboard with persona-oriented names and SHALL keep admins on the personal dashboard by default unless a global-management hash is explicitly selected.

#### Scenario: Admin opens portal without a hash
- **WHEN** an admin opens the portal without `#admin`
- **THEN** the visible tab MUST be `个人视图`
- **AND** the admin panel MUST remain hidden until selected

#### Scenario: Admin opens global management directly
- **WHEN** an admin opens the portal with `#admin`
- **THEN** the visible tab MUST be `全局管理`
- **AND** the personal panel MUST be hidden

### Requirement: Admin summary endpoint exposes bounded global metrics
The LiteLLM portal SHALL expose a read-only `/api/admin/summary` endpoint behind the admin role gate for global dashboard hero metrics.

#### Scenario: Admin requests global summary
- **WHEN** an admin requests `/api/admin/summary`
- **THEN** the response MUST include user count, team count, admin count, unmanaged role count, spend, budget, sampled/limited state, and risk count fields

#### Scenario: Non-admin requests global summary
- **WHEN** a non-admin requests `/api/admin/summary`
- **THEN** the response MUST be rejected with `admin_required`

### Requirement: Admin dashboard starts with overview then trend
The admin dashboard SHALL place a global overview section before management tables and global usage trend before detailed resources.

#### Scenario: Admin dashboard renders
- **WHEN** the admin panel is visible
- **THEN** global summary cards MUST render before account/team/audit tables
- **AND** the global usage trend card MUST use the same Kumo visual language as the personal usage card

### Requirement: Admin usage controls match personal usage controls
The admin global usage panel SHALL use the same one-click time preset and automatic/manual grain interaction model as the personal usage panel.

#### Scenario: Admin selects a preset
- **WHEN** an admin clicks a time preset in global usage
- **THEN** the request to `/api/admin/usage/timeseries` MUST use a supported `grain` and `window` pair

#### Scenario: Admin selects chart range
- **WHEN** Kumo Chart emits a range change in global usage
- **THEN** the panel MUST snap to a supported preset when possible and preserve the bounded request contract

#### Scenario: Admin reviews bucket details
- **WHEN** global usage data loads
- **THEN** the panel MUST show summary tiles, chart, recent bucket table, and top model breakdown

### Requirement: Admin resource and audit sections remain read-only but more scannable
The admin dashboard SHALL group detailed account/team resources separately from audit/risk evidence while preserving read-only operations.

#### Scenario: Admin reviews resources
- **WHEN** users and teams load
- **THEN** they MUST appear under a resource/access section with consistent card and table treatment

#### Scenario: Admin reviews audit evidence
- **WHEN** audit events load
- **THEN** they MUST appear under an audit/risk section after usage and resource context
