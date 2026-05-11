## ADDED Requirements

### Requirement: One-click time preset rail
The LiteLLM portal usage dashboard SHALL expose configured time windows as one-click preset controls instead of requiring a dropdown for primary range selection.

#### Scenario: User selects a range preset
- **WHEN** a user clicks a time preset control
- **THEN** the usage panel MUST fetch `/api/usage/timeseries` with the selected preset window and a valid grain

#### Scenario: Presets reflect configuration
- **WHEN** the portal config provides usage windows grouped by grain
- **THEN** the preset rail MUST render those configured windows without introducing arbitrary custom windows

### Requirement: Automatic and manual grain control
The usage dashboard SHALL default to automatic grain selection while allowing manual grain override through one-click controls.

#### Scenario: Auto grain follows the selected preset
- **WHEN** the user selects a preset while grain mode is automatic
- **THEN** the usage panel MUST use the configured grain associated with that preset

#### Scenario: Manual grain remains one-click
- **WHEN** a user clicks a manual grain control
- **THEN** the usage panel MUST fetch data for that grain when the current window is valid for it

#### Scenario: Invalid manual grain falls back safely
- **WHEN** a selected preset is not available for the current manual grain
- **THEN** the usage panel MUST fall back to the preset's automatic grain and keep the API request valid

### Requirement: Chart brush stays synchronized
The Kumo Chart brush interaction SHALL synchronize to the same preset and grain rules as explicit preset clicks.

#### Scenario: Brush maps to supported preset
- **WHEN** Kumo Chart reports a selected time range that maps to a supported preset
- **THEN** the usage panel MUST update the active preset and fetch data using auto or valid manual grain behavior

#### Scenario: Brush does not map to supported preset
- **WHEN** Kumo Chart reports a selected time range that does not map to a supported preset
- **THEN** the usage panel MUST keep the current request state and show a non-blocking hint
