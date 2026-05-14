## ADDED Requirements

### Requirement: Durable Objects are the single source of truth for team/user/role/budget
The system SHALL treat Durable Objects as the authoritative store for team metadata, user records, role assignments, and budget/limit configuration, with LiteLLM as a downstream materialization target.

#### Scenario: Admin write commits to DO before responding
- **WHEN** an admin submits a write to a protected admin endpoint (team update, user update, key disable, key delete, key create)
- **THEN** the server MUST commit the change to the corresponding DO BEFORE returning the response
- **AND** the response MUST NOT be 200 unless the DO commit succeeded
- **AND** the server MUST NOT depend on a successful LiteLLM call for the response

#### Scenario: Admin read serves DO data
- **WHEN** an admin reads any team/user/role/budget surface via `/api/admin/*`
- **THEN** the server MUST source the response from `IndexDO` and/or `TeamConfigDO`
- **AND** the server MUST NOT call LiteLLM admin endpoints to satisfy the read

### Requirement: DO partitioning uses per-team `TeamConfigDO` plus singleton `IndexDO`
The system SHALL partition DO storage as one Durable Object per team plus one singleton index Durable Object.

#### Scenario: Per-team DO holds team-local state
- **WHEN** the system needs team metadata, members, keys, spend snapshot, or sync metadata for a specific team
- **THEN** the system MUST access the `TeamConfigDO` whose id is derived from the team's id
- **AND** the system MUST NOT store team-local state in `IndexDO`

#### Scenario: IndexDO holds cross-team indexes
- **WHEN** the system needs to resolve an email to a user, a user to a team, or list all teams
- **THEN** the system MUST consult `IndexDO`
- **AND** `IndexDO` MUST NOT serve as a backup copy of per-team state

### Requirement: DO mirrors spend snapshots with bounded staleness
The system SHALL maintain a `spend:current` snapshot on each `TeamConfigDO` that is refreshed at least once per minute from LiteLLM.

#### Scenario: Spend snapshot present and fresh
- **WHEN** the admin UI reads spend for a team
- **THEN** the server MUST return the value from `TeamConfigDO.spend:current`
- **AND** the value MUST carry a timestamp no more than 60 seconds old under normal operation
- **AND** the server MUST NOT call LiteLLM live to satisfy the read

#### Scenario: Spend mirror cron failure for one team
- **WHEN** the scheduled spend mirror fails for a specific team
- **THEN** the system MUST continue processing the remaining teams
- **AND** the failing team's `TeamConfigDO` MUST record `meta:lastSpendError`
- **AND** the previously stored `spend:current` MUST remain available to readers

### Requirement: DO writes carry sync metadata
The system SHALL maintain per-row `meta:lastSyncedAt`, `meta:lastSyncError`, and `meta:dirty` so operators can observe drift between DO and LiteLLM.

#### Scenario: Dirty row exposed in admin payload
- **WHEN** an admin reads a team/user/key payload that has a non-empty `meta:lastSyncError` or `meta:dirty=true`
- **THEN** the response MUST include the `lastSyncError` and `lastSyncedAt` fields
- **AND** the UI MUST render a "sync pending" or "sync failed" badge for that row

#### Scenario: Successful sync clears dirty flag
- **WHEN** the queue consumer reports successful LiteLLM materialization for a row
- **THEN** the row's `meta:lastSyncedAt` MUST advance to the time of success
- **AND** `meta:lastSyncError` MUST be cleared
- **AND** `meta:dirty` MUST be set to `false`

### Requirement: New users without a team are visible but constrained
The system SHALL create new `UserRecord`s with `role = user` and `teamId = null` when an allow-listed email logs in for the first time, and SHALL render an explicit "awaiting team assignment" experience.

#### Scenario: First-time login of a previously unknown user
- **WHEN** an allow-listed email completes `/magic-callback` for the first time
- **AND** the email is not present in `BOOTSTRAP_ADMIN_EMAILS`
- **THEN** the server MUST upsert the `UserRecord` with `role = user` and `teamId = null`
- **AND** the portal home MUST render an "awaiting team assignment" empty state until an admin attaches a team
