## ADDED Requirements

### Requirement: Dashboard deployed on Cloudflare Pages
The system SHALL deploy `packages/dashboard` to a Cloudflare Pages project. Builds SHALL use the existing Bun build pipeline (`bun run --cwd packages/dashboard build`) and SHALL emit static assets that Pages serves over its CDN.

#### Scenario: Push to main triggers Pages deploy
- **WHEN** a commit lands on `main` that touches `packages/dashboard/**`
- **THEN** the Pages CI builds the SPA via Bun and deploys it to the production Pages environment

#### Scenario: Pull request gets a preview URL
- **WHEN** a pull request changes `packages/dashboard/**`
- **THEN** Pages builds and publishes a preview URL on the PR for review

### Requirement: Landing site deployed on Cloudflare Pages
The system SHALL deploy `packages/landing` (Astro) to a separate Cloudflare Pages project using `bun run --cwd packages/landing build`. The landing project SHALL continue to render `README.md` as its primary content.

#### Scenario: README change triggers landing rebuild
- **WHEN** a commit changes `README.md`
- **THEN** the landing Pages project rebuilds and republishes

### Requirement: API base URL configured at build time
The dashboard build SHALL read `VITE_CONTRABASS_API_BASE` (or equivalent) at build time to point at the API Worker URL. The default for the production Pages environment SHALL be the production API Worker; preview environments MAY override to a staging Worker.

#### Scenario: Production build targets production API
- **WHEN** the production Pages build runs
- **THEN** the SPA's API client points at `https://api.contrabass.dev` (or the documented production hostname)

#### Scenario: Preview build targets staging API
- **WHEN** a PR preview build runs with `VITE_CONTRABASS_API_BASE=https://api.staging.contrabass.dev`
- **THEN** the resulting bundle calls staging endpoints

### Requirement: Authenticated API access
The dashboard SHALL authenticate to the API Worker using the user's session token obtained from a login flow (initial implementation: GitHub OAuth via the API Worker; future: more providers). Tokens SHALL be stored in `httpOnly` cookies set by the API Worker, not in `localStorage`.

#### Scenario: Anonymous user opens the dashboard
- **WHEN** an unauthenticated user loads the dashboard
- **THEN** the SPA renders a login screen and initiates the OAuth flow on action

#### Scenario: Authenticated request to API
- **WHEN** the SPA calls a protected API endpoint
- **THEN** the browser sends the `httpOnly` session cookie automatically and the API Worker validates it

### Requirement: WebSocket subscription for live updates
The dashboard SHALL open a WebSocket connection to `/v1/teams/{teamId}/subscribe` for the active team and SHALL render `board-update`, `run-event`, `worker-status`, and `config-changed` frames in real time. The connection SHALL automatically reconnect with exponential backoff up to 30s on disconnect, presenting a "reconnecting..." indicator if down for more than 5s.

#### Scenario: User switches active team
- **WHEN** the user selects a different team from the team picker
- **THEN** the SPA closes the existing WS, opens a new one to `/v1/teams/{newTeamId}/subscribe`, and refreshes board/run state

#### Scenario: Network blip
- **WHEN** the WS drops for 2 seconds and reconnects
- **THEN** the SPA reconnects with `last_event_id`, replays missed events from the team coordinator's ring buffer, and the user observes no apparent loss

### Requirement: SPA / API version skew protection
The API Worker SHALL include `X-Contrabass-Api-Version` on every response. The SPA SHALL refuse to talk to an incompatible major version and SHALL prompt the user to reload the page.

#### Scenario: API ships a new major version while SPA tab is open
- **WHEN** the API responds with a major version higher than the SPA was built against
- **THEN** the SPA shows a non-dismissible banner "A new dashboard version is available — reload to continue" and disables mutations until reload

### Requirement: Embedded dashboard binary path retained for local-only mode
The Go binary's `embed_dashboard.go` and `internal/web` SHALL remain functional under the `localonly` build tag and SHALL serve the dashboard SPA from `embed.FS` when `contrabass server --local-only` runs. The default cloud-mode binary SHALL NOT include the embedded dashboard assets.

#### Scenario: Local-only build serves embedded dashboard
- **WHEN** built with `make build LOCAL_ONLY=1` and run as `contrabass server --local-only --port 8080`
- **THEN** `http://localhost:8080/` serves the dashboard SPA from `embed.FS`

#### Scenario: Default cloud-mode build excludes dashboard assets
- **WHEN** built with `make build` (no `localonly` tag)
- **THEN** the binary's `embed.FS` for the dashboard is empty and `internal/web` is not compiled in

### Requirement: Per-team subdomain or path routing
The system SHALL route per-team API and dashboard traffic by team identifier. Initial implementation MAY use a path prefix (`/t/{teamId}/...` on the dashboard, `/v1/teams/{teamId}/...` on the API) and MAY add subdomain-per-team (`<team>.contrabass.dev`) later without changing the API contract.

#### Scenario: User navigates to a team
- **WHEN** the user clicks a team in the team picker
- **THEN** the URL becomes `/t/{teamId}/board` and all subsequent API calls scope to `teamId`
