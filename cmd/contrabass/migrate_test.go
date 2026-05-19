package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestMigrateCloudCommandPrintsLoadedSourceSummary(t *testing.T) {
	root := t.TempDir()
	writeMigrationCommandFixture(t, root, "alpha")

	cmd := newRootCmd()
	buf := new(bytes.Buffer)
	cmd.SetOut(buf)
	cmd.SetErr(buf)
	cmd.SetArgs([]string{"migrate", "cloud", "--team", "alpha", "--root", root, "--dry-run=false"})

	require.NoError(t, cmd.Execute())

	output := buf.String()
	assert.Contains(t, output, "loaded cloud migration source for team alpha")
	assert.Contains(t, output, "team state: 2 json files")
	assert.Contains(t, output, "board: 2 issues, 1 comments, 2 refresh entries")
	assert.Contains(t, output, "uploads require --api-base-url")
}

func TestMigrateCloudCommandDryRunPrintsPlanAndSkipsUpload(t *testing.T) {
	root := t.TempDir()
	writeMigrationCommandFixture(t, root, "alpha")

	var requestCount int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestCount++
		t.Fatalf("dry-run should not call cloud API: %s %s", r.Method, r.URL.Path)
	}))
	t.Cleanup(server.Close)

	cmd := newRootCmd()
	buf := new(bytes.Buffer)
	cmd.SetOut(buf)
	cmd.SetErr(buf)
	cmd.SetArgs([]string{"migrate", "cloud", "--team", "alpha", "--root", root, "--api-base-url", server.URL, "--dry-run"})

	require.NoError(t, cmd.Execute())

	output := buf.String()
	assert.Contains(t, output, "dry-run migration plan:")
	assert.Contains(t, output, "upload workflow config hash")
	assert.Contains(t, output, "read 2 team state json files")
	assert.Contains(t, output, "refresh 2 board entries")
	assert.Contains(t, output, "no uploads performed")
	assert.Zero(t, requestCount)
}

func TestMigrateCloudCommandRequiresConfirmationBeforeUpload(t *testing.T) {
	root := t.TempDir()
	writeMigrationCommandFixture(t, root, "alpha")

	var requestCount int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestCount++
		t.Fatalf("unconfirmed migration should not call cloud API: %s %s", r.Method, r.URL.Path)
	}))
	t.Cleanup(server.Close)

	cmd := newRootCmd()
	buf := new(bytes.Buffer)
	cmd.SetOut(buf)
	cmd.SetErr(buf)
	cmd.SetIn(strings.NewReader("no\n"))
	cmd.SetArgs([]string{"migrate", "cloud", "--team", "alpha", "--root", root, "--api-base-url", server.URL, "--dry-run=false"})

	err := cmd.Execute()
	require.Error(t, err)
	assert.ErrorContains(t, err, "migration upload cancelled")
	assert.Contains(t, buf.String(), `Type "migrate alpha" to continue`)
	assert.Zero(t, requestCount)
}

func TestMigrateCloudCommandUploadsAfterExplicitConfirmation(t *testing.T) {
	root := t.TempDir()
	writeMigrationCommandFixture(t, root, "alpha")

	var configPostCount int
	var boardRefreshPostCount int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/v1/teams/alpha/config/"):
			w.WriteHeader(http.StatusNotFound)
		case r.Method == http.MethodPost && r.URL.Path == "/v1/teams/alpha/config":
			configPostCount++
			w.WriteHeader(http.StatusCreated)
		case r.Method == http.MethodGet && r.URL.Path == "/v1/teams/alpha/board":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"board": map[string][]map[string]any{
					"open":    {},
					"claimed": {},
					"running": {},
					"done":    {},
				},
			})
		case r.Method == http.MethodPost && r.URL.Path == "/v1/teams/alpha/board/refresh":
			boardRefreshPostCount++
			w.WriteHeader(http.StatusAccepted)
		default:
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
	}))
	t.Cleanup(server.Close)

	cmd := newRootCmd()
	buf := new(bytes.Buffer)
	cmd.SetOut(buf)
	cmd.SetErr(buf)
	cmd.SetIn(strings.NewReader("migrate alpha\n"))
	cmd.SetArgs([]string{"migrate", "cloud", "--team", "alpha", "--root", root, "--api-base-url", server.URL, "--dry-run=false"})

	require.NoError(t, cmd.Execute())

	assert.Equal(t, 1, configPostCount)
	assert.Equal(t, 1, boardRefreshPostCount)
	assert.Contains(t, buf.String(), "config: uploaded")
	assert.Contains(t, buf.String(), "board uploads: 2 uploaded, 0 skipped by external_id")
}

func writeMigrationCommandFixture(t *testing.T, root string, teamName string) {
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
