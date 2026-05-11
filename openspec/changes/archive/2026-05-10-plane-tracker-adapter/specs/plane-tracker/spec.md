## ADDED Requirements

### Requirement: Plane adapter implements PollerAdapter
`cloud/src/poller/plane.ts` exports a `planeAdapter` satisfying the `PollerAdapter` type.

#### Scenario: Fetch and normalize Plane issues
- **WHEN** `planeAdapter(invocation)` is called for a team with `tracker.type: plane` config
- **THEN** it reads workspace slug, project ID, and API key from the team's YAML config, fetches issues from Plane REST API, normalizes them to `PollerIssue` shape, and POSTs them to the TeamCoordinator DO's `/board/refresh`

#### Scenario: Exclude terminal-state issues
- **WHEN** Plane issues are fetched
- **THEN** issues in "completed" or "cancelled" state groups are excluded from the result

#### Scenario: State group maps to poller state
- **WHEN** an issue's Plane state group is "backlog" or "unstarted"
- **THEN** the normalized issue state is `"unclaimed"`
- **WHEN** the state group is "started"
- **THEN** the normalized issue state is `"claimed"`

#### Scenario: Offset-based pagination
- **WHEN** Plane API returns a partial result set
- **THEN** the adapter continues fetching with incremented offset until all issues are retrieved

### Requirement: PlaneAdapterName registration
`PollerAdapterName` union type, adapter map, config parser, and adapter name resolver all include `"plane"`.

#### Scenario: YAML config enables plane tracker
- **WHEN** a team's config YAML contains `tracker:` block with `type: plane` or a `plane:` sub-key
- **THEN** `enabledTrackersFromConfig` returns `"plane"` in the adapter list

#### Scenario: DEFAULT_ADAPTERS includes plane
- **WHEN** the poller dispatches to the `"plane"` adapter
- **THEN** it resolves to `planeAdapter` from `DEFAULT_ADAPTERS`

#### Scenario: adapterNameFromKey recognizes plane
- **WHEN** `adapterNameFromKey("plane")` is called
- **THEN** it returns `"plane"`

### Requirement: Plane token resolution
API token resolved from YAML config or env bindings, following the same precedence as Linear.

#### Scenario: Token from YAML api_key
- **WHEN** `tracker.plane.api_key: "$PLANE_API_KEY"` is in config
- **THEN** the adapter resolves the token from `env.PLANE_API_KEY`

#### Scenario: Token from env binding fallback
- **WHEN** no `api_key` is in config
- **THEN** the adapter tries env bindings in order: `TRACKER_{TEAM}_PLANE_API_KEY`, `TRACKER_PLANE_API_KEY`, `PLANE_API_KEY`

#### Scenario: Missing token
- **WHEN** no token can be resolved
- **THEN** the adapter throws an error message including the team ID

### Requirement: Rate limit backoff
`PlaneRateLimitError` with `retryAfterMs` triggers the poller's existing backoff mechanism.

#### Scenario: Plane returns 429
- **WHEN** Plane API responds with HTTP 429
- **THEN** `PlaneRateLimitError` is thrown with `retryAfterMs` parsed from `Retry-After` header

#### Scenario: Backoff kicks in
- **WHEN** a `PlaneRateLimitError` is caught by the poller
- **THEN** the poller sets a team backoff entry and skips subsequent adapters for that team

### Requirement: Secret store registration
`"plane"` added to `TRACKER_SECRET_PROVIDERS` in `cloud/src/secrets/tracker.ts`.

#### Scenario: Secret name generation
- **WHEN** `trackerSecretName("my-team", "plane")` is called
- **THEN** it returns `"tracker/my-team/plane"`

### Requirement: Adapter tests
Tests in `cloud/src/poller/plane.test.ts` (or `.spec.ts`) cover the adapter using mocked fetch.

#### Scenario: All adapter functions tested
- **WHEN** test suite runs
- **THEN** issue fetching, normalization, state filtering, pagination, rate-limit handling, token resolution, and TeamCoordinator POST are all exercised
