package main

import (
	"bytes"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestWorkerCommandIsRegistered(t *testing.T) {
	cmd := newRootCmd()

	worker, _, err := cmd.Find([]string{"worker"})
	require.NoError(t, err)
	require.NotNil(t, worker)
	assert.Equal(t, "worker", worker.Name())
}

func TestWorkerCommandValidation(t *testing.T) {
	tests := []struct {
		name        string
		args        []string
		wantErr     string
		wantNoError bool
	}{
		{
			name:    "requires team flag",
			args:    []string{"worker"},
			wantErr: `required flag(s) "team" not set`,
		},
		{
			name:    "without enrollment instructs login",
			args:    []string{"worker", "--team", "my-team"},
			wantErr: `run "contrabass worker login" first`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cmd := newRootCmd()
			buf := new(bytes.Buffer)
			cmd.SetOut(buf)
			cmd.SetErr(buf)
			cmd.SetArgs(tt.args)

			err := cmd.Execute()
			if tt.wantNoError {
				require.NoError(t, err)
				return
			}

			require.Error(t, err)
			assert.Contains(t, err.Error(), tt.wantErr)
		})
	}
}

func TestWorkerCommandHelpDocumentsEnrollment(t *testing.T) {
	cmd := newRootCmd()
	buf := new(bytes.Buffer)
	cmd.SetOut(buf)
	cmd.SetErr(buf)
	cmd.SetArgs([]string{"worker", "--help"})

	require.NoError(t, cmd.Execute())
	output := buf.String()
	assert.Contains(t, output, "--team")
	assert.Contains(t, output, `contrabass worker login`)
}
