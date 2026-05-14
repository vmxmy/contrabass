## ADDED Requirements

### Requirement: Admin writes enqueue a sync message after DO commit
The system SHALL enqueue a message on the `litellm-sync` Cloudflare Queue immediately after every successful DO write produced by an admin endpoint, and SHALL NOT return success to the caller before that enqueue.

#### Scenario: Successful admin write enqueues a sync message
- **WHEN** an admin endpoint commits a change to DO
- **THEN** the server MUST call `LITELLM_SYNC_QUEUE.send(...)` with `{ kind, entityId, payload, idempotencyKey }` BEFORE returning 200
- **AND** the response MUST include `lastSyncedAt` (which may be the previous value until the consumer runs)
- **AND** the response MUST include a stable sync-message identifier for client-side observability

#### Scenario: Queue send failure
- **WHEN** the queue producer call fails after a successful DO commit
- **THEN** the server MUST set `meta:dirty = true` on the corresponding DO row
- **AND** the server MUST return a 200 response (the DO is authoritative)
- **AND** an operator-visible signal MUST be recorded so that drift can be detected

### Requirement: Queue consumer materializes DO state into LiteLLM with retry and DLQ
The system SHALL run a consumer Worker that translates each sync message into the matching LiteLLM admin call with retries and a dead-letter queue on terminal failure.

#### Scenario: Successful materialization
- **WHEN** the consumer receives a `team.update` (or any kind) message and LiteLLM responds 2xx
- **THEN** the consumer MUST update `meta:lastSyncedAt` on the corresponding DO row
- **AND** the consumer MUST clear `meta:lastSyncError`
- **AND** the consumer MUST clear `meta:dirty`

#### Scenario: Retryable failure
- **WHEN** the consumer receives a message and LiteLLM responds with a 5xx or transient network error
- **THEN** the consumer MUST retry up to 5 times with exponential backoff
- **AND** intermediate attempts MUST NOT alter `meta:lastSyncedAt`

#### Scenario: Terminal failure
- **WHEN** all retries are exhausted OR LiteLLM responds with a non-retryable 4xx
- **THEN** the consumer MUST forward the message to the `litellm-sync-dlq` dead-letter queue
- **AND** the consumer MUST write `meta:lastSyncError` on the corresponding DO row with a short reason
- **AND** the consumer MUST keep `meta:dirty = true`

### Requirement: Sync is idempotent per message
The system SHALL include an `idempotencyKey` on every sync message so a redelivered message does not produce divergent state in LiteLLM.

#### Scenario: Redelivered message
- **WHEN** the queue consumer receives a sync message whose `idempotencyKey` matches one it has already successfully processed for the same `entityId`
- **THEN** the consumer MUST skip the LiteLLM call
- **AND** the consumer MUST still advance `meta:lastSyncedAt` to the current time

### Requirement: Spend mirror cron pulls LiteLLM spend into DO
The system SHALL run a scheduled Worker every minute that walks all teams and writes the latest LiteLLM spend snapshot into the corresponding `TeamConfigDO`.

#### Scenario: Steady-state spend refresh
- **WHEN** the scheduled spend mirror runs
- **THEN** the handler MUST read `IndexDO.teams:list`
- **AND** for each team it MUST call LiteLLM `/team/info?team_id=`
- **AND** it MUST write the resulting numbers to `TeamConfigDO.spend:current` with a fresh timestamp

#### Scenario: LiteLLM unavailable during a spend tick
- **WHEN** the LiteLLM call fails for a given team
- **THEN** the cron MUST continue with the remaining teams
- **AND** the failing team's previously stored `spend:current` MUST remain visible to readers
- **AND** the failure MUST be recorded on the corresponding DO row's `meta:lastSpendError`

### Requirement: Sync status is exposed on admin payloads
The system SHALL include `lastSyncedAt` and `lastSyncError` on admin payloads for any row that carries those metadata fields, so the UI can render a sync-status badge.

#### Scenario: Successful sync visible to the UI
- **WHEN** the admin UI reads a team or user payload
- **THEN** the payload MUST include `lastSyncedAt` (ISO 8601)
- **AND** the payload MUST include `lastSyncError` as either `null` or a short string

#### Scenario: Failed sync visible to the UI
- **WHEN** a row has `meta:lastSyncError` set and `meta:dirty = true`
- **THEN** the admin UI MUST render a "sync failed" badge for that row
- **AND** the badge MUST surface the short error reason on hover or detail expansion
