## ADDED Requirements

### Requirement: D1-backed configuration store
The system SHALL persist team workflow configuration in a D1 table `team_configs` keyed by `(team_id, version)`. Each row SHALL contain `{team_id, version, content_hash, content_yaml, created_by, created_at, notes}`. `content_hash` SHALL be a SHA-256 of `content_yaml` and SHALL uniquely identify the configuration content.

#### Scenario: New configuration version is written
- **WHEN** an operator pushes a new configuration via the dashboard or `contrabass config push`
- **THEN** a new row is inserted with monotonically increasing `version` and a fresh `content_hash`

#### Scenario: Pushing identical configuration content
- **WHEN** the pushed content normalizes to a `content_hash` already present for the team
- **THEN** no new row is inserted, the existing version is returned, and the response includes `unchanged: true`

### Requirement: Configuration parsing and validation at write
On `POST /v1/teams/{teamId}/config` the API Worker SHALL parse the submitted YAML using the existing parser logic (ported from `internal/config`) and SHALL reject the write with `400` and a structured field-level error list if parsing or validation fails. Only valid configurations SHALL be persisted to D1.

#### Scenario: Operator submits invalid YAML
- **WHEN** the submitted YAML fails parsing (e.g., invalid Liquid template, unknown tracker type)
- **THEN** the API Worker responds `400` with `{ "error": "config_invalid", "details": [{path, message}, ...] }` and writes nothing to D1

#### Scenario: Operator submits config referencing missing secret
- **WHEN** the submitted YAML references `$LINEAR_API_KEY` and that secret has not been bound for the team
- **THEN** validation fails with `{ "error": "config_invalid", "details": [{path: "tracker.linear.token", message: "secret not bound: LINEAR_API_KEY"}] }`

### Requirement: Active configuration pointer
The system SHALL maintain an `active_version` pointer per team in `team_configs_active` table holding `{team_id, active_version, active_content_hash, activated_at, activated_by}`. Workers SHALL receive `active_content_hash` on every `dispatch` frame.

#### Scenario: Operator activates a new version
- **WHEN** the operator clicks "Activate" on a stored version
- **THEN** `team_configs_active` is updated and `TeamCoordinator` broadcasts `config-changed` to all dashboard subscribers and registered workers

#### Scenario: Worker receives dispatch with current config hash
- **WHEN** a dispatch is sent
- **THEN** the dispatch frame includes the current `active_content_hash`

### Requirement: Configuration distribution by hash
The system SHALL expose `GET /v1/teams/{teamId}/config/{hash}` returning the YAML content for the requested hash. Workers SHALL cache configurations by hash locally and SHALL fetch only on cache miss. The endpoint SHALL be cacheable (`Cache-Control: public, max-age=86400, immutable`) since hashes are content-addressable.

#### Scenario: Worker fetches a config it has not seen
- **WHEN** a dispatch arrives with `configHash` the worker has not cached
- **THEN** the worker GETs `/v1/teams/{teamId}/config/{hash}` and caches the result

#### Scenario: Worker reuses cached config across dispatches
- **WHEN** subsequent dispatches arrive with the same `configHash`
- **THEN** the worker uses its local cache without a network call

### Requirement: Liquid prompt rendering uses cloud-resolved environment
The system SHALL resolve `$ENV_VAR` and `{{ ... }}` Liquid template references at config-validation time, with environment values taken from the team's bindings (Secrets Store for secrets, regular config rows for non-secret variables). Workers SHALL receive the rendered prompt template embedded in the configuration content; secrets referenced in prompts SHALL NOT be transmitted to workers.

#### Scenario: Prompt references a non-secret variable
- **WHEN** the prompt template includes `{{ team.name }}` and `team.name` is `acme`
- **THEN** the rendered prompt sent to workers contains `acme`

#### Scenario: Prompt references a secret variable
- **WHEN** the prompt template includes `{{ secrets.LINEAR_API_KEY }}`
- **THEN** validation fails with `{ "error": "config_invalid", "details": [{path: "prompt", message: "secrets are not allowed in prompts"}] }`

### Requirement: Versioned audit trail
The system SHALL retain all historical configuration versions for at least 90 days. The dashboard SHALL display a diff between any two versions and the audit metadata (`created_by`, `created_at`, `notes`).

#### Scenario: Operator views config history
- **WHEN** the operator opens the team's "Config History" page
- **THEN** all versions stored within the retention window are listed with author and timestamp, and any two can be diffed

### Requirement: `WORKFLOW.md` import tool
The contrabass CLI SHALL provide `contrabass config import-md <path>` which parses an existing `WORKFLOW.md`, validates it via the cloud API, and pushes it as a new version with `created_by: "import"` and `notes: "imported from <path>"`.

#### Scenario: Operator imports an existing WORKFLOW.md
- **WHEN** an operator runs `contrabass config import-md ./WORKFLOW.md --team my-team`
- **THEN** the file is uploaded, validated, and stored as a new version; activation remains a separate explicit step
