## 1. Core Adapter

- [x] 1.1 Create `cloud/src/poller/plane.ts` with `PlanePollIssue` type, `PlaneRateLimitError` class, `PlaneClient` class, and `planeAdapter` export satisfying `PollerAdapter`
- [x] 1.2 Implement `PlaneClient.fetchIssues` — GET issues with offset pagination, exclude terminal states (completed/cancelled), normalize to `PlanePollIssue[]`
- [x] 1.3 Implement `PlaneClient.fetchProjectStates` — GET project states, build state-group lookup map (backlog/unstarted/started/completed/cancelled)
- [x] 1.4 Implement `normalizePlaneIssue` — map Plane API fields to `PlanePollIssue` (id, external_id, identifier from sequence_id, state from state group, branch_name, tracker_meta with provider "plane")
- [x] 1.5 Implement config resolution (`planeAdapterConfigFromInvocation`) — read from `tracker.plane:` YAML block (host, workspace_slug, project_id, api_key), fall back to `tracker:` level
- [x] 1.6 Implement token resolution (`resolvePlaneToken`) — YAML api_key with `$` env ref support, then env binding fallback chain: `TRACKER_{TEAM}_PLANE_API_KEY`, `TRACKER_PLANE_API_KEY`, `PLANE_API_KEY`
- [x] 1.7 Implement `postIssuesToTeamCoordinator` — POST normalized issues to TeamCoordinator DO `/board/refresh` with `x-contrabass-source: tracker-poller-plane`

## 2. Registration

- [x] 2.1 Add `"plane"` to `PollerAdapterName` union type in `cloud/src/poller/index.ts`
- [x] 2.2 Add `plane: planeAdapter` to `DEFAULT_ADAPTERS` map in `cloud/src/poller/index.ts`
- [x] 2.3 Update `adapterNameFromKey` in `cloud/src/poller/index.ts` to recognize `"plane"`
- [x] 2.4 Add `"plane"` to `TRACKER_SECRET_PROVIDERS` in `cloud/src/secrets/tracker.ts`
- [x] 2.5 Add `import { planeAdapter } from "./plane"` to `cloud/src/poller/index.ts`

## 3. Tests

- [x] 3.1 Create `cloud/src/poller/plane.test.ts` with test helpers: mock Plane API server responses, mock TeamCoordinator DO, mock env bindings
- [x] 3.2 Add tests for `fetchIssues` — success with multiple issues, empty result, offset pagination, HTTP error responses
- [x] 3.3 Add tests for `normalizePlaneIssue` — verify field mapping, state group to poller state conversion, model override extraction
- [x] 3.4 Add tests for `fetchProjectStates` — success, empty states
- [x] 3.5 Add tests for `resolvePlaneToken` — YAML api_key with env ref, fallback chain, missing token error
- [x] 3.6 Add tests for `PlaneRateLimitError` — 429 response with Retry-After header triggers backoff
- [x] 3.7 Add tests for `enabledTrackersFromConfig` — `type: plane`, `plane:` sub-key, combined with other trackers
