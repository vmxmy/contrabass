#!/usr/bin/env python3
"""Local OpenSpec task driver — uses codex to implement unchecked tasks
from tasks.md, one commit per task, all on the current branch.

No Linear API. No PR creation. No worktrees. Just:

  parse tasks.md →
  for each `- [ ] N.M ...` task:
    codex implement → validate → codex review → fix loop (max 3) →
    flip `- [ ]` to `- [x]` → stage all → commit

Resumable: re-run, it skips checked tasks.
Pause: Ctrl-C anywhere; tasks.md is the state.

Usage:
  scripts/contrabass_apply.py [--dry-run] [--limit N] [--epic N[,M..]]
                              [--start N.M] [--gate-per-epic]
                              [--no-validate] [--max-fix-rounds N]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

REPO = Path("/Users/xumingyang/github/contrabass")
CHANGE_DIR = REPO / "openspec/changes/cloud-orchestrator-with-local-workers"
TASKS_FILE = CHANGE_DIR / "tasks.md"
SPECS_DIR = CHANGE_DIR / "specs"
DESIGN_FILE = CHANGE_DIR / "design.md"
PROPOSAL_FILE = CHANGE_DIR / "proposal.md"
AUDIT_ROOT = REPO / ".claude/auto-runs"
LOG_FILE = Path.home() / ".contrabass-apply.log"

MAX_IMPL_ATTEMPTS = 2
MAX_FIX_ATTEMPTS_DEFAULT = 3
CODEX_TIMEOUT_SEC = 1800  # 30 min per call


# ---------- helpers ----------
def log(msg: str) -> None:
    line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}"
    print(line, flush=True)
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    with LOG_FILE.open("a") as f:
        f.write(line + "\n")


def run(cmd: list[str], *, cwd: Path | None = None, check: bool = True,
        timeout: int | None = None) -> tuple[int, str, str]:
    log(f"$ {' '.join(shlex.quote(x) for x in cmd)}")
    res = subprocess.run(cmd, capture_output=True, text=True, cwd=cwd, timeout=timeout)
    if res.returncode != 0 and check:
        sys.stderr.write(res.stdout)
        sys.stderr.write(res.stderr)
        raise RuntimeError(f"command failed (exit {res.returncode}): {' '.join(cmd)}")
    return res.returncode, res.stdout, res.stderr


# ---------- tasks.md ----------
@dataclass
class Task:
    epic: int
    sub: int
    text: str
    line_idx: int
    raw: str
    done: bool

    @property
    def num(self) -> str:
        return f"{self.epic}.{self.sub}"


def parse_tasks() -> tuple[list[Task], list[str], dict[int, str]]:
    """Returns (tasks, raw_lines, group_titles)."""
    raw = TASKS_FILE.read_text().splitlines(keepends=False)
    tasks: list[Task] = []
    groups: dict[int, str] = {}
    cur_epic: int | None = None
    group_re = re.compile(r"^##\s+(\d+)\.\s+(.+?)\s*$")
    task_re = re.compile(r"^- \[(.)\]\s+(\d+)\.(\d+)\s+(.+?)\s*$")
    for i, line in enumerate(raw):
        m = group_re.match(line)
        if m:
            cur_epic = int(m.group(1))
            groups[cur_epic] = m.group(2)
            continue
        m = task_re.match(line)
        if m and cur_epic is not None:
            mark = m.group(1)
            tasks.append(Task(
                epic=int(m.group(2)), sub=int(m.group(3)),
                text=m.group(4), line_idx=i, raw=line,
                done=(mark.lower() == "x"),
            ))
    return tasks, raw, groups


def mark_done(task: Task) -> None:
    raw = TASKS_FILE.read_text().splitlines(keepends=False)
    raw[task.line_idx] = raw[task.line_idx].replace("- [ ] ", "- [x] ", 1)
    TASKS_FILE.write_text("\n".join(raw) + "\n")


# ---------- spec lookup ----------
def list_spec_paths() -> list[Path]:
    if not SPECS_DIR.exists():
        return []
    return sorted(SPECS_DIR.glob("*/spec.md"))


# ---------- codex driver ----------
def codex_exec(prompt: str, last_msg_file: Path) -> tuple[int, str]:
    cmd = [
        "codex", "exec",
        "--cd", str(REPO),
        "--sandbox", "workspace-write",
        "--dangerously-bypass-approvals-and-sandbox",
        "--skip-git-repo-check",
        "-o", str(last_msg_file),
        prompt,
    ]
    log(f"codex exec ({len(prompt)} chars prompt) ...")
    code, out, err = run(cmd, cwd=REPO, check=False, timeout=CODEX_TIMEOUT_SEC)
    last_msg = last_msg_file.read_text() if last_msg_file.exists() else ""
    return code, last_msg


# ---------- prompts ----------
REPO_RULES = """
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
"""


def build_impl_prompt(task: Task, group_title: str) -> str:
    spec_index = "\n".join(f"  - openspec/changes/cloud-orchestrator-with-local-workers/specs/{p.parent.name}/spec.md"
                           for p in list_spec_paths())
    return f"""You are implementing ONE checkbox task from an OpenSpec change. Stay strictly within scope.

# Task {task.num} (epic: {group_title})

{task.text}

# Where to read

1. The change root: `openspec/changes/cloud-orchestrator-with-local-workers/`
2. Capability specs (read whichever ones the task touches):
{spec_index}
3. `openspec/changes/cloud-orchestrator-with-local-workers/design.md` for decisions.
4. `openspec/changes/cloud-orchestrator-with-local-workers/tasks.md` for the surrounding task list. Read sibling tasks in epic {task.epic} so you understand context, but ONLY implement task {task.num}.
5. `CLAUDE.md` for repo-wide conventions.

{REPO_RULES}

# Your job

1. Pick the smallest change that satisfies the task statement plus the relevant spec scenarios.
2. Add or update tests where appropriate.
3. Run validation locally and report outcomes:
   - Go work → `go test ./internal/<pkg>/... && go vet ./...` (or `make test-quick` if the change is broad).
   - Schema work → ajv compile.
   - Cloud TS work → `bunx tsc --noEmit` if `cloud/tsconfig.json` exists, otherwise document the gap.
4. **Do NOT commit, push, or open PRs.** Leave the working tree dirty — the orchestrator will commit.
5. **Do NOT modify other tasks' areas.** No drive-by refactors. No touching `openspec/changes/.../tasks.md` (the orchestrator manages it).
6. **Stay inside the repo at `{REPO}`.** Never touch `~/.claude/`, `~/.codex/`, `~/.config/`, etc.

When done, write a short final-message summary:
- Files changed and rough line counts
- Validation commands you ran and their results
- Any spec scenarios you couldn't satisfy and why
- Anything you defer to follow-up tasks

If truly blocked, write "BLOCKED: <reason>" as the LAST line and explain.
"""


def build_review_prompt(task: Task, diff: str) -> str:
    truncated = diff if len(diff) < 60000 else diff[:60000] + "\n... [diff truncated]"
    return f"""You are an independent reviewer. You did NOT see the implementation conversation. Review the diff below for correctness against the OpenSpec change at `openspec/changes/cloud-orchestrator-with-local-workers/`.

# Task being reviewed

{task.num}: {task.text}

Read the relevant capability spec(s) under `openspec/changes/cloud-orchestrator-with-local-workers/specs/<capability>/spec.md` based on what the diff touches. Verify the diff against the spec text directly.

# Diff

```diff
{truncated}
```

# Output rubric

For each finding:

[severity: critical|high|medium|low|nit]
File: <path>:<line or json-pointer>
Issue: <one-line>
Why: <one-line on impact>
Fix: <concrete patch>

End with EXACTLY ONE final-line verdict (must be the very last line):

VERDICT: APPROVE
VERDICT: REQUEST_CHANGES
VERDICT: BLOCK

Use BLOCK only if the change should be reverted and reworked from scratch.
Use REQUEST_CHANGES if there are critical/high issues that must be fixed before commit.
Use APPROVE if no critical/high findings (medium/low/nit are acceptable for follow-up).
"""


def build_fix_prompt(task: Task, review_text: str) -> str:
    return f"""A reviewer flagged issues in your implementation of task {task.num}. Apply fixes for every critical/high finding, re-validate, and stop. Do not commit.

# Reviewer findings

{review_text}

# Your job

For every finding marked critical or high:
1. Apply the suggested fix (or a better one if you have a clear reason).
2. Re-run the relevant validation.
3. Note in your final message which findings you addressed, which you rejected (with reason), and validation results.

Skip medium/low/nit findings — they go in commit-message footer for human review.
Do not introduce changes outside the scope of the listed findings.
"""


# ---------- review parsing ----------
VERDICT_RE = re.compile(r"^VERDICT:\s*(APPROVE|REQUEST_CHANGES|BLOCK)\s*$", re.MULTILINE)
SEV_RE = re.compile(r"\[severity:\s*(critical|high)\b", re.IGNORECASE)


def parse_verdict(text: str) -> str:
    for line in reversed(text.strip().splitlines()):
        line = line.strip()
        if line.startswith("VERDICT:"):
            v = line.split(":", 1)[1].strip()
            if v in {"APPROVE", "REQUEST_CHANGES", "BLOCK"}:
                return v
    return "UNKNOWN"


def has_critical_or_high(text: str) -> bool:
    return bool(SEV_RE.search(text))


# ---------- git ----------
def git_diff_full() -> str:
    code, out, _ = run(["git", "diff", "--no-color"], cwd=REPO, check=False)
    code2, untracked, _ = run(["git", "ls-files", "--others", "--exclude-standard"], cwd=REPO, check=False)
    block = ""
    for path in [p for p in untracked.splitlines() if p.strip()]:
        try:
            content = (REPO / path).read_text()
        except Exception:
            content = "[binary or unreadable]"
        block += f"\n--- /dev/null\n+++ b/{path}\n{content}\n"
    return out + block


def git_has_changes() -> bool:
    code, out, _ = run(["git", "status", "--porcelain"], cwd=REPO, check=False)
    return bool(out.strip())


def commit_msg_for(task: Task, group_title: str) -> str:
    text_lower = task.text.lower()
    scope = "project"
    for kw, sc in [
        ("workerproto", "workerproto"), ("schema", "workerproto"),
        ("dashboard", "dashboard"), ("landing", "landing"),
        ("config", "config"), ("tracker", "tracker"),
        ("workspace", "workspace"), ("internal/agent", "agent"),
        ("orchestrator", "orchestrator"), ("internal/team", "team"),
        ("tmux", "tmux"), ("ipc", "ipc"), ("internal/tui", "tui"),
        ("internal/web", "web"), ("hub", "hub"), ("logging", "logging"),
        ("cloud/", "cloud"), ("durable object", "do"),
        ("contrabass worker", "worker"), ("docs", "docs"),
        ("d1", "d1"), ("r2 ", "r2"), ("queues", "queues"),
        ("secret", "secrets"), ("oauth", "auth"),
        ("cron", "cron"), (" ci ", "ci"), ("makefile", "build"),
    ]:
        if kw in text_lower:
            scope = sc
            break
    desc = task.text[:60].rstrip(".")
    return f"feat({scope}): {desc} ({task.num})"


def commit(task: Task, group_title: str, summary: str, review_text: str) -> str:
    run(["git", "add", "-A"], cwd=REPO)
    msg_subject = commit_msg_for(task, group_title)
    body = f"""task {task.num} from openspec/changes/cloud-orchestrator-with-local-workers/tasks.md
epic {task.epic}: {group_title}

implementation summary:
{summary[:1500]}

review verdict: {parse_verdict(review_text)}
"""
    full_msg = f"{msg_subject}\n\n{body}"
    code, out, err = run(["git", "commit", "-m", full_msg], cwd=REPO, check=False)
    if code != 0 and "nothing to commit" in (out + err):
        log("(no diff to commit, skipping)")
        return ""
    if code != 0:
        raise RuntimeError(f"commit failed: {err}")
    code, sha, _ = run(["git", "rev-parse", "--short", "HEAD"], cwd=REPO)
    return sha.strip()


# ---------- per-task lifecycle ----------
def process_task(task: Task, group_title: str, audit_dir: Path,
                 max_fix: int, dry_run: bool, no_validate: bool) -> str:
    """Returns 'completed' | 'blocked' | 'failed'."""
    if dry_run:
        log(f"[dry-run] would implement {task.num} (epic {task.epic}: {group_title})")
        return "completed"

    # impl
    impl_summary = ""
    for attempt in range(1, MAX_IMPL_ATTEMPTS + 1):
        log(f"[impl attempt {attempt}/{MAX_IMPL_ATTEMPTS}] task {task.num}")
        prompt = build_impl_prompt(task, group_title)
        (audit_dir / f"impl_prompt_{attempt}.md").write_text(prompt)
        last = audit_dir / f"impl_msg_{attempt}.txt"
        code, msg = codex_exec(prompt, last)
        impl_summary = msg
        last_line = (msg.strip().splitlines() or [""])[-1]
        if last_line.startswith("BLOCKED:"):
            log(f"BLOCKED reported: {last_line}")
            return "blocked"
        if code == 0 and git_has_changes():
            break
        log(f"impl attempt {attempt} produced no changes (exit={code})")
    if not git_has_changes():
        log(f"no changes after {MAX_IMPL_ATTEMPTS} attempts — failed")
        return "failed"

    # review
    diff = git_diff_full()
    (audit_dir / "diff.patch").write_text(diff)
    log(f"[review] task {task.num}")
    review_last = audit_dir / "review_msg_1.txt"
    _, review_text = codex_exec(build_review_prompt(task, diff), review_last)
    (audit_dir / "review_1.md").write_text(review_text)

    fix_round = 0
    while has_critical_or_high(review_text) and fix_round < max_fix:
        fix_round += 1
        log(f"[fix round {fix_round}/{max_fix}] task {task.num}")
        fix_last = audit_dir / f"fix_msg_{fix_round}.txt"
        codex_exec(build_fix_prompt(task, review_text), fix_last)
        diff = git_diff_full()
        (audit_dir / f"diff_after_fix_{fix_round}.patch").write_text(diff)
        rev_last = audit_dir / f"review_msg_{fix_round + 1}.txt"
        _, review_text = codex_exec(build_review_prompt(task, diff), rev_last)
        (audit_dir / f"review_{fix_round + 1}.md").write_text(review_text)

    if has_critical_or_high(review_text):
        log(f"FAILED: critical/high findings remain after {max_fix} fix rounds")
        # Leave changes uncommitted for human inspection
        return "failed"

    # Mark done in tasks.md (in same commit)
    mark_done(task)

    sha = commit(task, group_title, impl_summary, review_text)
    log(f"committed {sha} for task {task.num} (verdict: {parse_verdict(review_text)})")
    return "completed"


# ---------- main ----------
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--epic", type=str, default="")
    ap.add_argument("--start", type=str, default="", help="N.M to start from (skip earlier tasks)")
    ap.add_argument("--gate-per-epic", action="store_true",
                    help="Stop at every epic boundary; require manual re-run for next epic.")
    ap.add_argument("--max-fix-rounds", type=int, default=MAX_FIX_ATTEMPTS_DEFAULT)
    ap.add_argument("--no-validate", action="store_true",
                    help="Skip the orchestrator's local validation hook (codex still runs its own).")
    args = ap.parse_args()

    epic_filter: set[int] = set(int(e) for e in args.epic.split(",") if e.strip())
    start = args.start
    started = not start

    tasks, _, groups = parse_tasks()
    pending = [t for t in tasks if not t.done]
    log(f"tasks total={len(tasks)} done={len(tasks) - len(pending)} pending={len(pending)}")

    processed = 0
    completed = 0
    failed = 0
    blocked = 0
    last_epic: int | None = None

    for task in pending:
        if not started:
            if task.num == start:
                started = True
            else:
                continue
        if epic_filter and task.epic not in epic_filter:
            continue

        # epic gate
        if args.gate_per_epic and last_epic is not None and task.epic != last_epic:
            log(f"=== EPIC GATE: completed epic {last_epic}, next is epic {task.epic} ===")
            log(f"Re-run with --start {task.num} when ready, or --epic {task.epic}.")
            break

        if args.limit and processed >= args.limit:
            log(f"--limit {args.limit} reached")
            break

        log(f"=== task {task.num}: {task.text[:80]}... ===")
        audit_dir = AUDIT_ROOT / f"{task.epic:02d}_{task.sub:02d}_apply"
        audit_dir.mkdir(parents=True, exist_ok=True)
        try:
            outcome = process_task(task, groups.get(task.epic, "?"),
                                   audit_dir, args.max_fix_rounds,
                                   args.dry_run, args.no_validate)
        except Exception as e:
            log(f"FATAL on {task.num}: {type(e).__name__}: {e}")
            outcome = "failed"

        if outcome == "completed":
            completed += 1
        elif outcome == "blocked":
            blocked += 1
            log(f"BLOCKED on {task.num}; pausing the queue. Resolve and re-run.")
            break
        else:
            failed += 1
            log(f"FAILED on {task.num}; pausing the queue. Inspect uncommitted changes and re-run with --start {task.num}.")
            break

        processed += 1
        last_epic = task.epic

    log(f"done. processed={processed} completed={completed} failed={failed} blocked={blocked}")
    return 0 if failed == 0 and blocked == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
