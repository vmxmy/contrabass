## ADDED Requirements

### Requirement: Vitest enforces zero axe violations
Every React component test in the portal SHALL run `axe(container)` after rendering and assert zero accessibility violations.

#### Scenario: Component test fails on a11y regression
- **WHEN** a component is changed in a way that introduces a missing label or insufficient contrast
- **THEN** the test MUST fail with the specific axe rule names
- **AND** CI MUST mark the suite red

### Requirement: All user-facing strings come from i18n catalog
The portal SHALL extract every visible string into a typed message catalog (lingui or formatjs); inline string literals in JSX/HTML SHALL be limited to non-localizable tokens (URLs, keys, numbers).

#### Scenario: Build extracts all messages
- **WHEN** the i18n extract command runs
- **THEN** the catalog MUST contain entries for every visible string in the rendered portal
- **AND** the build MUST fail if a JSX text node references an unextracted literal

### Requirement: Locale auto-detected with user override
The Worker SHALL pick the response locale from the user's persisted preference (P5-16), falling back to `Accept-Language`, and finally to `zh-CN`; the rendered HTML's `<html lang>` SHALL reflect the chosen locale.

#### Scenario: Accept-Language drives default locale
- **WHEN** a new user requests the portal with `Accept-Language: en-US`
- **THEN** the rendered HTML MUST set `lang="en"`
- **AND** all extracted strings MUST come from the English catalog

#### Scenario: Stored preference overrides header
- **WHEN** the user has a stored `language="zh-CN"` preference and the header asks for `en`
- **THEN** the rendered HTML MUST set `lang="zh-CN"`
- **AND** the catalog MUST be Chinese
