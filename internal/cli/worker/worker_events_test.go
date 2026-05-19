package worker

import (
	"bufio"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/junhoyeo/contrabass/internal/agent"
	"github.com/junhoyeo/contrabass/internal/types"
	workerv1 "github.com/junhoyeo/contrabass/internal/workerproto/v1"
	"github.com/junhoyeo/contrabass/internal/workspace"
)

func TestWorkerEventBatcherFlushesByLimits(t *testing.T) {
	tests := []struct {
		name        string
		maxEvents   int
		maxBytes    int
		events      []types.AgentEvent
		wantBatches []int
	}{
		{
			name:      "max events",
			maxEvents: 2,
			maxBytes:  workerEventsMaxBytes,
			events: []types.AgentEvent{
				{Type: "log", Data: map[string]interface{}{"message": "one"}},
				{Type: "log", Data: map[string]interface{}{"message": "two"}},
				{Type: "log", Data: map[string]interface{}{"message": "three"}},
			},
			wantBatches: []int{2, 1},
		},
		{
			name:      "max bytes",
			maxEvents: workerEventsMaxPerBatch,
			maxBytes:  260,
			events: []types.AgentEvent{
				{Type: "log", Data: map[string]interface{}{"message": strings.Repeat("a", 100)}},
				{Type: "log", Data: map[string]interface{}{"message": strings.Repeat("b", 100)}},
			},
			wantBatches: []int{1, 1},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var gotBatches []int
			batcher := newWorkerEventBatcher(func(_ context.Context, _ workerv1.RunID, events []workerv1.WorkerEventLine) error {
				gotBatches = append(gotBatches, len(events))
				payload, err := encodeWorkerEventsNDJSON(events)
				require.NoError(t, err)
				assert.LessOrEqual(t, len(payload), tt.maxBytes)
				return nil
			})
			batcher.maxEvents = tt.maxEvents
			batcher.maxBytes = tt.maxBytes
			batcher.flushInterval = time.Hour
			batcher.now = func() time.Time { return time.Unix(1, 0) }

			eventCh := make(chan types.AgentEvent, len(tt.events))
			for _, event := range tt.events {
				eventCh <- event
			}
			close(eventCh)

			require.NoError(t, batcher.Consume(context.Background(), "run-1", eventCh))
			assert.Equal(t, tt.wantBatches, gotBatches)
		})
	}
}

func TestWorkerEventBatcherFlushesByLatency(t *testing.T) {
	posted := make(chan []workerv1.WorkerEventLine, 1)
	batcher := newWorkerEventBatcher(func(_ context.Context, _ workerv1.RunID, events []workerv1.WorkerEventLine) error {
		posted <- events
		return nil
	})
	batcher.flushInterval = 10 * time.Millisecond
	batcher.now = func() time.Time { return time.Unix(1, 0) }

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	eventCh := make(chan types.AgentEvent, 1)
	eventCh <- types.AgentEvent{Type: "turn/completed"}

	done := make(chan error, 1)
	go func() { done <- batcher.Consume(ctx, "run-1", eventCh) }()

	select {
	case batch := <-posted:
		require.Len(t, batch, 1)
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for latency flush")
	}
	cancel()
	assert.ErrorIs(t, <-done, context.Canceled)
}

func TestPostWorkerEventsUsesNDJSONAndSplitsOn413(t *testing.T) {
	var mu sync.Mutex
	var bodies []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "/v1/runs/run-1/events", r.URL.Path)
		assert.Equal(t, "Bearer session-token", r.Header.Get("Authorization"))
		assert.Equal(t, "application/x-ndjson", r.Header.Get("Content-Type"))
		body, err := io.ReadAll(r.Body)
		require.NoError(t, err)
		lineCount := countNDJSONLines(string(body))
		if lineCount > 1 {
			w.WriteHeader(http.StatusRequestEntityTooLarge)
			_, _ = w.Write([]byte(`{"error":"events_too_large"}`))
			return
		}
		mu.Lock()
		bodies = append(bodies, string(body))
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	events := []workerv1.WorkerEventLine{
		{"protocol_version": "1.0.0", "ts": int64(1), "kind": "log", "payload": map[string]interface{}{"level": "info", "message": "one"}},
		{"protocol_version": "1.0.0", "ts": int64(2), "kind": "log", "payload": map[string]interface{}{"level": "info", "message": "two"}},
	}
	err := postWorkerEvents(context.Background(), workerRegistration{APIBaseURL: server.URL, SessionToken: "session-token"}, "run-1", events)
	require.NoError(t, err)
	assert.Len(t, bodies, 2)
	for _, body := range bodies {
		assert.Equal(t, 1, countNDJSONLines(body))
		assert.True(t, strings.HasSuffix(body, "\n"))
	}
}

func TestWorkerRunExecutorPostsAgentEvents(t *testing.T) {
	posted := make(chan string, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		require.NoError(t, err)
		posted <- string(body)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	executor, err := newWorkerRunExecutor(workerRunExecutorConfig{
		TeamID:       "team-1",
		WorkerID:     "worker-1",
		Capabilities: []workerv1.Capability{"agent:mock"},
		Registration: workerRegistration{APIBaseURL: server.URL, SessionToken: "session-token"},
		Provision: func(context.Context, *workspace.Manager, types.Issue) (string, error) {
			return t.TempDir(), nil
		},
		NewRunner: func(string) (agent.AgentRunner, error) {
			return &eventPostingAgentRunner{events: []types.AgentEvent{
				{Type: "turn/completed", Data: map[string]interface{}{"message": "done"}, Timestamp: time.UnixMilli(10)},
			}}, nil
		},
	})
	require.NoError(t, err)

	err = executor.Run(context.Background(), workerv1.WorkerDispatchFrame{RunID: "run-1", IssueRef: "LIN-1", Prompt: "fix"})
	require.NoError(t, err)

	select {
	case body := <-posted:
		assert.Equal(t, 1, countNDJSONLines(body))
		assert.Contains(t, body, `"kind":"log"`)
		assert.Contains(t, body, `turn/completed: done`)
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for posted events")
	}
}

func countNDJSONLines(body string) int {
	scanner := bufio.NewScanner(strings.NewReader(body))
	count := 0
	for scanner.Scan() {
		if strings.TrimSpace(scanner.Text()) != "" {
			count++
		}
	}
	return count
}

type eventPostingAgentRunner struct {
	events []types.AgentEvent
}

func (r *eventPostingAgentRunner) Start(context.Context, types.Issue, string, string) (*agent.AgentProcess, error) {
	events := make(chan types.AgentEvent, len(r.events))
	for _, event := range r.events {
		events <- event
	}
	close(events)
	done := make(chan error, 1)
	done <- nil
	close(done)
	return &agent.AgentProcess{Events: events, Done: done}, nil
}

func (r *eventPostingAgentRunner) Stop(*agent.AgentProcess) error { return nil }
func (r *eventPostingAgentRunner) Close() error                   { return nil }

var _ agent.AgentRunner = (*eventPostingAgentRunner)(nil)
