## ADDED Requirements

### Requirement: Access-authenticated LiteLLM identity
The portal SHALL derive the active LiteLLM identity from the Cloudflare Access-authenticated email on the server and SHALL NOT accept a browser-provided `user_id` for portal data access.

#### Scenario: Signed-in user loads portal data
- **WHEN** a request includes a valid Cloudflare Access assertion for an allowed email
- **THEN** the Worker resolves the LiteLLM user for that email before reading keys, teams, models, or usage

#### Scenario: Browser attempts to forge identity
- **WHEN** the browser sends a query parameter or body field containing another `user_id`
- **THEN** the Worker ignores that value and uses only the server-resolved LiteLLM user

### Requirement: Read-only API key display
The portal SHALL display existing API keys for the resolved LiteLLM user and SHALL NOT expose key creation, update, deletion, or rotation operations.

#### Scenario: User views existing keys
- **WHEN** the user opens the portal dashboard
- **THEN** the dashboard lists only API keys owned by the resolved LiteLLM user

#### Scenario: Key creation API is called
- **WHEN** the browser sends `POST /api/keys`
- **THEN** the Worker returns not found or method-not-allowed and does not call LiteLLM key generation endpoints

### Requirement: Team-scoped model visibility
The portal SHALL show available models based on the resolved LiteLLM user's team membership and SHALL include metadata describing the source of the model list.

#### Scenario: Team has explicit models
- **WHEN** LiteLLM team metadata contains a non-empty `models` list
- **THEN** the portal returns only those team models, optionally intersected with Worker-configured model allowlists

#### Scenario: Team has unrestricted models
- **WHEN** the LiteLLM team model list is empty and the team exists
- **THEN** the portal marks the model source as unrestricted and may return the global LiteLLM model list

### Requirement: Multi-granularity usage analytics
The portal SHALL provide token usage analytics at minute, hour, day, week, and month grains using server-side aggregation.

#### Scenario: Recent minute-level usage is requested
- **WHEN** the portal requests minute-level usage for a recent bounded window
- **THEN** the Worker reads paginated LiteLLM spend logs, buckets requests by minute, and returns total, prompt, and completion token counts per bucket

#### Scenario: Hour-level usage is requested
- **WHEN** the portal requests hour-level usage for a short recent window
- **THEN** the Worker buckets request-level spend logs by hour and includes requests and spend per bucket

#### Scenario: Day-level usage is requested
- **WHEN** the portal requests day-level usage for a 7, 30, or 90 day window
- **THEN** the Worker returns day buckets from LiteLLM daily activity or equivalent server-side aggregation

#### Scenario: Week or month usage is requested
- **WHEN** the portal requests week-level or month-level usage
- **THEN** the Worker rolls daily usage into week or month buckets and returns trend data suitable for management review

### Requirement: Sanitized analytics payloads
The portal SHALL expose only sanitized, aggregated usage data to the browser and SHALL NOT return raw prompts, responses, LiteLLM master credentials, or request payload contents.

#### Scenario: Usage data is returned
- **WHEN** the Worker responds to a usage analytics request
- **THEN** the response contains only bucket timestamps, token counts, request counts, spend, and allowed grouping labels

#### Scenario: LiteLLM spend logs contain raw message content
- **WHEN** LiteLLM returns fields such as `messages` or `response`
- **THEN** the Worker excludes those fields from portal API responses

### Requirement: Kumo-based dashboard layout
The portal UI SHALL use Kumo styles for layout and components and SHALL avoid custom inline styles or embedded style blocks.

#### Scenario: Portal HTML is served
- **WHEN** the browser requests the portal page
- **THEN** the HTML links the generated Kumo stylesheet and contains no `<style>` block or `style=` attributes

#### Scenario: Dashboard renders on desktop and mobile
- **WHEN** the portal is viewed on desktop or mobile widths
- **THEN** the key, model, team, and usage sections remain readable without overlapping controls
