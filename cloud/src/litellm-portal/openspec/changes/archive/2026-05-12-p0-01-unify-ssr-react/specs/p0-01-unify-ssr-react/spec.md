## ADDED Requirements

### Requirement: Portal HTML is rendered by React SSR
The LiteLLM portal SHALL render its full HTML response on the Worker via `react-dom/server`, replacing the string-template `html.ts` and emitting a single React hydration root on the client.

#### Scenario: Authenticated GET / returns SSR HTML
- **WHEN** an authenticated user requests `GET /`
- **THEN** the response body MUST be HTML produced by `renderToString` from a top-level React `<App>` component
- **AND** the body MUST NOT include any inline `<script>` block longer than the FOUC-prevention helper

#### Scenario: Worker no longer imports html.ts string template
- **WHEN** the portal Worker bundle is built
- **THEN** the bundle MUST NOT include the `renderPortalHtml(env)` string template export
- **AND** `src/litellm-portal/html.ts` MUST be removed from the source tree

### Requirement: Initial dashboard data is prefilled by SSR
The portal SHALL embed the result of the `/api/dashboard` handler in the SSR response so the first paint shows data without a client-side fetch.

#### Scenario: First paint shows data state
- **WHEN** an authenticated user loads the portal cold
- **THEN** the served HTML MUST already include hero stats, teams, models, and keys content rendered from server-resolved data
- **AND** the browser MUST NOT issue a `/api/dashboard` request before hydration completes

#### Scenario: Failed SSR data load degrades gracefully
- **WHEN** SSR dashboard data resolution throws
- **THEN** the response MUST still render the shell with an error banner and a client-side retry hook
- **AND** the HTTP status MUST remain 200

### Requirement: Inline JavaScript event bridge is removed
The portal client SHALL receive state through React props and context only, with no `litellm-portal:*` CustomEvents and no `window.__litellmPortal*` globals.

#### Scenario: Client bundle has no CustomEvent dispatchers
- **WHEN** the portal client bundle is built
- **THEN** the bundle source MUST NOT contain string references to `litellm-portal:keys`, `:teams`, `:models`, `:stats`, `:error`, or `:refresh`
- **AND** the bundle MUST NOT read or write any `window.__litellmPortal*` property
