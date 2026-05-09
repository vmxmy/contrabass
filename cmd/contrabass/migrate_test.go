package main

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestLoadMigrateCloudSourceReadsWorkflowTeamStateAndBoard(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	writeMigrationFixture(t, root, "alpha")

	source, err := loadMigrateCloudSource(context.Background(), migrateCloudOptions{
		TeamName: "alpha",
		RootDir:  root,
	})
	require.NoError(t, err)

	assert.Equal(t, "alpha", source.TeamName)
	assert.Equal(t, filepath.Join(root, "WORKFLOW.md"), source.Workflow.Path)
	assert.Len(t, source.Workflow.ContentHash, 64)
	assert.Len(t, source.TeamState, 2)
	assert.Equal(t, []string{"manifest.json", "phase-state.json"}, []string{source.TeamState[0].Name, source.TeamState[1].Name})
	assert.Len(t, source.Board.Issues, 2)
	assert.Len(t, source.Board.Comments["CB-1"], 1)
	require.Len(t, source.Board.Entries, 2)
	assert.Equal(t, migrateCloudBoardEntry{
		IssueRef:         "CB-1",
		RunID:            "alpha-run",
		AssignedWorkerID: "alpha-run",
		Phase:            "running",
		LastUpdated:      time.Date(2026, 5, 9, 1, 2, 3, 0, time.UTC).UnixMilli(),
	}, source.Board.Entries[0])
	assert.Equal(t, "done", source.Board.Entries[1].Phase)
}

func TestMigrateCloudCommandPrintsLoadedSourceSummary(t *testing.T) {
	root := t.TempDir()
	writeMigrationFixture(t, root, "alpha")

	cmd := newRootCmd()
	buf := new(bytes.Buffer)
	cmd.SetOut(buf)
	cmd.SetErr(buf)
	cmd.SetArgs([]string{"migrate", "cloud", "--team", "alpha", "--root", root})

	require.NoError(t, cmd.Execute())

	output := buf.String()
	assert.Contains(t, output, "loaded cloud migration source for team alpha")
	assert.Contains(t, output, "team state: 2 json files")
	assert.Contains(t, output, "board: 2 issues, 1 comments, 2 refresh entries")
	assert.Contains(t, output, "uploads are deferred")
}

func TestLoadMigrateCloudSourceRejectsMissingTeam(t *testing.T) {
	t.Parallel()

	_, err := loadMigrateCloudSource(context.Background(), migrateCloudOptions{RootDir: t.TempDir()})
	require.Error(t, err)
	assert.ErrorContains(t, err, "--team is required")
}

func writeMigrationFixture(t *testing.T, root string, teamName string) {
	t.Helper()

	workflow := `---
model: openai/gpt-5-codex
project_url: https://linear.app/acme/project/cloud
tracker:
  type: internal
team:
  execution_mode: team
---
Ship it.
`
	require.NoError(t, os.WriteFile(filepath.Join(root, "WORKFLOW.md"), []byte(workflow), 0o644))

	teamDir := filepath.Join(root, ".contrabass", "state", "team", teamName)
	require.NoError(t, os.MkdirAll(filepath.Join(teamDir, "workers"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(teamDir, "manifest.json"), []byte(`{"name":"alpha"}`), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(teamDir, "phase-state.json"), []byte(`{"phase":"team-exec"}`), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(teamDir, "workers", "worker-1.json"), []byte(`{"id":"worker-1"}`), 0o644))

	boardDir := filepath.Join(root, ".contrabass", "board")
	require.NoError(t, os.MkdirAll(filepath.Join(boardDir, "issues"), 0o755))
	require.NoError(t, os.MkdirAll(filepath.Join(boardDir, "comments"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(boardDir, "manifest.json"), []byte(`{
  "schema_version": "1",
  "issue_prefix": "CB",
  "next_issue_number": 3,
  "created_at": "2026-05-09T00:00:00Z",
  "updated_at": "2026-05-09T00:00:00Z"
}`), 0o644))

	updatedAt := "2026-05-09T01:02:03Z"
	issueOne := fmt.Sprintf(`{
  "id": "CB-1",
  "identifier": "CB-1",
  "title": "Running issue",
  "description": "already claimed",
  "state": "in_progress",
  "claimed_by": "team:alpha-run",
  "tracker_meta": {"team_name": "alpha-run", "last_worker_id": "worker-1"},
  "created_at": "2026-05-09T00:00:00Z",
  "updated_at": %q
}`, updatedAt)
	require.NoError(t, os.WriteFile(filepath.Join(boardDir, "issues", "CB-1.json"), []byte(issueOne), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(boardDir, "issues", "CB-2.json"), []byte(`{
  "id": "CB-2",
  "identifier": "CB-2",
  "title": "Done issue",
  "description": "complete",
  "state": "done",
  "created_at": "2026-05-09T00:00:01Z",
  "updated_at": "2026-05-09T00:00:02Z"
}`), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(boardDir, "comments", "CB-1.jsonl"), []byte(`{"author":"bot","body":"started","created_at":"2026-05-09T00:00:00Z"}`+"\n"), 0o644))
}
