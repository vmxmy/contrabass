## Context

The LiteLLM portal now uses Kumo Chart and React-owned usage controls. The current control rail still mirrors backend request parameters: time range and time grain are separate Select controls. The approved direction is a dashboard-first interaction: users click a range preset once, and the system chooses the right grain unless they explicitly override it.

The Worker usage API must remain bounded. The UI cannot send arbitrary brush ranges; it must continue to request configured `window` and `grain` pairs.

## Goals / Non-Goals

**Goals:**

- Make common range switching one click.
- Make the default grain automatic and explain the resulting active grain.
- Replace the manual grain dropdown with one-click chips.
- Keep chart brush behavior and map brush selections to supported presets.
- Preserve existing usage API request shape, loading/error states, dark mode, and Kumo visual language.

**Non-Goals:**

- Adding arbitrary custom date ranges.
- Changing server-side allowed windows or grain validation.
- Replacing Kumo Chart or changing usage aggregation semantics.

## Decisions

1. **Preset rail is primary**
   - Decision: Render every configured usage window as a pill button and use it as the primary time control.
   - Rationale: Users select intent (`近 30 天`) with one click instead of opening a dropdown.

2. **Auto grain is the default mode**
   - Decision: Track grain mode as `auto` or a manual grain. In auto mode, selected range maps to the grain that owns that configured window.
   - Rationale: Existing configuration already groups windows by valid/recommended grain.

3. **Manual grain chips are progressive enhancement**
   - Decision: Show `自动` plus available grain chips in a compact secondary rail.
   - Rationale: Advanced users retain control without making grain selection mandatory.

4. **Manual invalid combinations fall back safely**
   - Decision: When a user changes range while in manual mode, keep manual grain only if that range exists for the chosen grain; otherwise fall back to auto for that range.
   - Rationale: The API stays bounded to valid configured pairs and the UI avoids dead combinations.

5. **Brush sync reuses preset selection**
   - Decision: Brush range matching picks the nearest configured window, then applies the same auto/manual grain rules as a click.
   - Rationale: Chart-native exploration and explicit controls remain consistent.

## Risks / Trade-offs

| Risk | Mitigation |
|------|------------|
| Many configured presets could wrap awkwardly | Use flex-wrap pills and keep compact spacing |
| Users may not notice manual grain chips | Display active status text: `自动粒度：天` or `手动粒度：小时` |
| A manual grain may not support a selected window | Fall back to auto and show a short range hint |
| Tests can become coupled to Kumo Select internals | Use plain button semantics for rail/chips |
