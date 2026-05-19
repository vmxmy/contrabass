package worker

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
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

// TestLeaseRevocationUploadsPartialArtifactsToPresignedURLs validates that when a
// run's lease is revoked via heartbeat 409, the worker uploads whatever partial
// artifact files exist in the workspace to the presigned R2 PUT URLs from the
// dispatch frame, and calls workspace cleanup.
func TestLeaseRevocationUploadsPartialArtifactsToPresignedURLs(t *testing.T) {
	var mu sync.Mutex
	var uploadedPaths []string

	// Minimal R2 stand-in: accepts PUT requests and records their URL paths.
	r2 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPut {
			mu.Lock()
			uploadedPaths = append(uploadedPaths, r.URL.Path)
			mu.Unlock()
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer r2.Close()

	// Workspace with partial artifacts the agent wrote before the lease fired.
	workspaceDir := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(workspaceDir, "logs.ndjson"), []byte("{\"ts\":1}\n"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(workspaceDir, "diff.patch"), []byte("--- a\n+++ b\n"), 0o644))

	// Heartbeat that immediately returns errWorkerLeaseRevoked (simulates cloud
	// sending 409 when the lease alarm fires due to missed heartbeats).
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

	doneCh := make(chan error)
	var stopOnce sync.Once
	runner := &leaseRevokeTestRunner{
		process: &agent.AgentProcess{
			PID:    0,
			Events: make(chan types.AgentEvent),
			Done:   doneCh,
		},
		onStop: func() { stopOnce.Do(func() { close(doneCh) }) },
	}

	cleanupCalled := make(chan string, 1)

	// Route artifact PUT requests through the R2 test server's HTTP client.
	restore := stubWorkerLoginDependencies(t, r2.Client(), &fakeWorkerEnrollmentStore{})
	defer restore()

	executor, err := newWorkerRunExecutor(workerRunExecutorConfig{
		Capabilities: []workerv1.Capability{"agent:mock"},
		Provision: func(_ context.Context, _ *workspace.Manager, _ types.Issue) (string, error) {
			return workspaceDir, nil
		},
		NewRunner:  func(_ string) (agent.AgentRunner, error) { return runner, nil },
		PostEvents: func(_ context.Context, _ workerv1.RunID, _ []workerv1.WorkerEventLine) error { return nil },
		Heartbeat:  heartbeat,
		CleanupWorkspace: func(_ context.Context, issueID string) error {
			cleanupCalled <- issueID
			return nil
		},
	})
	require.NoError(t, err)

	frame := workerv1.WorkerDispatchFrame{
		RunID:    "run-partial-999",
		IssueRef: "LIN-999",
		ArtifactUploadURLs: workerv1.WorkerDispatchFrameArtifactUploadURLs{
			Logs: workerv1.URL(r2.URL + "/bucket/run-partial-999/logs.ndjson"),
			Diff: workerv1.URL(r2.URL + "/bucket/run-partial-999/diff.patch"),
		},
	}

	err = executor.Run(context.Background(), frame)
	assert.ErrorIs(t, err, errWorkerLeaseRevoked)

	mu.Lock()
	paths := append([]string(nil), uploadedPaths...)
	mu.Unlock()
	assert.Contains(t, paths, "/bucket/run-partial-999/logs.ndjson",
		"logs.ndjson must be PUT to the presigned URL on lease revocation")
	assert.Contains(t, paths, "/bucket/run-partial-999/diff.patch",
		"diff.patch must be PUT to the presigned URL on lease revocation")

	select {
	case id := <-cleanupCalled:
		assert.Equal(t, "run-partial-999", id)
	case <-time.After(time.Second):
		t.Fatal("workspace cleanup was not called after lease revocation")
	}
}

// TestLeaseRevocationFullChainViaWSFrame is the primary task 16.3 validation.
// It exercises the complete lease-revocation sequence triggered by a
// "lease-revoked" WebSocket frame (the cloud's signal after heartbeat timeout):
//
//  1. Cloud dispatches a run over WebSocket.
//  2. Worker acks within the SLA.
//  3. Worker starts executing a mock agent.
//  4. Cloud sends "lease-revoked" frame (simulating heartbeat_timeout after kill).
//  5. Worker stops the agent (SIGTERM via runner.Stop, SIGKILL after grace period).
//  6. Worker uploads partial artifacts to presigned R2 PUT URLs.
//  7. Worker releases the workspace.
//  8. Run is removed from the in-flight map (cloud can requeue to another worker).
func TestLeaseRevocationFullChainViaWSFrame(t *testing.T) {
	// Shorten the grace period; the mock runner exits on Stop so SIGKILL won't
	// fire, but a short period keeps the test fast even if timing is off.
	old := workerLeaseRevokedGracePeriod
	workerLeaseRevokedGracePeriod = 50 * time.Millisecond
	defer func() { workerLeaseRevokedGracePeriod = old }()

	const runID = "run-ws-revoke-001"

	stopCalled := make(chan struct{}, 1)
	var stopOnce sync.Once
	cleanupCalled := make(chan string, 1)
	ackPosted := make(chan struct{}, 1)
	var uploadedPaths sync.Map

	// Create workspace with a partial log so we can assert it was uploaded.
	workspaceDir := t.TempDir()
	require.NoError(t, os.WriteFile(
		filepath.Join(workspaceDir, "logs.ndjson"),
		[]byte("{\"ts\":1,\"kind\":\"start\",\"payload\":{}}\n"),
		0o644,
	))

	// Mock agent: blocks until Stop closes doneCh.
	doneCh := make(chan error)
	runner := &leaseRevokeTestRunner{
		process: &agent.AgentProcess{
			PID:    0,
			Events: make(chan types.AgentEvent),
			Done:   doneCh,
		},
		onStop: func() {
			stopOnce.Do(func() {
				stopCalled <- struct{}{}
				close(doneCh)
			})
		},
	}

	// Declare server before the handler so the closure can embed the server URL
	// inside the dispatch JSON's artifact upload URLs.
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/dispatch-ws":
			conn, err := websocket.Accept(w, r, nil)
			if err != nil {
				return
			}
			defer conn.CloseNow()

			dispatchJSON := fmt.Sprintf(
				`{"type":"dispatch","protocol_version":"1.0.0","runId":%q,`+
					`"issueRef":"LIN-999","branch":"contrabass/%s","prompt":"fix",`+
					`"configHash":"","leaseSec":60,"ackDeadlineSec":5,`+
					`"artifactUploadURLs":{"logs":%q,"diff":"","summary":""}}`,
				runID, runID,
				server.URL+"/r2/bucket/"+runID+"/logs.ndjson",
			)
			if err := conn.Write(r.Context(), websocket.MessageText, []byte(dispatchJSON)); err != nil {
				return
			}
			// Wait for the worker to ack before sending lease-revoked so the
			// run is properly in-flight when revocation arrives.
			select {
			case <-ackPosted:
			case <-r.Context().Done():
				return
			}
			leaseRevokedJSON := fmt.Sprintf(
				`{"type":"lease-revoked","runId":%q,"reason":"heartbeat_timeout","protocol_version":"1.0.0"}`,
				runID,
			)
			_ = conn.Write(r.Context(), websocket.MessageText, []byte(leaseRevokedJSON))
			<-r.Context().Done()

		case strings.HasSuffix(r.URL.Path, "/ack"):
			select {
			case ackPosted <- struct{}{}:
			default:
			}
			w.WriteHeader(http.StatusNoContent)

		case strings.HasSuffix(r.URL.Path, "/heartbeat"):
			w.WriteHeader(http.StatusOK)

		case strings.HasPrefix(r.URL.Path, "/r2/"):
			if r.Method == http.MethodPut {
				uploadedPaths.Store(r.URL.Path, true)
			}
			w.WriteHeader(http.StatusOK)

		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	restore := stubWorkerLoginDependencies(t, server.Client(), &fakeWorkerEnrollmentStore{})
	defer restore()

	executor, err := newWorkerRunExecutor(workerRunExecutorConfig{
		Capabilities: []workerv1.Capability{"agent:mock"},
		Provision: func(_ context.Context, _ *workspace.Manager, _ types.Issue) (string, error) {
			return workspaceDir, nil
		},
		NewRunner:  func(_ string) (agent.AgentRunner, error) { return runner, nil },
		PostEvents: func(_ context.Context, _ workerv1.RunID, _ []workerv1.WorkerEventLine) error { return nil },
		CleanupWorkspace: func(_ context.Context, issueID string) error {
			cleanupCalled <- issueID
			return nil
		},
	})
	require.NoError(t, err)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	ackHandler := newWorkerAckingDispatchHandler(workerRegistration{
		APIBaseURL:   server.URL,
		SessionToken: "test-session",
	}, 1, executor.Run)

	// Wrap RevokeRun to cancel the WS consumer loop immediately after revocation
	// so the test doesn't wait for reconnect delays.
	wrappedRevoke := func(id workerv1.RunID) {
		ackHandler.RevokeRun(id)
		cancel()
	}

	wsURL := strings.Replace(server.URL, "http://", "ws://", 1)
	_ = consumeWorkerDispatches(ctx, workerRegistration{
		SessionToken: "test-session",
		APIBaseURL:   server.URL,
		DispatchChannel: workerv1.WorkerRegisterResponseDispatchChannel{
			WsURL: workerv1.WsURL(wsURL + "/dispatch-ws"),
		},
	}, ackHandler.Handle, wrappedRevoke)
	// consumeWorkerDispatches returns here because wrappedRevoke called cancel().

	// Wait for agent stop — the executor goroutine may still be running cleanup.
	select {
	case <-stopCalled:
	case <-time.After(2 * time.Second):
		t.Fatal("runner.Stop was not called after lease-revoked WS frame")
	}

	// Workspace must be released after the agent is stopped.
	select {
	case id := <-cleanupCalled:
		assert.Equal(t, runID, id)
	case <-time.After(2 * time.Second):
		t.Fatal("workspace cleanup was not called after lease revocation")
	}

	// The partial log artifact must have been PUT to the presigned R2 URL.
	_, logsUploaded := uploadedPaths.Load("/r2/bucket/" + runID + "/logs.ndjson")
	assert.True(t, logsUploaded, "logs.ndjson must be uploaded to the presigned R2 URL on lease revocation")

	// The run must be removed from the in-flight map so the cloud can requeue it.
	require.Eventually(t, func() bool {
		ackHandler.mu.Lock()
		defer ackHandler.mu.Unlock()
		_, inFlight := ackHandler.inFlight[workerv1.RunID(runID)]
		return !inFlight
	}, 2*time.Second, 10*time.Millisecond, "run must be removed from in-flight map after lease revocation")
}
