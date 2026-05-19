package main

import (
	"github.com/spf13/cobra"

	"github.com/junhoyeo/contrabass/internal/cli/configcmd"
)

// Thin re-exports kept so main.go continues to wire the "config" command
// against the original package-main identifiers after the cloud config
// runtime moved to internal/cli/configcmd. These add no logic.

var configCmd = newConfigCmd()

func newConfigCmd() *cobra.Command { return configcmd.NewCmd() }
