You are implementing ONE checkbox task from an OpenSpec change. Stay strictly within scope.

# Task 1.2 (epic: Worker protocol freeze (do first; cross-phase contract))

Generate Go types from those schemas under `internal/workerproto/v1/` and add `go generate` step

# Where to read

1. The change root: `openspec/changes/cloud-orchestrator-with-local-workers/`
2. Capability specs (read whichever ones the task touches):
  - openspec/changes/cloud-orchestrator-with-local-workers/specs/cloud-config-store/spec.md
  - openspec/changes/cloud-orchestrator-with-local-workers/specs/cloud-dashboard-hosting/spec.md
  - openspec/changes/cloud-orchestrator-with-local-workers/specs/cloud-issue-run/spec.md
  - openspec/changes/cloud-orchestrator-with-local-workers/specs/cloud-team-coordinator/spec.md
  - openspec/changes/cloud-orchestrator-with-local-workers/specs/cloud-tracker-poller/spec.md
  - openspec/changes/cloud-orchestrator-with-local-workers/specs/local-worker-daemon/spec.md
  - openspec/changes/cloud-orchestrator-with-local-workers/specs/worker-protocol/spec.md
3. `openspec/changes/cloud-orchestrator-with-local-workers/design.md` for decisions.
4. `openspec/changes/cloud-orchestrator-with-local-workers/tasks.md` for the surrounding task list. Read sibling tasks in epic 1 so you understand context, but ONLY implement task 1.2.
5. `CLAUDE.md` for repo-wide conventions.


## Repo conventions (from CLAUDE.md, MUST follow)

- Charm v2 vanity imports only: charm.land/bubbletea/v2, charm.land/bubbles/v2, charm.land/lipgloss/v2.
- errgroup.Group + context.WithCancel for concurrency; propagate context.Context through all I/O.
- Tests: table-driven with stretchr/testify (assert/require). Fixtures in testdata/.
- Commit format will be applied by the orchestrator — your job is just the code.
- Never use `as any` / `@ts-ignore` / `@ts-expect-error`.
- Bug fixes are minimal — never refactor while fixing.

## Build commands

- `make test-quick` — go + dashboard + landing
- `make build` — dashboard SPA + go binary
- `make lint` — `go vet ./...`
- For schema work in `cloud/schemas/`: `bunx --bun ajv-cli@5 compile -s <file> --spec=draft2020 --strict=false`
- For Go-side per-package: `go test ./internal/<pkg>/... && go vet ./...`
- For TS work in `cloud/`: `bunx tsc --noEmit` once `cloud/tsconfig.json` exists


# Your job

1. Pick the smallest change that satisfies the task statement plus the relevant spec scenarios.
2. Add or update tests where appropriate.
3. Run validation locally and report outcomes:
   - Go work → `go test ./internal/<pkg>/... && go vet ./...` (or `make test-quick` if the change is broad).
   - Schema work → ajv compile.
   - Cloud TS work → `bunx tsc --noEmit` if `cloud/tsconfig.json` exists, otherwise document the gap.
4. **Do NOT commit, push, or open PRs.** Leave the working tree dirty — the orchestrator will commit.
5. **Do NOT modify other tasks' areas.** No drive-by refactors. No touching `openspec/changes/.../tasks.md` (the orchestrator manages it).
6. **Stay inside the repo at `/Users/xumingyang/github/contrabass`.** Never touch `~/.claude/`, `~/.codex/`, `~/.config/`, etc.

When done, write a short final-message summary:
- Files changed and rough line counts
- Validation commands you ran and their results
- Any spec scenarios you couldn't satisfy and why
- Anything you defer to follow-up tasks

If truly blocked, write "BLOCKED: <reason>" as the LAST line and explain.
