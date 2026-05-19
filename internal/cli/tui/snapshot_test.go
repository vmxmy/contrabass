//go:build !localonly

package tui

import (
	"flag"
	"os"
	"path/filepath"
	"regexp"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	tui "github.com/junhoyeo/contrabass/internal/tui"
)

var updateGolden = flag.Bool("update", false, "update golden snapshot files")

var (
	ansiRegex    = regexp.MustCompile(`\x1b\[[0-9;]*[a-zA-Z]`)
	spinnerRegex = regexp.MustCompile(`[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷]`)
)

func stripANSI(s string) string {
	return ansiRegex.ReplaceAllString(s, "")
}

func normalizeSpinner(s string) string {
	return spinnerRegex.ReplaceAllString(s, "●")
}

func goldenPath(name string) string {
	return filepath.Join("..", "..", "..", "testdata", "snapshots", name+".txt")
}

func assertGolden(t *testing.T, name, got string) {
	t.Helper()
	path := goldenPath(name)
	if *updateGolden {
		os.MkdirAll(filepath.Dir(path), 0o755)
		os.WriteFile(path, []byte(got), 0o644)
		return
	}
	expected, err := os.ReadFile(path)
	require.NoError(t, err, "golden file %s not found — run with -update to generate", path)
	assert.Equal(t, string(expected), got)
}

// newSnapshotTUIModel returns a tuiModel pinned to fixed terminal dimensions
// so that rendered output is stable for golden-file comparison.
func newSnapshotTUIModel(teamID string) tuiModel {
	m := newTUIModel(teamID)
	m.width = 100
	m.height = 40
	m.help.SetWidth(100)
	m.boardView = m.boardView.SetWidth(100)
	m.detailView = m.detailView.SetWidth(100)
	return m
}

func renderSnapshot(m tuiModel) string {
	return normalizeSpinner(stripANSI(m.View().Content))
}

// TestSnapshotCloudConnecting captures the initial connecting state before any
// cloud frames have been received.
func TestSnapshotCloudConnecting(t *testing.T) {
	m := newSnapshotTUIModel("acme")
	// Default connState is tuiConnConnecting; no board entries yet.
	assertGolden(t, "cloud_connecting", renderSnapshot(m))
}

// TestSnapshotCloudEmptyBoard captures the connected state when the team board
// has no issues.
func TestSnapshotCloudEmptyBoard(t *testing.T) {
	m := newSnapshotTUIModel("acme")
	m.connState = tuiConnConnected
	m = m.applyFrame(tuiSubscribeFrame{
		Type: tuiFrameTypeBoardUpdate,
		BoardUpdate: &tuiBoardUpdate{
			TeamID:  "acme",
			Entries: []tuiBoardEntry{},
		},
	})
	assertGolden(t, "cloud_empty_board", renderSnapshot(m))
}

// TestSnapshotCloudSingleIssue captures a board with one open issue.
func TestSnapshotCloudSingleIssue(t *testing.T) {
	m := newSnapshotTUIModel("acme")
	m.connState = tuiConnConnected
	m = m.applyFrame(tuiSubscribeFrame{
		Type: tuiFrameTypeBoardUpdate,
		BoardUpdate: &tuiBoardUpdate{
			TeamID: "acme",
			Entries: []tuiBoardEntry{
				{IssueRef: "ACME-1", Phase: "open", LastUpdated: "2024-01-15T10:30:00Z"},
			},
		},
	})
	assertGolden(t, "cloud_single_issue", renderSnapshot(m))
}

// TestSnapshotCloudMultipleIssues captures a board with issues in various
// lifecycle phases: open, running, succeeded, failed, cancelled.
func TestSnapshotCloudMultipleIssues(t *testing.T) {
	m := newSnapshotTUIModel("acme")
	m.connState = tuiConnConnected
	m = m.applyFrame(tuiSubscribeFrame{
		Type: tuiFrameTypeBoardUpdate,
		BoardUpdate: &tuiBoardUpdate{
			TeamID: "acme",
			Entries: []tuiBoardEntry{
				{IssueRef: "ACME-1", Phase: "open", LastUpdated: "2024-01-15T10:00:00Z"},
				{IssueRef: "ACME-2", Phase: "running", RunID: "run-002", AssignedWorkerID: "worker-dev-1", LastUpdated: "2024-01-15T10:15:00Z"},
				{IssueRef: "ACME-3", Phase: "succeeded", RunID: "run-003", AssignedWorkerID: "worker-dev-1", LastUpdated: "2024-01-15T09:45:00Z"},
				{IssueRef: "ACME-4", Phase: "failed", RunID: "run-004", LastUpdated: "2024-01-15T09:30:00Z"},
				{IssueRef: "ACME-5", Phase: "cancelled", LastUpdated: "2024-01-15T08:00:00Z"},
			},
		},
	})
	assertGolden(t, "cloud_multiple_issues", renderSnapshot(m))
}

// TestSnapshotCloudWithWorkers captures the overview showing board entries and
// registered workers in the workers section.
func TestSnapshotCloudWithWorkers(t *testing.T) {
	m := newSnapshotTUIModel("acme")
	m.connState = tuiConnConnected
	m = m.applyFrame(tuiSubscribeFrame{
		Type: tuiFrameTypeBoardUpdate,
		BoardUpdate: &tuiBoardUpdate{
			TeamID: "acme",
			Entries: []tuiBoardEntry{
				{IssueRef: "ACME-1", Phase: "running", RunID: "run-001", AssignedWorkerID: "worker-alice", LastUpdated: "2024-01-15T10:15:00Z"},
				{IssueRef: "ACME-2", Phase: "open", LastUpdated: "2024-01-15T10:00:00Z"},
			},
		},
	})
	m = m.applyFrame(tuiSubscribeFrame{
		Type:         tuiFrameTypeWorkerStatus,
		WorkerStatus: &tuiWorkerStatus{WorkerID: "worker-alice", Status: "busy", Kind: "local"},
	})
	m = m.applyFrame(tuiSubscribeFrame{
		Type:         tuiFrameTypeWorkerStatus,
		WorkerStatus: &tuiWorkerStatus{WorkerID: "worker-bob", Status: "idle", Kind: "local"},
	})
	assertGolden(t, "cloud_with_workers", renderSnapshot(m))
}

// TestSnapshotCloudDetailView captures the detail view for a selected board
// entry with its accumulated run-event log.
func TestSnapshotCloudDetailView(t *testing.T) {
	m := newSnapshotTUIModel("acme")
	m.connState = tuiConnConnected
	m = m.applyFrame(tuiSubscribeFrame{
		Type: tuiFrameTypeBoardUpdate,
		BoardUpdate: &tuiBoardUpdate{
			TeamID: "acme",
			Entries: []tuiBoardEntry{
				{IssueRef: "ACME-1", Phase: "running", RunID: "run-001", AssignedWorkerID: "worker-alice"},
			},
		},
	})
	for _, ev := range []struct {
		evType string
		ts     string
	}{
		{"dispatched", "2024-01-15T10:30:00Z"},
		{"ack", "2024-01-15T10:30:01Z"},
		{"phase:plan", "2024-01-15T10:30:05Z"},
		{"phase:execute", "2024-01-15T10:30:30Z"},
	} {
		m = m.applyFrame(tuiSubscribeFrame{
			Type: tuiFrameTypeRunEvent,
			RunEvent: &tuiRunEvent{
				RunID:     "run-001",
				IssueRef:  "ACME-1",
				EventType: ev.evType,
				Timestamp: ev.ts,
			},
		})
	}
	m.viewMode = tui.CloudViewDetail
	m.keys = m.keys.SetViewMode(tui.CloudViewDetail)
	assertGolden(t, "cloud_detail_view", renderSnapshot(m))
}

// TestSnapshotCloudReconnecting captures the reconnecting banner over a
// previously-populated board.
func TestSnapshotCloudReconnecting(t *testing.T) {
	m := newSnapshotTUIModel("acme")
	m = m.applyFrame(tuiSubscribeFrame{
		Type: tuiFrameTypeBoardUpdate,
		BoardUpdate: &tuiBoardUpdate{
			TeamID: "acme",
			Entries: []tuiBoardEntry{
				{IssueRef: "ACME-1", Phase: "running", RunID: "run-001", AssignedWorkerID: "worker-alice"},
			},
		},
	})
	m.connState = tuiConnReconnecting
	assertGolden(t, "cloud_reconnecting", renderSnapshot(m))
}

// TestSnapshotCloudConfigHash captures the header when a config-changed frame
// has been received and the short hash is rendered in the title bar.
func TestSnapshotCloudConfigHash(t *testing.T) {
	m := newSnapshotTUIModel("acme")
	m.connState = tuiConnConnected
	m = m.applyFrame(tuiSubscribeFrame{
		Type: tuiFrameTypeConfigChanged,
		ConfigChanged: &tuiConfigChanged{
			TeamID:  "acme",
			Version: "v3",
			Hash:    "abc12345def67890",
		},
	})
	assertGolden(t, "cloud_config_hash", renderSnapshot(m))
}
