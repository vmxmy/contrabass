package main

import (
	"context"
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
