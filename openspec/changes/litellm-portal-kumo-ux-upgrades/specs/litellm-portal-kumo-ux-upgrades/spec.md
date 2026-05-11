## ADDED Requirements

### Requirement: Kumo Select usage controls
The portal SHALL render usage grain and window controls through Kumo React `Select` components imported with granular `@cloudflare/kumo/components/select` paths, not native Worker-template `<select>` elements.

#### Scenario: Portal HTML is served
- **WHEN** the browser requests the portal page
- **THEN** the Worker-rendered HTML contains a usage panel React mount point
- **AND** it does not contain native `id="usage-grain"` or `id="usage-window-select"` select controls

#### Scenario: User changes usage grain
- **WHEN** the user selects a different grain
- **THEN** the available window options update to the configured windows for that grain
- **AND** the portal fetches `/api/usage/timeseries` with the selected grain and window

#### Scenario: Spend logs use Beijing time labels
- **WHEN** LiteLLM spend logs return UTC timestamps for minute or hour usage
- **THEN** the portal aggregates and labels usage buckets in `Asia/Shanghai`
- **AND** the public timeseries payload exposes bucket `start`, `end`, and `label` values in UTC+8

### Requirement: Cancellable React-owned usage loading
The usage panel SHALL cancel in-flight usage timeseries requests when a newer selection is made and SHALL only render the latest request result.

#### Scenario: User switches usage controls quickly
- **WHEN** the user changes the usage selection multiple times before earlier requests resolve
- **THEN** earlier requests are aborted or ignored
- **AND** only the latest request updates the usage metrics, chart, and table

#### Scenario: Usage data is loading or unavailable
- **WHEN** usage data is loading, empty, or fails
- **THEN** the panel uses Kumo-compatible loading, empty, or semantic error states without custom inline styles

### Requirement: Kumo API Key table and creation
The portal SHALL render API Keys through a React/Kumo table, SHALL show existing keys as masked non-copyable text, and SHALL provide authenticated key creation.

#### Scenario: API keys are loaded
- **WHEN** dashboard data includes API keys
- **THEN** the API Keys section renders a Kumo-backed table with key aliases, masked display keys, models, spend, budget, and expiry
- **AND** existing masked key values do not expose a copy action

#### Scenario: Key has many models
- **WHEN** an API key has more models than the compact preview limit
- **THEN** the row provides a Kumo `Collapsible` detail control for the full model list

#### Scenario: Authenticated user creates a key
- **WHEN** an authenticated, registered LiteLLM user submits a key alias and optional model, budget, or duration settings
- **THEN** the portal creates the key through LiteLLM using the authenticated user's resolved LiteLLM user id
- **AND** the raw key is shown only in the immediate creation result dialog
- **AND** user-controlled request body fields cannot override the authenticated LiteLLM user id

### Requirement: Kumo global error banner
The portal SHALL render page-level load errors through a Kumo `Banner` React island instead of a vanilla `div` error banner.

#### Scenario: Dashboard request fails
- **WHEN** the initial dashboard request fails
- **THEN** the portal dispatches a page error event
- **AND** the Kumo error banner appears with `role="alert"` semantics or equivalent accessible alert behavior

### Requirement: Kumo semantic dark mode
The portal SHALL support light and dark mode using Kumo semantic tokens and the document `data-mode` attribute.

#### Scenario: User toggles theme
- **WHEN** the user activates the theme toggle
- **THEN** the document `data-mode` switches between `light` and `dark`
- **AND** the chosen value is persisted for future visits

#### Scenario: User has no saved theme
- **WHEN** the portal loads without a saved preference
- **THEN** the initial mode follows `prefers-color-scheme` when available and falls back to light mode

### Requirement: Safe cache headers for non-fingerprinted assets
The portal SHALL NOT serve non-fingerprinted `/portal.js` or `/kumo.css` with immutable long-term cache headers.

#### Scenario: Portal JavaScript is requested
- **WHEN** the browser requests `/portal.js`
- **THEN** the response requires revalidation or has a short cache lifetime
- **AND** it does not include `immutable`

#### Scenario: Kumo stylesheet is requested
- **WHEN** the browser requests `/kumo.css`
- **THEN** the response requires revalidation or has a short cache lifetime
- **AND** it does not include `immutable`

### Requirement: Bundle guardrails and chart migration decision
The portal SHALL provide a repeatable bundle analysis command and SHALL document chart migration decisions when Kumo chart adoption would increase the app bundle materially.

#### Scenario: Developer analyzes the portal bundle
- **WHEN** the developer runs the LiteLLM portal bundle analysis command
- **THEN** it produces a bundle size summary for the generated portal app bundle

#### Scenario: Chart library migration is evaluated
- **WHEN** Kumo Chart/ECharts migration is considered
- **THEN** the design documentation records whether the migration is accepted or deferred based on bundle evidence
