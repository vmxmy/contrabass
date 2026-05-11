## Why

The usage panel still exposes time range and time grain as two form-like controls. Even after moving them side-by-side, common dashboard actions require opening a select and thinking in implementation terms (`window` + `grain`) instead of simply choosing the view the user wants.

A preset rail can make common usage exploration a one-click action while preserving bounded API requests and advanced grain control when needed.

## What Changes

- Replace the primary time range dropdown with a single-click preset rail built from the existing configured usage windows.
- Add an `Auto` grain mode that maps each preset range to its recommended grain by default.
- Keep manual grain selection available as one-click chips instead of a dropdown.
- Preserve the existing `/api/usage/timeseries?grain=...&window=...` API contract.
- Keep Kumo Chart brush synchronization, snapping chart ranges to presets and respecting auto/manual grain behavior.
- Update tests and design notes for the new one-click interaction model.

## Capabilities

### New Capabilities
- `litellm-portal-preset-time-rail`: Covers one-click usage time presets, auto grain selection, and manual grain chips for the LiteLLM portal usage dashboard.

### Modified Capabilities

## Impact

- Updates `cloud/src/litellm-portal/app.tsx` usage panel state and controls.
- Updates `cloud/src/litellm-portal/app.test.tsx` and `index.test.ts` expectations around time controls.
- Regenerates `cloud/src/litellm-portal/app.generated.ts` via the existing portal build pipeline.
- Updates `cloud/src/litellm-portal/DESIGN.md` with the approved preset rail interaction model.
