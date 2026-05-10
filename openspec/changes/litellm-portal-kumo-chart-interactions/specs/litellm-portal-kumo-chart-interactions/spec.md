## ADDED Requirements

### Requirement: Kumo Chart usage visualization
The LiteLLM portal usage dashboard SHALL render usage timeseries data with Kumo Chart instead of Recharts while preserving the existing usage API contract.

#### Scenario: Usage data renders through Kumo Chart
- **WHEN** the usage panel receives non-empty timeseries data from `/api/usage/timeseries`
- **THEN** it MUST provide timestamp/value series data to a Kumo timeseries chart without requiring server response shape changes

#### Scenario: Empty usage data remains understandable
- **WHEN** the usage panel receives no timeseries points
- **THEN** it MUST show the existing empty-state message instead of rendering an empty chart shell

### Requirement: Expanded time exploration controls
The usage dashboard SHALL provide a compact responsive control rail and chart-native time range exploration without reducing keyboard-accessible explicit controls.

#### Scenario: Desktop controls are compact
- **WHEN** the usage dashboard is rendered on a desktop-width layout
- **THEN** the time range and time grain controls MUST be presented side-by-side in a compact area above or beside the chart

#### Scenario: Preset range remains selectable
- **WHEN** a user changes the explicit time range control
- **THEN** the usage panel MUST fetch timeseries data for the selected preset range and keep the selected range visible

#### Scenario: Chart-native range updates request state
- **WHEN** the Kumo chart reports a time range that maps to a supported preset
- **THEN** the usage panel MUST update the selected range and refresh usage data for that preset

### Requirement: Kumo chart accessibility and theme integration
The Kumo chart migration SHALL preserve portal accessibility, dark-mode compatibility, and loading/error behavior.

#### Scenario: Chart exposes accessible context
- **WHEN** the usage chart renders with data
- **THEN** it MUST provide an accessible description of the token usage timeseries

#### Scenario: Dark mode remains supported
- **WHEN** the portal is in dark mode
- **THEN** the chart MUST receive dark-mode state or token-compatible styling so it remains legible

#### Scenario: Loading and error states are preserved
- **WHEN** the usage request is loading or fails
- **THEN** the usage panel MUST continue to show the existing Kumo-backed loading or error states without chart interaction breaking the panel
