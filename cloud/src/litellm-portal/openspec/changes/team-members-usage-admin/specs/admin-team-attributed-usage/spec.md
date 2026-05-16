## ADDED Requirements

### Requirement: Admin can inspect team-attributed usage by member
The system SHALL provide a team-scoped attributed-usage view that aggregates spend and request activity by user inside the selected team.

#### Scenario: Attributed member leaderboard available
- **WHEN** the client requests `GET /api/admin/teams/:teamId/usage/users` and the upstream data supports exact attribution
- **THEN** the server MUST return a per-member leaderboard filtered to the selected team
- **AND** each row MUST represent attributed usage for exactly one member inside that team
- **AND** the response MUST distinguish attributed usage from cumulative user usage

#### Scenario: Attributed member leaderboard unavailable
- **WHEN** the upstream spend-log records do not expose the identifiers needed for exact team attribution
- **THEN** the endpoint MUST return an explicit unavailable state
- **AND** the UI MUST explain that exact team-attributed analytics are not available for the current deployment

### Requirement: Admin can inspect per-member attributed timeseries inside a team
The system SHALL provide a team-and-user scoped timeseries endpoint for exact attributed usage when upstream attribution data is available.

#### Scenario: Fetch per-member attributed timeseries
- **WHEN** the client requests `GET /api/admin/teams/:teamId/users/:userId/usage/timeseries`
- **THEN** the server MUST return only buckets attributed to that `teamId` and `userId`
- **AND** the response MUST reuse the portal's existing usage-timeseries shape where possible

#### Scenario: User not in team
- **WHEN** the client requests a team-scoped attributed timeseries for a user who is not associated with the selected team
- **THEN** the server MUST return a not-found or membership-mismatch error
- **AND** the UI MUST avoid rendering a misleading empty success chart

### Requirement: Team detail presents cumulative and attributed usage as separate concepts
The system SHALL keep cumulative member usage and exact team-attributed usage visually and semantically distinct on the team detail page.

#### Scenario: Both data sources available
- **WHEN** the team detail page has both cumulative member usage and exact attributed usage data
- **THEN** the UI MUST present them as separate views, columns, or labeled sections
- **AND** the UI MUST NOT merge the two values into a single unlabeled spend field

#### Scenario: Only cumulative usage available
- **WHEN** exact attributed usage is unavailable but cumulative member usage is available
- **THEN** the team detail page MUST continue to render the cumulative member table
- **AND** the attributed usage section MUST render an explanatory unavailable state
