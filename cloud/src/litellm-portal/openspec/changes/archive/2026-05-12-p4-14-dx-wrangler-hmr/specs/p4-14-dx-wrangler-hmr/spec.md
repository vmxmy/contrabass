## ADDED Requirements

### Requirement: Dev server provides client HMR
The portal dev server SHALL provide hot module replacement for client-side code; saving an `app.tsx` change MUST update the running browser without a full reload and without restarting wrangler.

#### Scenario: Saving a component re-renders without reload
- **WHEN** a developer edits text inside a React component while `pnpm dev:litellm-portal` is running
- **THEN** the browser preview MUST reflect the change within 500 ms
- **AND** the page MUST NOT trigger a full reload

### Requirement: Custom Node dev server is removed
The repository SHALL no longer ship or invoke a custom local dev server (e.g., `/tmp/litellm-portal-real-local-server.mjs`); dev-time SSR SHALL run inside `wrangler dev`.

#### Scenario: Dev script invokes only wrangler + vite
- **WHEN** `pnpm dev:litellm-portal` is started
- **THEN** the spawned processes MUST be exactly the Vite dev server and `wrangler dev`
- **AND** there MUST be no script writing into `/tmp/litellm-portal-*`

### Requirement: Commit hooks run incremental gates
A pre-commit hook SHALL run incremental TypeScript, lint, and `vitest related` against staged files before allowing the commit to land; commit message hook SHALL enforce conventional commits.

#### Scenario: Type error blocks commit
- **WHEN** a developer stages a file that introduces a TypeScript error
- **THEN** the pre-commit hook MUST fail with the specific error
- **AND** the commit MUST NOT be created
