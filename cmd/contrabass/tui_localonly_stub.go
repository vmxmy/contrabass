//go:build localonly

package main

import (
	"fmt"

	"github.com/spf13/cobra"
)

// tuiCmd is a stub for localonly builds. The cloud TUI requires the default
// (non-localonly) build; localonly builds embed TUI rendering in `contrabass server`.
var tuiCmd = &cobra.Command{
	Use:   "tui",
	Short: "Watch the cloud team board (not available in local-only builds)",
	Long:  "The tui subcommand connects to the cloud control plane and is not available in local-only builds. Use `contrabass server` for the local TUI.",
	RunE: func(_ *cobra.Command, _ []string) error {
		return fmt.Errorf("tui subcommand is not available in local-only builds; use `contrabass server` instead")
	},
}
