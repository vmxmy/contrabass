## ADDED Requirements

### Requirement: Cron-driven polling
The system SHALL run tracker polling on a Cloudflare Cron Trigger that fires every minute by default (configurable per team via `cloud-config-store`). Each invocation SHALL iterate over all enabled teams and poll each enabled tracker (Linear, GitHub, Internal Board) once.

#### Scenario: Cron fires and polls every enabled team
- **WHEN** the Cron trigger fires
- **THEN** the poller Worker enumerates teams with `tracker.enabled: true` and calls each configured tracker adapter once per team

#### Scenario: Team disables polling
- **WHEN** a team config sets `tracker.enabled: false`
- **THEN** subsequent Cron invocations skip that team

### Requirement: Linear adapter
The poller SHALL include a Linear adapter that authenticates with the team's Linear API token (loaded from Cloudflare Secrets Store), executes the team's saved GraphQL query for assigned/triaged issues, normalizes results to the cloud's internal issue shape, and posts new or updated issues to the team's `TeamCoordinator` DO.

#### Scenario: New Linear issue appears
- **WHEN** the Linear adapter sees an issue not present in the prior poll's snapshot
- **THEN** it posts the issue to the `TeamCoordinator` DO which adds it to the board with `phase: open`

#### Scenario: Linear API rate-limits the poller
- **WHEN** Linear responds with `429`
- **THEN** the adapter respects the `Retry-After` header, increments a per-team backoff counter, and skips the team for the indicated interval

### Requirement: GitHub Issues adapter
The poller SHALL include a GitHub Issues adapter that authenticates with the team's GitHub PAT or installation token (Secrets Store), polls the configured repos/labels/assignees, normalizes results to the cloud's issue shape, and posts new or updated issues to the team's `TeamCoordinator` DO.

#### Scenario: Issue gains a tracked label
- **WHEN** an issue gains a label that matches the team's GitHub config filter
- **THEN** the adapter posts it to the `TeamCoordinator` DO

#### Scenario: GitHub PAT is invalid
- **WHEN** the GitHub API responds `401`
- **THEN** the adapter writes a structured error event to the team's audit log and skips that team until secrets are refreshed; it SHALL NOT silently retry indefinitely

### Requirement: Internal Board adapter (D1-backed)
The poller SHALL include an Internal Board adapter that reads from a D1 table representing the cloud-hosted internal board. The schema SHALL preserve the field set documented in `docs/local-board.md` (id, title, body, labels, status, priority, assignee, blockers, created/updated timestamps). The adapter SHALL post new or updated entries to the team's `TeamCoordinator` DO.

#### Scenario: New entry written to the cloud internal board
- **WHEN** a row is inserted into the D1 internal board for a team
- **THEN** the next poll cycle posts it to that team's `TeamCoordinator` DO

#### Scenario: Internal board entry blocker becomes resolved
- **WHEN** a row's `blockers` field changes from non-empty to empty
- **THEN** the poller posts an update so the `TeamCoordinator` can re-evaluate dispatch eligibility

### Requirement: Tracker secret isolation
Tracker tokens SHALL live exclusively in Cloudflare Secrets Store, bound only to the tracker poller Worker. The API Worker, the DOs, and the developer's `contrabass worker` SHALL NOT have access to tracker tokens.

#### Scenario: API Worker attempts to read a tracker secret
- **WHEN** any non-poller Worker attempts to read a tracker secret binding
- **THEN** the binding is undefined for that Worker (enforced by `wrangler.toml` configuration), causing a clear runtime error if accessed

### Requirement: Per-team isolation in failure
Failures (network, auth, parse) for one team SHALL NOT prevent the poller from processing other teams in the same Cron invocation. Each team's adapter calls SHALL be wrapped in independent error boundaries with structured error logging.

#### Scenario: One team's tracker fails, others succeed
- **WHEN** team A's Linear API call throws and team B's call succeeds
- **THEN** team B's issues are posted to its `TeamCoordinator` and team A's failure is logged with `teamId: A` to observability

### Requirement: Idempotent issue updates
The adapters SHALL include a stable `external_id` (e.g., Linear issue UUID, GitHub `owner/repo#123`, internal board row id) on every posted issue, and the `TeamCoordinator` SHALL upsert by `external_id` rather than create duplicates.

#### Scenario: Cron re-polls and sees the same issue
- **WHEN** the second Cron invocation reports the same issue with no changes
- **THEN** the `TeamCoordinator` recognizes the `external_id` and performs no board change

#### Scenario: Cron sees the same issue with a status change
- **WHEN** the issue's normalized fields differ from the stored entry
- **THEN** the `TeamCoordinator` updates the existing board entry and broadcasts `board-update`

### Requirement: Polling observability
The poller SHALL emit per-team, per-adapter metrics on every invocation: poll duration, issues seen, issues new, issues updated, errors. Metrics SHALL be written to Workers Analytics Engine and queryable from the dashboard.

#### Scenario: Operator inspects polling health
- **WHEN** an operator opens the team's "Tracker Health" dashboard panel
- **THEN** the panel shows the last 24h of poll duration, success rate, and last error per adapter
