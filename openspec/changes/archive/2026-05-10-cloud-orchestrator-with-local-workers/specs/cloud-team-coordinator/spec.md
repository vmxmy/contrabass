## ADDED Requirements

### Requirement: One Durable Object per team
The system SHALL provision exactly one `TeamCoordinator` Durable Object instance per team, addressed by `idFromName(teamId)`. All board mutations, worker registry mutations, and dashboard fan-out for a team SHALL go through that single DO instance.

#### Scenario: First request for a team materializes the DO
- **WHEN** the API Worker forwards a request for a team that has never been used
- **THEN** the Workers runtime instantiates a new `TeamCoordinator` DO bound to `idFromName(teamId)` and routes the request to it

#### Scenario: Concurrent requests serialize on the team DO
- **WHEN** two API Worker invocations forward writes for the same team within the same millisecond
- **THEN** the DO processes them serially and the second request observes the first request's effects

### Requirement: Worker registry
The `TeamCoordinator` DO SHALL maintain an in-memory and DO-storage-backed registry of currently-registered workers for the team, keyed by `workerId`, holding `{capabilities[], maxConcurrency, currentLoad, lastHeartbeatTs, kind, version, status}` where `kind` is one of `local | container` and `status` is one of `idle | busy | unhealthy`.

#### Scenario: Worker registers and appears in registry
- **WHEN** a worker completes registration
- **THEN** the registry contains an entry for that `workerId` with `status: idle` and `currentLoad: 0`

#### Scenario: Worker becomes unhealthy after missed registry heartbeats
- **WHEN** the registry has not received a registry-level keepalive from a worker for 3× the heartbeat interval
- **THEN** the entry's `status` transitions to `unhealthy` and the worker is excluded from new dispatch candidates

### Requirement: Task board state
The `TeamCoordinator` DO SHALL persist the team's task board (open / claimed / running / done lists) in DO storage and SHALL expose `GET /board` and `POST /board/refresh` operations callable by the API Worker. The board SHALL include each entry's `issueRef`, `runId` (if active), `assignedWorkerId` (if any), `phase`, and `lastUpdated`.

#### Scenario: Dashboard fetches the board
- **WHEN** the dashboard calls `GET /v1/teams/{teamId}/board`
- **THEN** the API Worker forwards the request to the `TeamCoordinator` DO and returns the current board snapshot

#### Scenario: New issue arrives from tracker poller
- **WHEN** the cloud tracker poller posts a new issue for the team
- **THEN** the `TeamCoordinator` adds an entry with `phase: open` and broadcasts a `board-update` frame to subscribed dashboards

### Requirement: Dispatch routing
The `TeamCoordinator` DO SHALL select a target worker for any queued run by filtering registry entries with `status: idle` (or `status: busy` and `currentLoad < maxConcurrency`), matching declared `capabilities` against run requirements, and applying the team's selection policy (default: prefer `kind: local` over `kind: container` when both are available, otherwise least-loaded).

#### Scenario: Dispatch goes to the only matching local worker
- **WHEN** one local worker is idle and matches required capabilities
- **THEN** the DO selects that worker and forwards the dispatch frame

#### Scenario: No matching worker available
- **WHEN** no registered worker matches required capabilities
- **THEN** the run remains `queued`, the DO emits a `no-worker-available` event, and dispatch is retried on the next registry change

### Requirement: WebSocket fan-out for dashboard subscribers
The `TeamCoordinator` DO SHALL accept WebSocket upgrades on `/subscribe` from authenticated dashboard clients and SHALL broadcast `board-update`, `run-event`, `worker-status`, and `config-changed` frames to all subscribers. The DO SHOULD use the WebSocket Hibernation API to avoid per-connection compute cost on idle dashboards.

#### Scenario: Dashboard subscribes and receives a run event
- **WHEN** a dashboard connects to `/subscribe` and a worker subsequently posts a `phase` event for an active run
- **THEN** the dashboard receives a `run-event` WS frame with the run identifier and event payload

#### Scenario: Dashboard reconnects after network blip
- **WHEN** a dashboard's WS drops and reconnects within 30 seconds with `last_event_id`
- **THEN** the DO replays missed events from the in-memory ring buffer (size: last 100 events per team)

### Requirement: Manual operator actions
The `TeamCoordinator` DO SHALL accept operator-initiated actions from the API Worker — `reassign-run`, `cancel-run`, `pause-team`, `resume-team` — and SHALL coordinate with the relevant `IssueRun` DO when the action affects an active run.

#### Scenario: Operator reassigns a run from the dashboard
- **WHEN** the API Worker forwards `POST /board/reassign-run` with `{runId, targetWorkerId}`
- **THEN** the `TeamCoordinator` calls the `IssueRun` DO to revoke the current lease and dispatches the run to `targetWorkerId`

#### Scenario: Operator pauses the team
- **WHEN** the API Worker forwards `POST /board/pause`
- **THEN** the `TeamCoordinator` stops dispatching queued runs while leaving in-flight runs to complete; new tracker-poller arrivals queue normally

### Requirement: Per-team usage caps
The `TeamCoordinator` DO SHALL enforce per-team usage caps configured in the team config (`max_active_workers`, `max_runs_per_day`, `max_events_per_day`) and SHALL reject registration or dispatch with structured errors when caps are exceeded.

#### Scenario: Worker registration exceeds active worker cap
- **WHEN** a worker tries to register and the team already has `max_active_workers` registered
- **THEN** registration responds with `429` and body `{ "error": "team_worker_cap_exceeded", "max_active_workers": <n> }`
