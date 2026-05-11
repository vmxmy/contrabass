## ADDED Requirements

### Requirement: Portal forms use kumo Field for labelling
Every form control in the portal SHALL be wrapped in `<Field>` from `@cloudflare/kumo/components/field`, providing label, optional description, and error rendering.

#### Scenario: Required field shows validation error
- **WHEN** the user submits CreateKey with an empty required field
- **THEN** the Field MUST display the error message returned by Zod
- **AND** the surrounding Input MUST be marked invalid by the kumo Field markup

#### Scenario: Optional field rendered as such
- **WHEN** a field is declared optional in the form schema
- **THEN** the Field label MUST include the kumo "(optional)" indicator

### Requirement: Multi-select inputs use kumo Combobox
Form controls that accept multiple selections SHALL use `Combobox.Root` with `TriggerInput`/`Chip` instead of an HTML `<select multiple>` or hand-rolled checkbox grid.

#### Scenario: User adds and removes model selections
- **WHEN** the user picks a model from the dropdown and then removes it via its chip
- **THEN** the form state MUST update without page reload
- **AND** the dropdown MUST be filterable by typed text

### Requirement: Newly created secrets use kumo SensitiveInput
When the CreateKey mutation returns a freshly generated key, the result dialog SHALL display the key using `SensitiveInput` (masked by default, reveal-on-click, with built-in copy button).

#### Scenario: New key is masked on first display
- **WHEN** the create-key success dialog renders the new secret
- **THEN** the value MUST be masked initially
- **AND** the user MUST be able to reveal or copy it without exposing it elsewhere
