//go:build localonly

package main

import (
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestLocalOnlyBuild_WorkerSubcommandPresent verifies that the binary produced
// by "make build LOCAL_ONLY=1" exposes the worker subcommand.
func TestLocalOnlyBuild_WorkerSubcommandPresent(t *testing.T) {
	cmd := newRootCmd()
	names := make([]string, 0, len(cmd.Commands()))
	for _, sub := range cmd.Commands() {
		names = append(names, sub.Name())
	}
	assert.Contains(t, names, "worker", "worker subcommand must be registered in the localonly build")
}

// TestLocalOnlyBuild_TeamSubcommandPresent verifies that the team subcommand —
// which requires internal/team (gated behind localonly) — is registered when
// built with -tags localonly.
func TestLocalOnlyBuild_TeamSubcommandPresent(t *testing.T) {
	cmd := newRootCmd()
	var found bool
	for _, sub := range cmd.Commands() {
		if sub.Name() == "team" {
			found = true
			assert.NotEmpty(t, sub.Use, "team subcommand must have a Use string")
			assert.NotEmpty(t, sub.Short, "team subcommand must have a Short description")
			break
		}
	}
	require.True(t, found, "team subcommand must be registered in the localonly build")
}

// TestLocalOnlyBuild_BothSubcommandsWired verifies that both worker and team
// are registered together — the key property of a LOCAL_ONLY=1 build.
func TestLocalOnlyBuild_BothSubcommandsWired(t *testing.T) {
	cmd := newRootCmd()
	names := make(map[string]bool, len(cmd.Commands()))
	for _, sub := range cmd.Commands() {
		names[sub.Name()] = true
	}
	assert.True(t, names["worker"], "worker subcommand must be present in the localonly build")
	assert.True(t, names["team"], "team subcommand must be present in the localonly build")
}

// TestLocalOnlyBuild_RunIsNotStub verifies that the localonly run() is the
// real server entrypoint, not the build-tag-missing stub. A missing config
// file triggers a config-parse error, not a "server is not available" error.
func TestLocalOnlyBuild_RunIsNotStub(t *testing.T) {
	err := run(filepath.Join(t.TempDir(), "no-such-file.md"), false, "", "info", false, 0, "")
	require.Error(t, err)
	assert.NotContains(t, err.Error(), "server is not available in this build",
		"localonly build must not return the stub error; got: %v", err)
	assert.Contains(t, err.Error(), "parsing workflow config",
		"localonly run() must attempt config parsing before anything else")
}
