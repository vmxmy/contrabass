## Context

The portal already uses Kumo CSS tokens and React islands for the usage panel, key table, error banner, and theme switching. The usage chart remains a Recharts island because the prior change intentionally deferred Kumo Chart after a bundle spike.

This change intentionally isolates the chart migration from the broader Kumo UX work. The goal is not only library replacement: Kumo `TimeseriesChart` has native time-range interaction hooks, ARIA metadata, dark-mode integration, and series conventions that let the page move away from a cramped pair of select fields toward a larger chart-first exploration surface.

## Goals / Non-Goals

**Goals:**

- Replace the Recharts usage chart with Kumo `TimeseriesChart` through `@cloudflare/kumo/components/chart`.
- Register only the ECharts modules needed for the portal's single-series usage chart.
- Preserve the current server API, usage summary cards, UTC+8 bucket labels, loading states, and error behavior.
- Keep explicit time range and grain selection available, but compress their layout and allow Kumo chart-native time-window interaction to update the visible range when supported.
- Improve desktop information density so the controls do not force the chart lower on large screens.
- Record measured bundle/build impact in `DESIGN.md`.

**Non-Goals:**

- Changing `/api/usage/timeseries` request or response semantics.
- Adding multi-metric chart series beyond the current token usage line.
- Replacing the API Keys, create-key, or theme islands.
- Introducing custom chart gestures that duplicate Kumo/ECharts native behavior.

## Decisions

1. **Use `TimeseriesChart` instead of generic `Chart`**
   - Decision: Render the usage visualization with Kumo `TimeseriesChart` because the data is time-indexed and the component exposes time-range callbacks.
   - Alternative: Use generic `Chart` and hand-write ECharts options. This gives more control but gives up the Kumo abstraction this migration is meant to adopt.

2. **Keep the API contract and transform client-side**
   - Decision: Convert `{ label, tokens }` points into Kumo `{ name, data: [[timestampMs, tokens]], color }` series in `chart.tsx`.
   - Alternative: Change the Worker API to return chart-specific data. That would unnecessarily couple the server to one UI library.

3. **Register a narrow ECharts surface**
   - Decision: Import ECharts core and register line chart, grid, tooltip, data zoom, renderer, and accessibility/transform features as needed by `TimeseriesChart`.
   - Alternative: Import all of ECharts. That is simpler but defeats the bundle guardrail.

4. **Compact controls plus chart-native exploration**
   - Decision: Replace the two stacked form groups with a compact, responsive control rail and let chart time-range interaction update the requested range when it maps to a supported preset.
   - Alternative: Remove explicit controls completely. That would make bookmarked/preset comparisons less discoverable and harder to test.

5. **Kumo interaction is progressive enhancement**
   - Decision: If chart-native time-range interaction is unavailable in test or fallback environments, the explicit controls remain the authoritative selection path.
   - Alternative: Require chart interaction for range changes. That would risk accessibility regressions and brittle tests.

## Risks / Trade-offs

| Risk | Mitigation |
|------|------------|
| Kumo Chart/ECharts increases bundle size | Use granular imports, measure `build:litellm-portal`, and document the result |
| `TimeseriesChart` callback range may not align exactly to 7d/30d/90d presets | Snap only to known presets within tolerance and otherwise keep the selected preset unchanged |
| Visual defaults differ from the current Recharts line | Preserve portal card spacing/tokens and add tests for labels/states instead of pixel coupling |
| JSDOM lacks browser APIs used by ECharts | Mock Kumo Chart in component tests and verify data/props integration through accessible output |
| Chart interaction could obscure control state | Keep selected range/grain visible in the compact control rail |

## Migration Plan

- Implement the chart component behind the existing `UsageChart` export so callers do not change shape more than necessary.
- Update the usage panel control layout and event handling.
- Update tests to assert Kumo chart usage, compact control behavior, and range callback synchronization.
- Run targeted tests, build, and strict OpenSpec validation.
- Rollback is a single-component revert to the previous Recharts implementation if bundle or runtime behavior is unacceptable.

## Open Questions

- None for initial implementation; bundle size and visual QA are acceptance checks rather than design blockers.
