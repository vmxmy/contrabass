//go:build !localonly

package main

import (
	"testing"

	"github.com/spf13/cobra"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// --- subcommand registration ---

func TestDefaultBuild_TUISubcommandPresent(t *testing.T) {
	cmd := newRootCmd()
	var found bool
	for _, sub := range cmd.Commands() {
		if sub.Name() == "tui" {
			found = true
			assert.NotEmpty(t, sub.Use, "tui subcommand must have a Use string")
			assert.NotEmpty(t, sub.Short, "tui subcommand must have a Short description")
			break
		}
	}
	require.True(t, found, "tui subcommand must be registered in the default build")
}

func TestTUICmd_TeamFlagRequired(t *testing.T) {
	cmd := newRootCmd()
	var tuiSub *cobra.Command
	for _, sub := range cmd.Commands() {
		if sub.Name() == "tui" {
			tuiSub = sub
			break
		}
	}
	require.NotNil(t, tuiSub)
	flag := tuiSub.Flags().Lookup("team")
	require.NotNil(t, flag, "tui subcommand must have a --team flag")
}
