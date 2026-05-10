package main

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/junhoyeo/contrabass/internal/agent"
	"github.com/junhoyeo/contrabass/internal/tmux"
	"github.com/junhoyeo/contrabass/internal/types"
	workerv1 "github.com/junhoyeo/contrabass/internal/workerproto/v1"
	"github.com/junhoyeo/contrabass/internal/workspace"
)

func TestWorkerRunExecutorRun(t *testing.T) {
	tests := []struct {
		name         string
		capabilities []workerv1.Capability
		wantCalls    []string
		wantAgent    string
	}{
		{
			name:         "tmux capable provisions opens pane then runs agent",
			capabilities: []workerv1.Capability{"agent:codex", "tmux"},
			wantCalls:    []string{"provision", "open-pane", "new-runner:codex", "run-agent", "close-runner"},
			wantAgent:    "codex",
		},
		{
			name:         "without tmux skips pane and still runs agent",
			capabilities: []workerv1.Capability{"agent:opencode"},
			wantCalls:    []string{"provision", "new-runner:opencode", "run-agent", "close-runner"},
			wantAgent:    "opencode",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var mu sync.Mutex
			var calls []string
			appendCall := func(call string) {
				mu.Lock()
				defer mu.Unlock()
				calls = append(calls, call)
			}

			executor, err := newWorkerRunExecutor(workerRunExecutorConfig{
				TeamID:       "team-1",
				WorkerID:     "worker-1",
				Capabilities: tt.capabilities,
				Provision: func(_ context.Context, _ *workspace.Manager, issue types.Issue) (string, error) {
					appendCall("provision")
					assert.Equal(t, "run-1", issue.ID)
					assert.Equal(t, "LIN-123", issue.Identifier)
					assert.Equal(t, "contrabass/run-1", issue.BranchName)
					return "/tmp/workspace-run-1", nil
				},
				OpenPane: func(_ context.Context, _ *tmux.Session, title string, workdir string) (string, error) {
					appendCall("open-pane")
					assert.Equal(t, "LIN-123", title)
					assert.Equal(t, "/tmp/workspace-run-1", workdir)
					return "%7", nil
				},
				NewRunner: func(agentType string) (agent.AgentRunner, error) {
					appendCall("new-runner:" + agentType)
					assert.Equal(t, tt.wantAgent, agentType)
					return &recordingAgentRunner{onClose: func() { appendCall("close-runner") }}, nil
				},
				RunAgent: func(_ context.Context, runner agent.AgentRunner, issue types.Issue, workdir string, prompt string) error {
					appendCall("run-agent")
					require.IsType(t, &recordingAgentRunner{}, runner)
					assert.Equal(t, "run-1", issue.ID)
					assert.Equal(t, "/tmp/workspace-run-1", workdir)
					assert.Equal(t, "fix it", prompt)
					return nil
				},
			})
			require.NoError(t, err)

			err = executor.Run(context.Background(), workerv1.WorkerDispatchFrame{
				RunID:    "run-1",
				IssueRef: "LIN-123",
				Branch:   "contrabass/run-1",
				Prompt:   "fix it",
			})
			require.NoError(t, err)

			mu.Lock()
			gotCalls := append([]string(nil), calls...)
			mu.Unlock()
			assert.Equal(t, tt.wantCalls, gotCalls)
		})
	}
}

func TestWorkerRunExecutorErrors(t *testing.T) {
	tests := []struct {
		name    string
		config  workerRunExecutorConfig
		frame   workerv1.WorkerDispatchFrame
		wantErr string
	}{
		{
			name: "requires agent capability",
			config: workerRunExecutorConfig{
				Capabilities: []workerv1.Capability{"tmux"},
			},
			wantErr: "no agent runner capability",
		},
		{
			name: "requires run id",
			config: workerRunExecutorConfig{
				Capabilities: []workerv1.Capability{"agent:mock"},
			},
			frame:   workerv1.WorkerDispatchFrame{IssueRef: "LIN-123"},
			wantErr: "missing runId",
		},
		{
			name: "wraps provision errors",
			config: workerRunExecutorConfig{
				Capabilities: []workerv1.Capability{"agent:mock"},
				Provision: func(context.Context, *workspace.Manager, types.Issue) (string, error) {
					return "", errors.New("git worktree failed")
				},
			},
			frame:   workerv1.WorkerDispatchFrame{RunID: "run-1", IssueRef: "LIN-123"},
			wantErr: "provision worker workspace",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			executor, err := newWorkerRunExecutor(tt.config)
			if tt.frame.RunID == "" && tt.name == "requires agent capability" {
				require.Error(t, err)
				assert.Contains(t, err.Error(), tt.wantErr)
				return
			}
			require.NoError(t, err)

			err = executor.Run(context.Background(), tt.frame)
			require.Error(t, err)
			assert.Contains(t, err.Error(), tt.wantErr)
		})
	}
}

type recordingAgentRunner struct {
	onClose func()
}

func (r *recordingAgentRunner) Start(context.Context, types.Issue, string, string) (*agent.AgentProcess, error) {
	return nil, errors.New("unexpected Start call")
}

func (r *recordingAgentRunner) Stop(*agent.AgentProcess) error { return nil }

func (r *recordingAgentRunner) Close() error {
	if r.onClose != nil {
		r.onClose()
	}
	return nil
}
