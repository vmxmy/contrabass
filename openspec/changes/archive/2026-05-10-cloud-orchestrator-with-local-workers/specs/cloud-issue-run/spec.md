## ADDED Requirements

### Requirement: One Durable Object per active issue run
The system SHALL provision one `IssueRun` Durable Object per active run, addressed by `idFromName(teamId + ":" + issueRef)`. All lease state, heartbeat tracking, run-state transitions, and event-log appends for that run SHALL go through that single DO instance.

#### Scenario: First dispatch of an issue materializes the DO
- **WHEN** a tracker poller posts a new issue and `TeamCoordinator` decides to dispatch it
- **THEN** the runtime instantiates an `IssueRun` DO at `idFromName(teamId + ":" + issueRef)` and the run begins in state `queued`

### Requirement: Run state machine
The `IssueRun` DO SHALL maintain a state machine with states `queued | dispatched | running | succeeded | failed | cancelled`. Transitions SHALL be: `queued → dispatched` (on dispatch sent), `dispatched → running` (on ack accept), `dispatched → queued` (on ack reject or ack timeout), `running → succeeded | failed | cancelled` (on completion), `running → queued` (on lease revocation).

#### Scenario: Worker accepts dispatch and run goes running
- **WHEN** a worker posts `{accept: true}` to `/v1/runs/{runId}/ack`
- **THEN** the `IssueRun` DO transitions from `dispatched` to `running` and starts the lease alarm

#### Scenario: Lease alarm fires while running
- **WHEN** the lease alarm fires before a heartbeat extends it
- **THEN** the DO transitions from `running` back to `queued`, sends `lease-revoked` to the original worker, and notifies `TeamCoordinator` to redispatch

#### Scenario: Worker reports completion
- **WHEN** the worker posts `{status: "succeeded", ...}` with a valid lease
- **THEN** the DO transitions to `succeeded`, persists the completion record, and broadcasts `run-complete`

### Requirement: Lease tracking via DO alarms
The `IssueRun` DO SHALL store `{leaseHolder: workerId, leaseExpiresAt, leaseSec}` and SHALL set a DO alarm at `leaseExpiresAt`. Heartbeats SHALL extend `leaseExpiresAt` to `now + leaseSec` and reset the alarm. Manual revocation SHALL clear the lease and notify the holder.

#### Scenario: Heartbeat extends the lease
- **WHEN** the worker posts a heartbeat for a run with `leaseExpiresAt = T`
- **THEN** the DO updates `leaseExpiresAt` to `now + leaseSec` and resets the alarm

#### Scenario: Heartbeat from non-holder is rejected
- **WHEN** a heartbeat arrives from a worker that does not match `leaseHolder`
- **THEN** the DO responds with `409 lease_holder_mismatch` and does not extend the lease

### Requirement: Event log persistence
The `IssueRun` DO SHALL append every accepted event from `POST /v1/runs/{runId}/events` to a per-run event log in DO storage and SHALL forward each event to `TeamCoordinator` for fan-out and to the events Queue for archival.

#### Scenario: Event is persisted and fanned out
- **WHEN** an NDJSON event arrives for a running run
- **THEN** the DO appends it to the run's event log, forwards it to `TeamCoordinator` for dashboard fan-out, and enqueues it on the events Queue

#### Scenario: Event arrives for a terminal run
- **WHEN** an event arrives for a run already in `succeeded | failed | cancelled`
- **THEN** the DO responds with `409 run_terminal` and does not append

### Requirement: Idempotent claim semantics
The `IssueRun` DO SHALL guarantee that any given `issueRef` cannot have two concurrent leaseholders. Dispatch SHALL use a single CAS write into DO storage to acquire the lease.

#### Scenario: Two simultaneous dispatch attempts for the same issue
- **WHEN** `TeamCoordinator` issues two dispatch frames for the same issue to two different workers within the same millisecond
- **THEN** exactly one ack succeeds; the other receives `409 lease_already_held` and the second worker is removed from the candidate set for this run

### Requirement: Completion record persistence
On terminal transition the `IssueRun` DO SHALL write a completion record to D1 containing `{runId, teamId, issueRef, workerId, kind, startedAt, endedAt, status, summary, artifactKeys[], finalConfigHash}` and SHALL retain in DO storage only enough state to deduplicate late events for 24 hours, after which the DO MAY be evicted.

#### Scenario: Successful run is persisted to D1
- **WHEN** a run completes successfully
- **THEN** a row appears in the D1 `runs` table with all completion fields and the artifact keys reference R2 objects

#### Scenario: Late event after run terminal and within retention
- **WHEN** an event for a terminal run arrives within 24 hours of completion
- **THEN** the DO returns `409 run_terminal` and increments a `late_events` counter for observability

### Requirement: Cancellation
The `IssueRun` DO SHALL accept `POST /cancel` from `TeamCoordinator` (operator-initiated) and SHALL transition `running → cancelled`, send `lease-revoked` with `reason: "cancelled"` to the holder, and persist a completion record with `status: cancelled`.

#### Scenario: Operator cancels a running run
- **WHEN** an operator clicks "Cancel" in the dashboard for an active run
- **THEN** the API Worker forwards through `TeamCoordinator` to the `IssueRun` DO, the worker receives `lease-revoked` with `reason: "cancelled"`, and a cancellation completion record is written
