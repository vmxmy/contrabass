## ADDED Requirements

### Requirement: Portal text uses kumo Text variants
Portal headings, body copy, and monospace number cells SHALL render through `<Text variant="...">` from `@cloudflare/kumo/components/text`; hand-rolled Tailwind utility chains for typography (`text-3xl font-semibold text-kumo-strong` and similar) SHALL be removed from React components.

#### Scenario: Page heading renders as Text heading
- **WHEN** the portal renders the page-title element
- **THEN** the DOM MUST be a kumo Text with `variant="heading1"` or `variant="heading2"`
- **AND** the visual style MUST come from kumo CSS, not bespoke class chains

### Requirement: Budget visualization combines Meter and Badge
The accumulated-spend stat tile SHALL pair `<Meter>` (showing spend/budget progress) with the existing `BudgetBadge` status pill instead of relying on text + badge alone.

#### Scenario: Spend tile shows Meter and status badge
- **WHEN** the hero stats render for a user with a budget cap
- **THEN** the spend tile MUST include a kumo Meter rendering `spend / maxBudget`
- **AND** the badge MUST display the "正常" / "即将超支" / "超预算" tone status

#### Scenario: User without budget shows no Meter
- **WHEN** the user has no `maxBudget`
- **THEN** the spend tile MUST omit the Meter
- **AND** the badge MUST be hidden

### Requirement: Recessed surfaces use kumo Surface
Nested visual layers inside cards (audit row detail, model list expansion) SHALL use `<Surface>` from `@cloudflare/kumo/components/surface` instead of hand-rolled `bg-kumo-recessed` divs.

#### Scenario: Audit detail row uses Surface
- **WHEN** an audit-event row is expanded
- **THEN** the body MUST be wrapped in a kumo Surface element
- **AND** the surface MUST adopt dark/light tokens automatically
