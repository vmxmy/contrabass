## Why

`src/litellm-portal/DESIGN.md` now documents the gap between the portal's Kumo token usage and its limited Kumo React component usage. The current Worker template still owns interactive controls, loading placeholders, and errors through vanilla DOM code. This limits accessibility, dark-mode readiness, and design consistency.

The portal also serves non-fingerprinted `/portal.js` and `/kumo.css` assets with immutable long-term caching, which can strand users on stale UI code after deploys. Finally, chart/package direction needs an explicit bundle baseline before adding more Kumo components.

## What Changes

- Move high-ROI interactive portal regions into React islands that use Kumo granular component imports.
- Replace native usage `<select>` controls with Kumo `Select` and keep the bounded usage API contract intact.
- Render API Keys through a Kumo `Table` with masked key text, collapsible model detail, and a dedicated create-key action.
- Add a Kumo `Banner`-based error island and Kumo loading states for React-owned regions.
- Add light/dark mode switching through Kumo semantic tokens and `data-mode` persistence.
- Fix non-fingerprinted asset cache headers and add a repeatable bundle analysis path.
- Capture the Kumo chart migration decision with measured bundle evidence instead of adding a heavier chart bundle.

## Capabilities

### New Capabilities
- `litellm-portal-kumo-ux-upgrades`: Covers Kumo component adoption, dark mode, accessible feedback, cache safety, and bundle guardrails for the LiteLLM portal.

### Modified Capabilities
- `litellm-portal-usage-dashboard`: The existing dashboard remains identity-safe while gaining Kumo component-backed interactive UI behavior and authenticated key creation.

## Impact

- Updates Cloudflare Worker-rendered portal HTML under `cloud/src/litellm-portal/html.ts`.
- Expands React portal code under `cloud/src/litellm-portal/app.tsx` and `chart.tsx`.
- Updates tests under `cloud/src/litellm-portal/app.test.tsx` and `index.test.ts`.
- Updates package scripts/build tooling for bundle analysis.
- Updates `src/litellm-portal/DESIGN.md` Kumo integration guidance with verified package/version and chart migration decision.
