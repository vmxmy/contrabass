## ADDED Requirements

### Requirement: One-shot LiteLLM import seeds DO on first init
The system SHALL run an idempotent one-shot import on first `IndexDO.init()` that seeds `TeamConfigDO`s and `IndexDO` indexes from LiteLLM `/team/list` and `/user/list`, and SHALL NOT re-run after success.

#### Scenario: Fresh deployment, empty DO
- **WHEN** `IndexDO.init()` runs for the first time on a deployment where `meta:imported` is unset or `false`
- **THEN** the system MUST walk all pages of LiteLLM `/team/list` and create a corresponding `TeamConfigDO` for each team
- **AND** the system MUST walk all pages of LiteLLM `/user/list` and write `IndexDO.email:{…}`, `IndexDO.user:{…}`, and the team-member entries on the matching `TeamConfigDO`
- **AND** the system MUST set `meta:imported = true` on completion
- **AND** the system MUST append an audit event named `import` in `IndexDO.audit:{ts}:import`

#### Scenario: Re-entry after partial progress
- **WHEN** `IndexDO.init()` is invoked again before the previous run set `meta:imported = true`
- **THEN** the system MUST resume or restart the import without producing duplicate `UserRecord`s or duplicate team rows
- **AND** the system MUST converge on the same final state regardless of how many times init was invoked

#### Scenario: Already-imported deployment
- **WHEN** `IndexDO.init()` is invoked on a deployment where `meta:imported = true`
- **THEN** the system MUST treat init as a no-op
- **AND** the system MUST NOT call LiteLLM `/team/list` or `/user/list`

### Requirement: Bootstrap admin emails are honored at import time
The system SHALL grant `role = admin` to every email listed in `BOOTSTRAP_ADMIN_EMAILS` during import, regardless of the role the email holds in LiteLLM at that moment.

#### Scenario: Bootstrap admin email exists in LiteLLM as a user
- **WHEN** the importer encounters an email that is present in `BOOTSTRAP_ADMIN_EMAILS` and also in `/user/list` with a non-admin role
- **THEN** the resulting DO `UserRecord` MUST have `role = admin`

#### Scenario: Bootstrap admin email absent from LiteLLM
- **WHEN** an email is present in `BOOTSTRAP_ADMIN_EMAILS` but absent from LiteLLM `/user/list`
- **THEN** the importer MUST NOT create the `UserRecord` during import
- **AND** the email MUST be elevated to `role = admin` upon its first successful `/magic-callback`

### Requirement: Bootstrap state persists across deploys
The system SHALL keep `meta:imported` in `IndexDO` storage so that subsequent deploys do not re-import LiteLLM data unless an operator explicitly resets the flag.

#### Scenario: Subsequent deploy
- **WHEN** a new portal version is deployed and `IndexDO.init()` is invoked again
- **AND** `meta:imported = true`
- **THEN** the importer MUST NOT run
- **AND** existing DO state (including any divergence from LiteLLM that occurred since import) MUST be left in place
