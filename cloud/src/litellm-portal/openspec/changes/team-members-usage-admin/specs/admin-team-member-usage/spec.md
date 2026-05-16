## ADDED Requirements

### Requirement: Admin team detail shows member usage overview
The system SHALL render a real admin team detail page at `/admin/teams/:teamId` that shows the selected team's summary metrics and a paginated member usage table.

#### Scenario: Team has members
- **WHEN** an admin opens `/admin/teams/:teamId` for a team with at least one member
- **THEN** the page MUST show team identity and budget context at the top
- **AND** the page MUST render a member usage table below the summary area
- **AND** each row MUST represent one member of the selected team

#### Scenario: Team has no members
- **WHEN** an admin opens `/admin/teams/:teamId` for a team with zero members
- **THEN** the page MUST render an explicit empty state
- **AND** the empty state MUST explain that no users are currently associated with the team

### Requirement: Team member data comes from a dedicated admin endpoint
The system SHALL provide a dedicated read-only admin endpoint for team members rather than asking the client to derive membership from the global user list.

#### Scenario: Fetch team members
- **WHEN** the client requests `GET /api/admin/teams/:teamId/members`
- **THEN** the server MUST return only members associated with that team
- **AND** the response MUST include pagination metadata
- **AND** the response MUST be protected by the existing admin auth guard

#### Scenario: Team not found
- **WHEN** the client requests members for an unknown `teamId`
- **THEN** the server MUST return a not-found error response
- **AND** the UI MUST render a recoverable not-found state rather than an empty success table

### Requirement: Team member usage scope is explicitly disclosed
The system SHALL label the usage scope shown in the team member table so admins do not mistake cumulative user spend for exact team-attributed historical spend.

#### Scenario: Cumulative spend displayed
- **WHEN** the member table shows a usage value derived from the global user record
- **THEN** the UI MUST label that value as cumulative or user-level spend
- **AND** the UI MUST NOT describe it as exact team-attributed spend

#### Scenario: Sampled result displayed
- **WHEN** the backend cannot scan the full upstream user set within the configured page cap
- **THEN** the response MUST include metadata indicating the result is limited
- **AND** the UI MUST disclose that the team member list is sampled or incomplete

### Requirement: Team detail summary highlights member-level risk
The system SHALL show team summary metrics that help admins quickly identify whether the team requires further investigation.

#### Scenario: Summary metrics available
- **WHEN** the team detail page loads successfully
- **THEN** the summary area MUST show the team's spend and budget context
- **AND** the summary area MUST show the number of members in the team
- **AND** the summary area MUST show at least one member-risk indicator such as over-budget or unmanaged-role counts

### Requirement: Admin can drill from a team member to user detail
The system SHALL let admins navigate from a team member row to the corresponding admin user detail page.

#### Scenario: Row navigation
- **WHEN** an admin activates a team member row action or primary identity link
- **THEN** the portal MUST navigate to `/admin/users/:userId`
- **AND** the selected user MUST match the row that was activated
