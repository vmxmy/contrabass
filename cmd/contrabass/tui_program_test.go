//go:build !localonly

package main

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestTUIModelMoveCursor verifies cursor clamping and directional movement.
func TestTUIModelMoveCursor(t *testing.T) {
	m := newTUIModel("acme")
	m = m.applyFrame(tuiSubscribeFrame{
		Type: tuiFrameTypeBoardUpdate,
		BoardUpdate: &tuiBoardUpdate{
			TeamID: "acme",
			Entries: []tuiBoardEntry{
				{IssueRef: "A-1", Phase: "open"},
				{IssueRef: "A-2", Phase: "running"},
				{IssueRef: "A-3", Phase: "succeeded"},
			},
		},
	})

	assert.Equal(t, 0, m.boardView.Selected(), "initial selection should be 0")

	m = m.moveCursor(1)
	assert.Equal(t, 1, m.boardView.Selected())

	m = m.moveCursor(1)
	assert.Equal(t, 2, m.boardView.Selected())

	// Past the last row — must stay at 2.
	m = m.moveCursor(1)
	assert.Equal(t, 2, m.boardView.Selected())

	m = m.moveCursor(-1)
	assert.Equal(t, 1, m.boardView.Selected())

	// Far before the first row — must clamp to 0.
	m = m.moveCursor(-100)
	assert.Equal(t, 0, m.boardView.Selected())
}

// TestTUIModelMoveCursor_EmptyBoard ensures moveCursor is a no-op with no entries.
func TestTUIModelMoveCursor_EmptyBoard(t *testing.T) {
	m := newTUIModel("acme")
	m = m.moveCursor(1)
	assert.Equal(t, 0, m.boardView.Selected())
}

// TestTUIModelSelectedEntry_AfterBoardUpdate checks that SelectedEntry reflects
// the sorted board order and cursor position.
func TestTUIModelSelectedEntry_AfterBoardUpdate(t *testing.T) {
	m := newTUIModel("acme")
	m = m.applyFrame(tuiSubscribeFrame{
		Type: tuiFrameTypeBoardUpdate,
		BoardUpdate: &tuiBoardUpdate{
			Entries: []tuiBoardEntry{
				{IssueRef: "B-1", Phase: "open"},
				{IssueRef: "A-1", Phase: "running", RunID: "run-x", AssignedWorkerID: "worker-1"},
			},
		},
	})

	// Board sorted: A-1 first, B-1 second — cursor at 0 → A-1.
	entry, ok := m.boardView.SelectedEntry()
	require.True(t, ok)
	assert.Equal(t, "A-1", entry.IssueRef)
	assert.Equal(t, "running", entry.Phase)
	assert.Equal(t, "worker-1", entry.AssignedWorkerID)

	m = m.moveCursor(1)
	entry, ok = m.boardView.SelectedEntry()
	require.True(t, ok)
	assert.Equal(t, "B-1", entry.IssueRef)
}

// TestTUIModelBoardView_ClampsOnReplacement checks that the cursor is clamped
// when a board-update replaces a longer board with a shorter one.
func TestTUIModelBoardView_ClampsOnReplacement(t *testing.T) {
	m := newTUIModel("acme")
	m = m.applyFrame(tuiSubscribeFrame{
		Type: tuiFrameTypeBoardUpdate,
		BoardUpdate: &tuiBoardUpdate{
			Entries: []tuiBoardEntry{
				{IssueRef: "A-1", Phase: "open"},
				{IssueRef: "A-2", Phase: "open"},
				{IssueRef: "A-3", Phase: "open"},
			},
		},
	})
	m = m.moveCursor(2)
	assert.Equal(t, 2, m.boardView.Selected())

	// Replace with a single-entry board; cursor must clamp to 0.
	m = m.applyFrame(tuiSubscribeFrame{
		Type: tuiFrameTypeBoardUpdate,
		BoardUpdate: &tuiBoardUpdate{
			Entries: []tuiBoardEntry{{IssueRef: "ONLY-1", Phase: "open"}},
		},
	})
	assert.Equal(t, 0, m.boardView.Selected())
}

// TestTUIModelRunEventLog_PerIssue verifies that run events are accumulated in
// per-issue EventLog entries separately from the flat recentEvents slice.
func TestTUIModelRunEventLog_PerIssue(t *testing.T) {
	m := newTUIModel("acme")

	// Three events for ISSUE-A.
	for _, evType := range []string{"phase-0", "phase-1", "phase-2"} {
		m = m.applyFrame(tuiSubscribeFrame{
			Type: tuiFrameTypeRunEvent,
			RunEvent: &tuiRunEvent{
				RunID:     "run-a",
				IssueRef:  "ISSUE-A",
				EventType: evType,
				Timestamp: "2024-01-01T00:00:00Z",
			},
		})
	}

	// One event for ISSUE-B.
	m = m.applyFrame(tuiSubscribeFrame{
		Type: tuiFrameTypeRunEvent,
		RunEvent: &tuiRunEvent{
			RunID:     "run-b",
			IssueRef:  "ISSUE-B",
			EventType: "started",
			Timestamp: "2024-01-01T00:00:01Z",
		},
	})

	require.NotNil(t, m.runEventLogs["ISSUE-A"])
	require.NotNil(t, m.runEventLogs["ISSUE-B"])
	assert.Equal(t, 3, m.runEventLogs["ISSUE-A"].Len())
	assert.Equal(t, 1, m.runEventLogs["ISSUE-B"].Len())

	entries := m.runEventLogs["ISSUE-A"].Entries()
	require.Len(t, entries, 3)
	assert.Equal(t, "phase-0", entries[0].Type)
	assert.Equal(t, "phase-1", entries[1].Type)
	assert.Equal(t, "phase-2", entries[2].Type)
}

// TestTUIModelRunEventLog_EmptyRefIsSkipped verifies that run events with an
// empty IssueRef do not create a log entry (key "" would pollute the map).
func TestTUIModelRunEventLog_EmptyRefIsSkipped(t *testing.T) {
	m := newTUIModel("acme")
	m = m.applyFrame(tuiSubscribeFrame{
		Type: tuiFrameTypeRunEvent,
		RunEvent: &tuiRunEvent{
			RunID:     "run-x",
			IssueRef:  "",
			EventType: "phase",
		},
	})
	assert.Empty(t, m.runEventLogs, "no log entry should be created for empty IssueRef")
}
