## ADDED Requirements

### Requirement: Server requests emit metrics to Analytics Engine
Every request to a portal API route SHALL emit a structured row to a `portal-metrics` Analytics Engine dataset containing route, status, total latency, upstream latency, role, and cache-hit layer.

#### Scenario: Successful request writes one metric row
- **WHEN** an authenticated user calls `/api/dashboard` successfully
- **THEN** Analytics Engine MUST receive exactly one row tagged `route="/api/dashboard"`, `status=200`
- **AND** the row MUST include both `latencyMs` and `upstreamMs` fields

#### Scenario: Failed upstream still emits metric
- **WHEN** the upstream LiteLLM call returns 5xx
- **THEN** the metric row MUST be written with `status=502` and the elapsed timings
- **AND** the user MUST receive an error response

### Requirement: Admin actions emit audit records
Every authenticated call to `/api/admin/*` SHALL emit a row to a `portal-audit` Analytics Engine dataset containing actor email, action path, target id (when applicable), IP, and timestamp.

#### Scenario: Read-only admin call is audited
- **WHEN** an admin requests `/api/admin/users?page=2`
- **THEN** the audit dataset MUST gain one row with `actor` set to the admin email
- **AND** the row MUST record `page=2` in its parameters

### Requirement: Client errors are reported server-side
The portal SHALL register a global ErrorBoundary plus `window.onerror`/`unhandledrejection` listeners that batch errors and `POST` them to `/api/_internal/client-error`; the endpoint SHALL rate-limit per session.

#### Scenario: Render error is reported
- **WHEN** a React render error reaches the top-level boundary
- **THEN** the boundary MUST render a fallback UI
- **AND** the boundary MUST queue a structured error payload for the next batch upload

#### Scenario: Endpoint rejects bursts
- **WHEN** a single session posts more than N errors in one minute
- **THEN** subsequent posts MUST receive HTTP 429
- **AND** the server MUST log the rate-limit hit
