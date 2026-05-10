## Why

The LiteLLM portal still uses Recharts for the primary usage graph while the rest of the page is moving toward Kumo primitives and semantic tokens. This leaves chart interaction, accessibility, and visual consistency behind the rest of the Kumo migration.

The current time range and time grain controls also spend too much desktop space as two separate form fields. Moving chart interaction into the native Kumo time-series surface gives users a larger exploration area and reduces duplicate controls.

## What Changes

- Replace the portal usage line chart with Kumo Chart / `TimeseriesChart` using granular Kumo chart imports and explicit ECharts module registration.
- Convert usage timeseries data to Kumo's timestamp/value series shape while preserving the existing `/api/usage/timeseries` contract.
- Rework the time range and time grain interaction so desktop users get a compact side-by-side control rail and chart-native range exploration instead of two stacked form rows.
- Allow Kumo chart native interactions to drive the visible time window when available, with clear synchronization back to the usage request state.
- Preserve UTC+8 usage labels, dark-mode token behavior, loading/error/empty states, and identity-safe data handling.
- Document bundle and interaction trade-offs in `DESIGN.md` after implementation measurements.

## Capabilities

### New Capabilities
- `litellm-portal-kumo-chart-interactions`: Covers Kumo Chart-backed usage visualization and expanded chart-native time exploration for the LiteLLM portal.

### Modified Capabilities


## Impact

- Updates `cloud/src/litellm-portal/chart.tsx` to render Kumo Chart instead of Recharts.
- Updates `cloud/src/litellm-portal/app.tsx` usage panel controls and state synchronization.
- Updates `cloud/src/litellm-portal/app.generated.ts` through the LiteLLM portal build pipeline.
- Updates tests in `cloud/src/litellm-portal/app.test.tsx` and related Worker/API tests if needed.
- Updates package dependencies/scripts only if Kumo Chart requires additional explicit runtime dependencies.
- Updates `cloud/src/litellm-portal/DESIGN.md` with the final migration decision and measured verification notes.
