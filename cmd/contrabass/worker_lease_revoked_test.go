package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/junhoyeo/contrabass/internal/agent"
	"github.com/junhoyeo/contrabass/internal/types"
	workerv1 "github.com/junhoyeo/contrabass/internal/workerproto/v1"
	"github.com/junhoyeo/contrabass/internal/workspace"
)

func TestDecodeLeaseRevokedFrame(t *testing.T) {
	t.Run("valid frame", func(t *testing.T) {
		data := []byte(`{"type":"lease-revoked","runId":"run-1","reason":"heartbeat_timeout","protocol_version":"1.0.0"}`)
		frame, err := decodeLeaseRevokedFrame(data)
		require.NoError(t, err)
		assert.Equal(t, workerv1.RunID("run-1"), frame.RunID)
		assert.Equal(t, workerv1.LeaseRevokedFrameReasonHeartbeatTimeout, frame.Reason)
	})

	t.Run("missing runId", func(t *testing.T) {
		data := []byte(`{"type":"lease-revoked","reason":"cancelled"}`)
		_, err := decodeLeaseRevokedFrame(data)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "missing runId")
	})

	t.Run("invalid JSON", func(t *testing.T) {
		_, err := decodeLeaseRevokedFrame([]byte(`not-json`))
		require.Error(t, err)
	})
}

func TestWorkerAckingDispatchHandlerRevokeRunSetsLeaseRevokedCause(t *testing.T) {
	handler := newWorkerAckingDispatchHandler(workerRegistration{}, 1, nil)

	runCtx, cancelCause := context.WithCancelCause(context.Background())
	handler.mu.Lock()
	handler.inFlight["run-1"] = cancelCause
	handler.mu.Unlock()

	handler.RevokeRun("run-1")

	require.ErrorIs(t, runCtx.Err(), context.Canceled)
	assert.ErrorIs(t, context.Cause(runCtx), errLeaseRevoked)
}

func TestWorkerAckingDispatchHandlerRevokeRunUnknownIsNoop(t *testing.T) {
	handler := newWorkerAckingDispatchHandler(workerRegistration{}, 1, nil)
	handler.RevokeRun("nonexistent-run-id") // must not panic
}

func TestConsumeWorkerDispatchesRoutesLeaseRevokedFrame(t *testing.T) {
	leaseRevokedJSON := `{"type":"lease-revoked","runId":"run-42","reason":"heartbeat_timeout","protocol_version":"1.0.0"}`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		require.NoError(t, err)
		defer conn.CloseNow()
		require.NoError(t, conn.Write(r.Context(), websocket.MessageText, []byte(leaseRevokedJSON)))
	}))
	defer server.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	revoked := make(chan workerv1.RunID, 1)
	err := consumeWorkerDispatches(ctx, workerRegistration{
		SessionToken: "token",
		DispatchChannel: workerv1.WorkerRegisterResponseDispatchChannel{
			WsURL: workerv1.WsURL(strings.Replace(server.URL, "http://", "ws://", 1)),
		},
	}, func(_ context.Context, _ workerv1.WorkerDispatchFrame) error {
		return nil
	}, func(runID workerv1.RunID) {
		revoked <- runID
		cancel()
	})

	require.ErrorIs(t, err, context.Canceled)
	select {
	case got := <-revoked:
		assert.Equal(t, workerv1.RunID("run-42"), got)
	case <-time.After(time.Second):
		t.Fatal("lease-revoked handler was not called")
	}
}

func TestWorkerRunExecutorGracefulStopOnLeaseRevoke(t *testing.T) {
	doneCh := make(chan error)
	var stopOnce sync.Once
	runner := &leaseRevokeTestRunner{
		process: &agent.AgentProcess{
			PID:    0,
			Events: make(chan types.AgentEvent),
			Done:   doneCh,
		},
		onStop: func() {
			stopOnce.Do(func() { close(doneCh) })
		},
	}

	// Heartbeat that immediately signals lease revocation.
	heartbeat := &workerHeartbeatScheduler{
		post: func(_ context.Context, _ workerv1.RunID, _ workerv1.WorkerHeartbeatRequest) error {
			return errWorkerLeaseRevoked
		},
		interval: func(_ workerRegistration, _ workerv1.LeaseSec) time.Duration {
			return time.Millisecond
		},
		jitter: func(_ time.Duration) time.Duration { return 0 },
		now:    time.Now,
	}

	executor, err := newWorkerRunExecutor(workerRunExecutorConfig{
		Capabilities: []workerv1.Capability{"agent:mock"},
		Provision: func(_ context.Context, _ *workspace.Manager, _ types.Issue) (string, error) {
			return t.TempDir(), nil
		},
		NewRunner:  func(_ string) (agent.AgentRunner, error) { return runner, nil },
		PostEvents: func(_ context.Context, _ workerv1.RunID, _ []workerv1.WorkerEventLine) error { return nil },
		Heartbeat:  heartbeat,
	})
	require.NoError(t, err)

	runErrCh := make(chan error, 1)
	go func() {
		runErrCh <- executor.Run(context.Background(), workerv1.WorkerDispatchFrame{
			RunID:    "run-lease-revoke",
			IssueRef: "LIN-1",
		})
	}()

	select {
	case err := <-runErrCh:
		assert.ErrorIs(t, err, errWorkerLeaseRevoked)
	case <-time.After(2 * time.Second):
		t.Fatal("executor.Run did not return within 2 seconds after lease revocation")
	}
}

type leaseRevokeTestRunner struct {
	process *agent.AgentProcess
	onStop  func()
}

func (r *leaseRevokeTestRunner) Start(_ context.Context, _ types.Issue, _ string, _ string) (*agent.AgentProcess, error) {
	return r.process, nil
}

func (r *leaseRevokeTestRunner) Stop(_ *agent.AgentProcess) error {
	if r.onStop != nil {
		r.onStop()
	}
	return nil
}

func (r *leaseRevokeTestRunner) Close() error { return nil }
