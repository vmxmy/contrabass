## ADDED Requirements

### Requirement: Versioned protocol identity
The system SHALL expose a single `protocol_version` string (semantic versioning, starting at `1.0.0`) on every request, response, and WebSocket frame between cloud and worker. Cloud SHALL refuse any worker that advertises an incompatible major version with a structured error and SHALL NOT mutate v1 frame shapes after this change is archived.

#### Scenario: Worker advertises supported protocol versions on register
- **WHEN** a worker calls `POST /v1/workers/register` with body field `supported_protocol_versions: ["1.0.0"]`
- **THEN** cloud responds with `200` and selects `protocol_version: "1.0.0"` for the session

#### Scenario: Worker advertises an incompatible major version
- **WHEN** a worker registers with `supported_protocol_versions: ["2.0.0"]` and cloud only supports `1.x`
- **THEN** cloud responds with `409` and body `{ "error": "protocol_version_unsupported", "supported": ["1.0.0"] }`

### Requirement: Worker registration and session bootstrap
The system SHALL accept worker registration via `POST /v1/workers/register` taking `{teamId, workerId, capabilities[], maxConcurrency, version, supported_protocol_versions[]}` and SHALL respond with `{sessionToken, refreshToken, dispatchChannel, heartbeatIntervalSec, leaseSec}`. The `sessionToken` SHALL be a short-lived bearer (≤ 1 hour) usable on subsequent REST calls and the WebSocket upgrade.

#### Scenario: Successful registration
- **WHEN** an authenticated worker posts a valid registration payload
- **THEN** cloud responds with a session token, refresh token, dispatch WS URL, and configured `heartbeatIntervalSec` and `leaseSec` values

#### Scenario: Registration with unknown team
- **WHEN** the registration payload references a `teamId` the authenticated principal cannot access
- **THEN** cloud responds with `403` and body `{ "error": "team_forbidden" }`

### Requirement: Dispatch over WebSocket
The system SHALL deliver work to a registered worker as `dispatch` frames over a WebSocket connection at the URL returned in the registration response. Each frame SHALL carry `{type: "dispatch", runId, issueRef, branch, prompt, configHash, leaseSec, artifactUploadURLs}` where `artifactUploadURLs` are R2 presigned PUT URLs valid for the lease duration.

#### Scenario: Worker receives a dispatch
- **WHEN** an `IssueRun` DO selects a registered worker for a queued run
- **THEN** the worker receives a `dispatch` WebSocket frame containing the run identifier, issue reference, branch name, prompt, current `configHash`, `leaseSec`, and a map of presigned R2 PUT URLs

#### Scenario: Worker receives a dispatch while at max concurrency
- **WHEN** a worker's currently-acked run count equals `maxConcurrency` and cloud sends a new dispatch
- **THEN** the worker SHALL respond with `nack` carrying `reason: "at_capacity"` and the cloud SHALL requeue the run for another worker

### Requirement: Dispatch acknowledgement
The system SHALL require every dispatched run to be acknowledged via `POST /v1/runs/{runId}/ack` with body `{accept: bool, reason?: string}` within `5` seconds of frame delivery. Cloud SHALL revoke the lease and requeue the run if no ack arrives in time.

#### Scenario: Worker accepts dispatch in time
- **WHEN** the worker posts `{accept: true}` within 5 seconds of receiving the dispatch frame
- **THEN** cloud transitions the run to `running` and starts the lease alarm

#### Scenario: Worker rejects dispatch
- **WHEN** the worker posts `{accept: false, reason: "missing_capability"}`
- **THEN** cloud transitions the run back to `queued`, removes the worker from candidates for this run, and re-dispatches

#### Scenario: Worker fails to ack in time
- **WHEN** no ack arrives within 5 seconds
- **THEN** cloud revokes the lease, sends a `lease-revoked` frame to the worker, and requeues the run

### Requirement: Heartbeat and lease extension
The system SHALL accept heartbeats via `POST /v1/runs/{runId}/heartbeat` with body `{progress?: string, lastEventTs: number}` and SHALL extend the lease by `leaseSec` on each heartbeat. Workers SHALL send heartbeats at no longer than `heartbeatIntervalSec` cadence (default `leaseSec / 3`).

#### Scenario: Heartbeat extends lease
- **WHEN** the worker posts a heartbeat for an active run
- **THEN** cloud resets the `IssueRun` DO alarm to `now + leaseSec` and responds with `200`

#### Scenario: Heartbeat for a revoked lease
- **WHEN** the worker posts a heartbeat for a run whose lease was revoked
- **THEN** cloud responds with `409` and body `{ "error": "lease_revoked" }` and the worker SHALL stop work on that run

### Requirement: Event stream upload via NDJSON
The system SHALL accept agent events via `POST /v1/runs/{runId}/events` with `Content-Type: application/x-ndjson`, one JSON object per line. Each object SHALL contain `{ts, kind, payload}` where `kind` is one of `start | log | tool_call | diff | error | phase`. Server SHALL enforce `max 200 events per request` and `max 512KB per request`.

#### Scenario: Worker streams events for a running run
- **WHEN** the worker posts up to 200 NDJSON event lines totaling under 512KB
- **THEN** cloud appends them to the run event log and fans them out via `TeamCoordinator` to dashboard subscribers

#### Scenario: Worker exceeds per-request event limits
- **WHEN** the worker posts more than 200 events or more than 512KB in one request
- **THEN** cloud responds with `413` and body `{ "error": "events_too_large", "max_events": 200, "max_bytes": 524288 }` and the worker SHALL split and retry

### Requirement: Artifact upload via R2 presigned PUT
The system SHALL provide R2 presigned PUT URLs in the `dispatch` frame's `artifactUploadURLs` map (`logs`, `diff`, `summary`, `screenshots[]`) and SHALL NOT accept large artifacts via the API Worker. Workers SHALL upload large outputs (full agent log, full diff, screenshots) directly to R2 and reference the resulting object keys in the `complete` payload.

#### Scenario: Worker uploads agent log to R2
- **WHEN** the worker PUTs the full agent log to the presigned `logs` URL
- **THEN** R2 stores the object and the worker includes the resulting key in the `complete` request

#### Scenario: Worker attempts to send a >1MB artifact via the events endpoint
- **WHEN** the worker tries to inline a large artifact in an `events` POST exceeding `512KB`
- **THEN** cloud rejects with `413` and the worker SHALL re-upload via the presigned R2 URL instead

### Requirement: Run completion
The system SHALL accept run completion via `POST /v1/runs/{runId}/complete` with body `{status: "succeeded" | "failed" | "cancelled", summary, artifactKeys[], finalConfigHash}`. Cloud SHALL transition the `IssueRun` DO to a terminal state, persist the completion record to D1, and broadcast a `run-complete` frame.

#### Scenario: Successful completion
- **WHEN** the worker posts `{status: "succeeded", ...}` for a run with a valid lease
- **THEN** cloud marks the run done, persists artifacts metadata, and broadcasts `run-complete`

#### Scenario: Completion after lease revoked
- **WHEN** the worker posts a completion for a run whose lease was revoked and re-dispatched
- **THEN** cloud responds with `409 lease_revoked` and discards the result; the worker SHALL discard local state for that run

### Requirement: Lease revocation push
The system SHALL push a `lease-revoked` WebSocket frame `{type: "lease-revoked", runId, reason}` to the original worker whenever a run's lease is revoked (alarm fired, manual reassignment, ack timeout, server-initiated cancel). Workers SHALL stop the agent and discard local state for that run on receipt.

#### Scenario: Lease alarm fires due to missed heartbeats
- **WHEN** a heartbeat is missed and the lease alarm fires
- **THEN** cloud sends a `lease-revoked` frame to the original worker with `reason: "heartbeat_timeout"` and requeues the run

#### Scenario: Manual reassignment from dashboard
- **WHEN** an operator reassigns a run from the dashboard
- **THEN** the original worker receives a `lease-revoked` frame with `reason: "manual_reassign"`

### Requirement: Long-poll dispatch fallback
The system SHALL provide a long-poll fallback at `GET /v1/workers/{workerId}/dispatch?wait=25s` that returns either a single dispatch payload (same shape as the WS frame body) or `204` after the wait timeout, for use by workers behind proxies that block WebSocket upgrades.

#### Scenario: WS handshake blocked by proxy
- **WHEN** the worker's WebSocket upgrade fails three consecutive times
- **THEN** the worker SHALL switch to long-poll and cloud SHALL deliver dispatches via that path with the same payload shape

#### Scenario: Long-poll times out with no work
- **WHEN** no dispatch is available within the wait window
- **THEN** cloud responds with `204` and the worker SHALL re-issue the long-poll

### Requirement: Session refresh
The system SHALL accept `POST /v1/workers/refresh` with `{refreshToken}` and respond with a fresh `sessionToken` without forcing re-enrollment. Refresh tokens SHALL be valid for at least 30 days but SHALL be revocable from the dashboard.

#### Scenario: Worker refreshes an expiring session
- **WHEN** the worker posts a valid refresh token
- **THEN** cloud responds with a new short-lived session token

#### Scenario: Worker presents a revoked refresh token
- **WHEN** the refresh token has been revoked from the dashboard
- **THEN** cloud responds with `401` and body `{ "error": "refresh_revoked" }` and the worker SHALL prompt for re-enrollment
