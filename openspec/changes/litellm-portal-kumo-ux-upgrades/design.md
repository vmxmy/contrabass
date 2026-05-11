## Context

The LiteLLM portal intentionally uses Kumo CSS tokens and a quiet institutional dashboard style. Its current architecture is a Cloudflare Worker-rendered HTML template with a few React islands. This makes it cheap to serve and safe for read-only data, but the most interactive widgets still live in inline vanilla JS.

`DESIGN.md` identifies six upgrade directions: Kumo Select, dark mode, loading states, error display, row expansion, and safe key management. During planning, two technical guardrails were added: non-fingerprinted asset cache safety and bundle-size awareness before additional Kumo/chart migrations.

## Goals / Non-Goals

**Goals:**

- Keep the Worker shell and React island architecture; do not rewrite the portal as a full SPA.
- Use Kumo granular imports for new React components.
- Make usage controls keyboard-accessible through Kumo `Select`.
- Make API Key table rendering Kumo-backed while keeping masked keys non-copyable.
- Add a semantic-token dark mode toggle with persistence.
- Replace global error rendering with a Kumo `Banner` island.
- Avoid immutable caching for non-fingerprinted assets.
- Add a bundle-analysis path and document why Kumo Chart/ECharts is not yet replacing Recharts.
- Preserve existing identity isolation and keep key creation bound to the authenticated LiteLLM user.

**Non-Goals:**

- Rotating, editing, or deleting LiteLLM API keys.
- Replacing the entire Worker template with client-side routing.
- Introducing a second visual design language or custom style block.
- Exposing raw API keys, LiteLLM master credentials, prompts, or responses.

## Decisions

1. **React islands over SPA rewrite**
   - Decision: Add targeted islands (`usage-panel`, `keys`, `error`) while preserving the Worker-rendered shell.
   - Rationale: Most data is still server-owned and read-only. Islands reduce vanilla DOM code without taking on SPA routing/hydration complexity.

2. **Kumo Select owns usage selection**
   - Decision: The usage panel becomes React-owned and fetches `/api/usage/timeseries` itself with `AbortController`.
   - Rationale: This gives Kumo Select full control and removes DOM-select coupling from the inline Worker script.

3. **Masked key display stays non-copyable**
   - Decision: Render masked keys as plain monospace text inside the React/Kumo API Keys table.
   - Rationale: The portal does not transmit full existing keys, so copying masked values is misleading. Full key copying is limited to the immediate create-key result dialog.

4. **Banner before Dialog for global errors**
   - Decision: Use Kumo `Banner` for non-blocking portal load errors. Reserve Dialog for future blocking confirmations.
   - Rationale: The portal is read-only; a persistent inline alert is calmer and avoids modal interruption.

5. **Dark mode via `data-mode`**
   - Decision: Use `document.documentElement.dataset.mode`, persisted to localStorage and initialized from user preference.
   - Rationale: Kumo standalone CSS already defines light/dark token values for `data-mode`.

6. **No immutable cache on plain asset URLs**
   - Decision: Use revalidation cache headers for `/portal.js` and `/kumo.css` until filenames are fingerprinted.
   - Rationale: The route paths are stable across deploys, so long immutable caching is unsafe.

7. **Defer Kumo Chart migration after bundle spike**
   - Decision: Keep the current Recharts line chart for this change and record the measured Kumo Chart/ECharts spike.
   - Rationale: Importing Kumo chart through `@cloudflare/kumo/components/chart` pulled a larger bundle in the local spike; migration should wait for a granular chart entrypoint or a separate budgeted change.

## Risks / Trade-offs

| Risk | Mitigation |
|------|------------|
| More React islands increase bundle size | Add bundle analysis script and keep imports granular |
| Moving usage fetch into React could diverge from dashboard summary | Keep the same `/api/usage/timeseries` endpoint and existing response shape |
| Dark mode token coverage may miss chart tooltip styles | Chart reads CSS variables and tests verify `data-mode` scaffolding |
| Masked existing keys cannot be copied | Full existing secrets are intentionally not available in the browser; only newly created raw keys appear once in the result dialog |
| Kumo components may render portals outside island containers | Use document-level Kumo CSS and avoid shadow DOM containers |
