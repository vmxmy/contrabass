## 1. OpenSpec and design guardrails

- [x] 1.1 Create a dedicated OpenSpec change for Kumo Chart replacement and expanded chart interaction.
- [x] 1.2 Verify the change is apply-ready before implementation.

## 2. Kumo Chart migration

- [x] 2.1 Replace the Recharts usage chart implementation with Kumo `TimeseriesChart` and granular ECharts registration.
- [x] 2.2 Convert portal timeseries points into Kumo timestamp/value series while preserving current empty/loading behavior.
- [x] 2.3 Wire chart accessibility, dark-mode state, formatting, and chart-native range callback props.

## 3. Usage interaction redesign

- [x] 3.1 Redesign time range and time grain controls as a compact responsive control rail with desktop side-by-side layout.
- [x] 3.2 Synchronize supported chart-native time range changes back into the usage request state.
- [x] 3.3 Remove any now-redundant styling or layout assumptions from the old two-form design.

## 4. Verification and documentation

- [x] 4.1 Update React component tests for Kumo Chart integration and compact control behavior.
- [x] 4.2 Run targeted LiteLLM portal tests and build checks.
- [x] 4.3 Update `src/litellm-portal/DESIGN.md` with final Kumo Chart migration notes and measured impact.
- [x] 4.4 Validate the OpenSpec change strictly so it is archive-ready.
