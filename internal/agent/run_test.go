package agent

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/junhoyeo/contrabass/internal/types"
)

func TestRun(t *testing.T) {
	tests := []struct {
		name    string
		runner  *MockRunner
		wantErr string
	}{
		{
			name: "drains events and returns nil on success",
			runner: &MockRunner{Events: []types.AgentEvent{
				{Type: "log", Data: map[string]interface{}{"message": "one"}},
				{Type: "log", Data: map[string]interface{}{"message": "two"}},
			}},
		},
		{
			name:    "returns start errors",
			runner:  &MockRunner{StartErr: errors.New("start failed")},
			wantErr: "start agent process",
		},
		{
			name:    "returns done errors",
			runner:  &MockRunner{DoneErr: errors.New("agent failed")},
			wantErr: "agent failed",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := Run(context.Background(), tt.runner, types.Issue{ID: "ISSUE-1"}, t.TempDir(), "fix it")
			if tt.wantErr == "" {
				require.NoError(t, err)
				return
			}
			require.Error(t, err)
			assert.Contains(t, err.Error(), tt.wantErr)
		})
	}
}

func TestRunRejectsNilRunner(t *testing.T) {
	err := Run(context.Background(), nil, types.Issue{ID: "ISSUE-1"}, t.TempDir(), "fix it")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "agent runner is nil")
}
