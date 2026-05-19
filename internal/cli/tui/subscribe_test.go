//go:build !localonly

package tui

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// --- parseTUIFrame ---

func TestParseTUIFrame_BoardUpdate(t *testing.T) {
	data := json.RawMessage(`{
		"type": "board-update",
		"eventId": "evt-1",
		"board": {
			"teamId": "acme",
			"entries": [
				{"issueRef": "ISSUE-1", "phase": "running", "assignedWorkerId": "worker-a"},
				{"issueRef": "ISSUE-2", "phase": "open"}
			]
		}
	}`)

	frame, eventID, err := parseTUIFrame(data)
	require.NoError(t, err)
	assert.Equal(t, tuiFrameTypeBoardUpdate, frame.Type)
	assert.Equal(t, "evt-1", eventID)
	require.NotNil(t, frame.BoardUpdate)
	assert.Equal(t, "acme", frame.BoardUpdate.TeamID)
	assert.Len(t, frame.BoardUpdate.Entries, 2)
	assert.Equal(t, "ISSUE-1", frame.BoardUpdate.Entries[0].IssueRef)
	assert.Equal(t, "running", frame.BoardUpdate.Entries[0].Phase)
	assert.Equal(t, "worker-a", frame.BoardUpdate.Entries[0].AssignedWorkerID)
}

func TestParseTUIFrame_RunEvent(t *testing.T) {
	data := json.RawMessage(`{
		"type": "run-event",
		"eventId": "evt-2",
		"event": {
			"runId": "run-abc",
			"issueRef": "ISSUE-1",
			"eventType": "phase",
			"timestamp": "2024-01-01T00:00:00Z"
		}
	}`)

	frame, eventID, err := parseTUIFrame(data)
	require.NoError(t, err)
	assert.Equal(t, tuiFrameTypeRunEvent, frame.Type)
	assert.Equal(t, "evt-2", eventID)
	require.NotNil(t, frame.RunEvent)
	assert.Equal(t, "run-abc", frame.RunEvent.RunID)
	assert.Equal(t, "ISSUE-1", frame.RunEvent.IssueRef)
	assert.Equal(t, "phase", frame.RunEvent.EventType)
}

func TestParseTUIFrame_WorkerStatus(t *testing.T) {
	data := json.RawMessage(`{
		"type": "worker-status",
		"worker": {
			"workerId": "worker-1",
			"status": "busy",
			"kind": "local"
		}
	}`)

	frame, _, err := parseTUIFrame(data)
	require.NoError(t, err)
	assert.Equal(t, tuiFrameTypeWorkerStatus, frame.Type)
	require.NotNil(t, frame.WorkerStatus)
	assert.Equal(t, "worker-1", frame.WorkerStatus.WorkerID)
	assert.Equal(t, "busy", frame.WorkerStatus.Status)
	assert.Equal(t, "local", frame.WorkerStatus.Kind)
}

func TestParseTUIFrame_ConfigChanged(t *testing.T) {
	data := json.RawMessage(`{
		"type": "config-changed",
		"config": {
			"teamId": "acme",
			"version": "3",
			"hash": "abc123def456"
		}
	}`)

	frame, _, err := parseTUIFrame(data)
	require.NoError(t, err)
	assert.Equal(t, tuiFrameTypeConfigChanged, frame.Type)
	require.NotNil(t, frame.ConfigChanged)
	assert.Equal(t, "abc123def456", frame.ConfigChanged.Hash)
}

func TestParseTUIFrame_UnknownType(t *testing.T) {
	data := json.RawMessage(`{"type": "future-frame-type", "someField": 42}`)

	frame, _, err := parseTUIFrame(data)
	require.NoError(t, err)
	assert.Equal(t, "future-frame-type", frame.Type)
	assert.Nil(t, frame.BoardUpdate)
	assert.Nil(t, frame.RunEvent)
	assert.Nil(t, frame.WorkerStatus)
	assert.Nil(t, frame.ConfigChanged)
}

func TestParseTUIFrame_MalformedJSON(t *testing.T) {
	_, _, err := parseTUIFrame([]byte(`{not valid json`))
	require.Error(t, err)
}

// --- tuiModel.applyFrame ---

func TestTUIModelApplyFrame_BoardUpdate(t *testing.T) {
	m := newTUIModel("acme")
	frame := tuiSubscribeFrame{
		Type: tuiFrameTypeBoardUpdate,
		BoardUpdate: &tuiBoardUpdate{
			TeamID: "acme",
			Entries: []tuiBoardEntry{
				{IssueRef: "B-1", Phase: "open"},
				{IssueRef: "A-2", Phase: "running", AssignedWorkerID: "w1"},
			},
		},
	}

	m = m.applyFrame(frame)

	assert.Len(t, m.boardEntries, 2)
	assert.Equal(t, "open", m.boardEntries["B-1"].Phase)
	assert.Equal(t, "running", m.boardEntries["A-2"].Phase)
	// boardKeys must be sorted.
	require.Len(t, m.boardKeys, 2)
	assert.Equal(t, "A-2", m.boardKeys[0])
	assert.Equal(t, "B-1", m.boardKeys[1])
}

func TestTUIModelApplyFrame_BoardUpdateReplacesOldState(t *testing.T) {
	m := newTUIModel("acme")
	// Apply initial board.
	m = m.applyFrame(tuiSubscribeFrame{
		Type: tuiFrameTypeBoardUpdate,
		BoardUpdate: &tuiBoardUpdate{
			Entries: []tuiBoardEntry{{IssueRef: "OLD-1", Phase: "open"}},
		},
	})
	assert.Len(t, m.boardEntries, 1)

	// Apply replacement board — OLD-1 should be gone.
	m = m.applyFrame(tuiSubscribeFrame{
		Type: tuiFrameTypeBoardUpdate,
		BoardUpdate: &tuiBoardUpdate{
			Entries: []tuiBoardEntry{{IssueRef: "NEW-1", Phase: "running"}},
		},
	})
	assert.Len(t, m.boardEntries, 1)
	assert.Contains(t, m.boardEntries, "NEW-1")
	assert.NotContains(t, m.boardEntries, "OLD-1")
}

func TestTUIModelApplyFrame_RunEventAccumulates(t *testing.T) {
	m := newTUIModel("acme")
	for i := range 25 {
		m = m.applyFrame(tuiSubscribeFrame{
			Type:     tuiFrameTypeRunEvent,
			RunEvent: &tuiRunEvent{RunID: "r", IssueRef: "ISSUE-1", EventType: "tick"},
		})
		_ = i
	}
	// Must not exceed tuiMaxRecentEvents.
	assert.LessOrEqual(t, len(m.recentEvents), tuiMaxRecentEvents)
}

func TestTUIModelApplyFrame_WorkerStatus(t *testing.T) {
	m := newTUIModel("acme")
	m = m.applyFrame(tuiSubscribeFrame{
		Type:         tuiFrameTypeWorkerStatus,
		WorkerStatus: &tuiWorkerStatus{WorkerID: "w1", Status: "idle", Kind: "local"},
	})
	m = m.applyFrame(tuiSubscribeFrame{
		Type:         tuiFrameTypeWorkerStatus,
		WorkerStatus: &tuiWorkerStatus{WorkerID: "w1", Status: "busy"},
	})

	assert.Equal(t, "busy", m.workers["w1"].Status)
}

func TestTUIModelApplyFrame_ConfigChanged(t *testing.T) {
	m := newTUIModel("acme")
	m = m.applyFrame(tuiSubscribeFrame{
		Type:          tuiFrameTypeConfigChanged,
		ConfigChanged: &tuiConfigChanged{Hash: "deadbeef1234"},
	})
	assert.Equal(t, "deadbeef1234", m.configHash)
}

func TestTUIModelApplyFrame_NilPayloadsAreNoOps(t *testing.T) {
	m := newTUIModel("acme")
	// All frames with nil payloads must not panic or mutate state.
	for _, ft := range []string{
		tuiFrameTypeBoardUpdate,
		tuiFrameTypeRunEvent,
		tuiFrameTypeWorkerStatus,
		tuiFrameTypeConfigChanged,
	} {
		m = m.applyFrame(tuiSubscribeFrame{Type: ft})
	}
	assert.Empty(t, m.boardEntries)
	assert.Empty(t, m.workers)
	assert.Empty(t, m.recentEvents)
	assert.Empty(t, m.configHash)
}
