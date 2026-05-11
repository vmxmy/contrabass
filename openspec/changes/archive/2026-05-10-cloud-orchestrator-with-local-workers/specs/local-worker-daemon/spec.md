## ADDED Requirements

### Requirement: New `contrabass worker` subcommand
The contrabass binary SHALL expose a `worker` subcommand that runs as a long-lived daemon, registers with the cloud control plane, consumes dispatched runs, executes them locally using existing `internal/agent`, `internal/workspace`, and `internal/tmux` code, and reports events back to the cloud via the worker protocol.

#### Scenario: Developer starts the worker
- **WHEN** a developer runs `contrabass worker --team my-team` after enrollment
- **THEN** the binary registers with the cloud, prints its assigned `workerId` and dispatch channel URL, and begins waiting for dispatch frames

#### Scenario: Worker subcommand without enrollment
- **WHEN** the developer runs `contrabass worker --team my-team` on a machine that has never been enrolled
- **THEN** the binary exits non-zero with a message instructing the developer to run `contrabass worker login` first

### Requirement: Enrollment via one-time code
The `worker` subcommand SHALL support `contrabass worker login` which accepts an enrollment code generated from the dashboard, exchanges it for a refresh token at `POST /v1/workers/enroll`, and stores the refresh token in the OS-native credential store (Keychain on macOS, libsecret on Linux, Credential Manager on Windows). Refresh tokens SHALL NOT be written to plain disk files.

#### Scenario: Successful enrollment
- **WHEN** a developer runs `contrabass worker login --code ABC-123` and the code is valid
- **THEN** the cloud returns a refresh token, the binary stores it in the OS credential store, and prints the assigned worker identity

#### Scenario: Enrollment with bad code
- **WHEN** the enrollment code is invalid or expired
- **THEN** the binary exits non-zero with a clear error pointing the developer to generate a fresh code

### Requirement: Capability declaration
On registration the worker SHALL declare its capabilities including supported agent runners (`codex`, `opencode`, `omx`, `omc`, `mock`), git availability, tmux availability, OS, architecture, and version. The set of capabilities is computed at startup, not configured.

#### Scenario: Worker on macOS with codex installed
- **WHEN** the worker starts on macOS with `codex` on `$PATH` and tmux available
- **THEN** registration includes `capabilities: ["agent:codex", "tmux", "git", "os:darwin", "arch:arm64"]` (or matching arch)

#### Scenario: Worker without any agent runner installed
- **WHEN** the worker starts on a machine without any supported agent CLI
- **THEN** the binary refuses to register and exits with a message listing the missing runners

### Requirement: Local execution reuses existing internal packages
The worker SHALL execute dispatched runs using the existing `internal/agent` runner interface, the existing `internal/workspace` git-worktree provisioning, and (when `tmux` capability is declared) the existing `internal/tmux` session helpers. No agent runner logic SHALL be reimplemented in the worker subcommand.

#### Scenario: Run dispatched to a worker with tmux capability
- **WHEN** the worker accepts a dispatch
- **THEN** it provisions a worktree via `internal/workspace`, opens a tmux pane via `internal/tmux`, and starts the agent runner via `internal/agent`

#### Scenario: Run dispatched to a worker without tmux
- **WHEN** the worker accepts a dispatch and did not declare `tmux` capability
- **THEN** it runs the agent in-process (goroutine mode equivalent) and reports events identically

### Requirement: Event reporting compliance
The worker SHALL convert agent runner output (currently consumed by `internal/hub` / `internal/ipc`) into worker-protocol NDJSON events and POST them to `/v1/runs/{runId}/events`, batching at no more than 200 events or 512KB per request and at no longer than 2-second latency.

#### Scenario: Agent emits events at high rate
- **WHEN** the agent runner produces 1000 events in 5 seconds
- **THEN** the worker batches them into compliant POSTs and stays under the per-request limits

#### Scenario: Cloud rejects an oversized batch
- **WHEN** a batch is rejected with `413 events_too_large`
- **THEN** the worker splits the batch and retries

### Requirement: Heartbeat scheduling
The worker SHALL send heartbeats for each in-flight run at `heartbeatIntervalSec` cadence (received from registration response, default 20s if `leaseSec` is 60s), with `progress` set to a short human-readable phase label and `lastEventTs` to the most recent event timestamp.

#### Scenario: Heartbeat cadence
- **WHEN** the cloud configured `heartbeatIntervalSec: 20`
- **THEN** the worker posts a heartbeat per active run every 20 seconds (±2s jitter)

#### Scenario: Worker discovers lease was revoked via heartbeat response
- **WHEN** a heartbeat returns `409 lease_revoked`
- **THEN** the worker stops the agent runner for that run, releases the worktree, and discards local run state

### Requirement: Lease-revocation handling
The worker SHALL handle `lease-revoked` WebSocket frames by stopping the agent runner for the affected run within 5 seconds, attempting to upload any partial artifacts to the still-valid presigned URLs, releasing the worktree, and removing the run from its in-flight set. The worker SHALL NOT attempt to complete the run.

#### Scenario: Lease revoked during agent execution
- **WHEN** a `lease-revoked` frame arrives for a running agent
- **THEN** the worker sends SIGTERM to the agent (then SIGKILL after 5s grace), uploads partial logs if possible, releases the worktree, and removes the run from the in-flight set

### Requirement: Local-only mode preservation
The contrabass binary SHALL still build and run in `--local-only` mode (single-host orchestrator, embedded dashboard) when built with the `localonly` build tag. The `worker` subcommand SHALL be available in the default build and SHALL NOT depend on the `localonly` build tag.

#### Scenario: Default build supports worker but not server
- **WHEN** built with `make build` (no `-tags localonly`)
- **THEN** `contrabass worker` is available, `contrabass server --local-only` reports "not built with localonly tag", and binary size excludes `internal/team`/`internal/orchestrator`/`internal/hub`/`internal/web`/`internal/ipc`

#### Scenario: Local-only build supports both modes
- **WHEN** built with `make build LOCAL_ONLY=1` (which adds `-tags localonly`)
- **THEN** both `contrabass worker` and `contrabass server --local-only` are available

### Requirement: Long-poll fallback when WebSocket is blocked
The worker SHALL automatically fall back to long-poll dispatch (`GET /v1/workers/{workerId}/dispatch?wait=25s`) after three consecutive WebSocket upgrade failures and SHALL retry WS once per minute thereafter to recover.

#### Scenario: Corporate proxy blocks WebSocket
- **WHEN** the worker's WS upgrade fails three times in a row with `400`/`426`/`502`
- **THEN** the worker switches to long-poll without manual intervention and continues to receive dispatches
