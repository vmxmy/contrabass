## ADDED Requirements

### Requirement: High-risk admin actions require typed confirmation
Admin actions classified as medium or high risk (delete user, delete key, change global budget) SHALL require the operator to type the full resource identifier (email, key alias, "GLOBAL_BUDGET") into the confirmation dialog before the mutation can submit.

#### Scenario: Wrong typing prevents submit
- **WHEN** the admin opens the delete-user dialog and types a partially matching email
- **THEN** the submit button MUST remain disabled
- **AND** the mutation request MUST NOT fire

#### Scenario: Exact match enables submit
- **WHEN** the admin types the exact target email
- **THEN** the submit button MUST become enabled
- **AND** clicking submit MUST initiate the mutation

### Requirement: Low-risk actions support 5-second undo
Mutations classified as low risk (disable key, change RPM/TPM) SHALL surface an undo action via toast for at least 5 seconds; clicking undo SHALL run the inverse mutation.

#### Scenario: Undo restores previous state
- **WHEN** an admin disables a key and then clicks undo within 5 seconds
- **THEN** an enable-key mutation MUST run
- **AND** the key MUST appear active again to subsequent reads

### Requirement: Critical actions require two-person approval
Critical actions (delete user, change global budget by more than 10×) SHALL be staged in a `PendingApprovalDO` with a 5-minute TTL; the action SHALL apply only after a second admin approves it.

#### Scenario: Approval required before apply
- **WHEN** admin A submits a critical action
- **THEN** the action MUST be queued and admin A MUST see "等待第二人审批"
- **AND** the underlying LiteLLM call MUST NOT execute

#### Scenario: Second admin approves
- **WHEN** admin B approves the queued action within 5 minutes
- **THEN** the action MUST execute and audit MUST record both actors
- **AND** if no approval lands within 5 minutes the queue entry MUST expire and the action MUST NOT execute

### Requirement: All writes record before/after audit diff
Each successful write SHALL emit an audit row containing the actor, action, target id, the resource state before and after, and a free-text reason supplied by the operator.

#### Scenario: Audit detail shows reason and diff
- **WHEN** an admin views an audit event for a write action
- **THEN** the detail MUST display the reason text and a JSON diff between the `before` and `after` states
- **AND** the audit row MUST be immutable
