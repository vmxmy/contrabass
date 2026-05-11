## 1. OpenSpec and documentation

- [x] 1.1 Create an OpenSpec change for Kumo UX upgrades with proposal, design, tasks, and requirements.
- [x] 1.2 Correct `DESIGN.md` Kumo package version/current-latest note and add the chart/bundle migration decision.

## 2. Kumo React component migration

- [x] 2.1 Replace native usage grain/window controls with a React usage panel that uses Kumo `Select` granular imports.
- [x] 2.2 Keep usage timeseries requests cancellable and ensure only the latest selection can update the panel.
- [x] 2.3 Render usage loading, empty, and error states with Kumo-owned components or Kumo semantic states.
- [x] 2.4 Render API Keys through a React/Kumo table with non-copyable masked keys and collapsible model detail.
- [x] 2.5 Replace the global vanilla error banner with a Kumo `Banner` React island.
- [x] 2.6 Keep authenticated API Key creation with resolved LiteLLM user ownership and immediate raw-key copy flow.

## 3. Theme, cache, and bundle guardrails

- [x] 3.1 Add a persisted light/dark mode toggle using Kumo `data-mode` semantic tokens.
- [x] 3.2 Remove immutable long-term caching from non-fingerprinted `/portal.js` and `/kumo.css` responses.
- [x] 3.3 Add a repeatable bundle analysis command for the LiteLLM portal app.

## 4. Verification

- [x] 4.1 Add/update React component tests for usage controls, API key copy UI, error banner, and dark-mode scaffolding.
- [x] 4.2 Add/update Worker HTML tests for Kumo island roots, no native usage selects, cache headers, and no custom style blocks.
- [x] 4.3 Run targeted tests for `src/litellm-portal` and full type/build checks required by this change.
- [x] 4.4 Validate the OpenSpec change strictly so the spec can be archived.
- [x] 4.5 Add spend-log timezone regression coverage for UTC input rendered as UTC+8 usage buckets.
