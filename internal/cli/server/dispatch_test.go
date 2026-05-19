//go:build localonly

package server

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/junhoyeo/contrabass/internal/tracker"
	"github.com/junhoyeo/contrabass/internal/types"
)

func TestBoardDispatchUntilEmptyDrainsRunnableIssues(t *testing.T) {
	boardDir := filepath.Join(t.TempDir(), "board")
	cfgPath := writeBoardWorkflowConfig(t, boardDir)

	localTracker := tracker.NewLocalTracker(tracker.LocalConfig{
		BoardDir:    boardDir,
		IssuePrefix: "CB",
		Actor:       "test-bot",
	})

	ctx := context.Background()
	_, err := localTracker.InitBoard(ctx)
	require.NoError(t, err)

	parent, err := localTracker.CreateIssueWithOptions(ctx, tracker.LocalIssueCreateOptions{
		Title:    "Parent issue",
		Assignee: "team-alpha",
	})
	require.NoError(t, err)

	child, err := localTracker.CreateIssueWithOptions(ctx, tracker.LocalIssueCreateOptions{
		Title:     "Child issue",
		ParentID:  parent.ID,
		Assignee:  "team-alpha",
		BlockedBy: []string{parent.ID},
	})
	require.NoError(t, err)

	var calls []teamRunOptions
	err = dispatchBoardIssues(
		ctx,
		new(bytes.Buffer),
		localTracker,
		boardDispatchOptions{
			ConfigPath: cfgPath,
			UntilEmpty: true,
		},
		func(opts teamRunOptions) error {
			calls = append(calls, opts)
			return localTracker.UpdateIssueState(ctx, opts.IssueID, types.Released)
		},
	)
	require.NoError(t, err)

	require.Len(t, calls, 2)
	assert.Equal(t, []string{parent.ID, child.ID}, []string{calls[0].IssueID, calls[1].IssueID})
	assert.Equal(t, []string{"team-alpha", "team-alpha"}, []string{calls[0].TeamName, calls[1].TeamName})

	parent, err = localTracker.GetIssue(ctx, parent.ID)
	require.NoError(t, err)
	assert.Equal(t, tracker.LocalBoardStateDone, parent.State)

	child, err = localTracker.GetIssue(ctx, child.ID)
	require.NoError(t, err)
	assert.Equal(t, tracker.LocalBoardStateDone, child.State)
}

func writeBoardWorkflowConfig(t *testing.T, boardDir string) string {
	t.Helper()

	path := filepath.Join(t.TempDir(), "WORKFLOW.md")
	content := fmt.Sprintf(`---
tracker:
  type: internal
  board_dir: %q
---
Internal board test workflow.
`, boardDir)
	require.NoError(t, os.WriteFile(path, []byte(content), 0o644))
	return path
}
