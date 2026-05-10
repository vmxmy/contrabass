//go:build !localonly

package main

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestDefaultBuild_WorkerSubcommandPresent verifies that the binary produced by
// "make build" (no -tags localonly) exposes the worker subcommand.
func TestDefaultBuild_WorkerSubcommandPresent(t *testing.T) {
	cmd := newRootCmd()
	names := make([]string, 0, len(cmd.Commands()))
	for _, sub := range cmd.Commands() {
		names = append(names, sub.Name())
	}
	assert.Contains(t, names, "worker", "worker subcommand must be registered in the default build")
}

// TestDefaultBuild_TeamSubcommandAbsent verifies that the team subcommand —
// which depends on internal/team (localonly) — is not registered in the default
// build.
func TestDefaultBuild_TeamSubcommandAbsent(t *testing.T) {
	cmd := newRootCmd()
	for _, sub := range cmd.Commands() {
		assert.NotEqual(t, "team", sub.Name(),
			"team subcommand must NOT be registered in the default build (requires -tags localonly)")
	}
}

// TestDefaultBuild_ServerStubError verifies that invoking the root command's
// run function (the server entrypoint) returns the build-tag-missing error so
// the user gets a clear message instead of a panic or silent failure.
func TestDefaultBuild_ServerStubError(t *testing.T) {
	err := run("", false, "", "", false, 0, "")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "server is not available in this build")
	assert.Contains(t, err.Error(), "localonly")
}

// TestDefaultBuild_WorkerSubcommandWired verifies that the worker subcommand
// has a non-empty Use and Short description so it renders correctly in --help.
// Uses structural inspection only to avoid mutating the package-level workerCmd
// flag state shared across tests.
func TestDefaultBuild_WorkerSubcommandWired(t *testing.T) {
	cmd := newRootCmd()
	var found bool
	for _, sub := range cmd.Commands() {
		if sub.Name() == "worker" {
			found = true
			assert.NotEmpty(t, sub.Use, "worker subcommand must have a Use string")
			assert.NotEmpty(t, sub.Short, "worker subcommand must have a Short description")
			break
		}
	}
	require.True(t, found, "worker subcommand must be registered")
}
