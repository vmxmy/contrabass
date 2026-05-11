## Why

The cloud tracker poller (`cloud/src/poller/`) already supports Linear, GitHub, and internal-board adapters. Adding [Plane](https://plane.so) — an open-source project management tool gaining traction as a Linear/Jira alternative — lets teams self-host their tracker or use Plane Cloud while using contrabass's cloud control plane. The adapter runs as a Cloudflare Worker cron (1-minute interval), same as existing adapters.

## What Changes

- Add `cloud/src/poller/plane.ts` implementing the `PollerAdapter` interface via Plane's REST API
- Register `"plane"` in `PollerAdapterName` union type
- Register `"plane"` in `DEFAULT_ADAPTERS` map and `adapterNameFromKey`/`enabledTrackersFromConfig`
- Add `"plane"` to `TRACKER_SECRET_PROVIDERS` in `cloud/src/secrets/tracker.ts`
- Add Plane API token resolution from env bindings (same pattern as Linear/GitHub)
- Add rate-limit error class (`PlaneRateLimitError`) for backoff support
- Add tests for the Plane adapter

## Capabilities

### New Capabilities
- `plane-poller-adapter`: REST API adapter that maps Plane issues to `PollerIssue` — fetch by project/state, normalize to poller schema, POST to TeamCoordinator DO's `/board/refresh`

### Modified Capabilities
_(none — the PollerAdapter interface and TeamCoordinator contract are unchanged)_

## Impact

- **Code**: `cloud/src/poller/plane.ts` (new), `cloud/src/poller/index.ts` (type + registry), `cloud/src/secrets/tracker.ts` (provider list)
- **Dependencies**: No new npm packages — Plane REST API is plain JSON over `fetch`, same as existing adapters
- **Config**: New `tracker.type: plane` / `tracker.plane:` YAML block; new env binding `PLANE_API_KEY` or secret store key
- **Backward compatibility**: Fully additive — no breaking changes to existing adapters
