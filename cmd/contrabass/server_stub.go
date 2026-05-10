//go:build !localonly

package main

import (
	"errors"

	"github.com/spf13/cobra"
)

// run returns an error in non-localonly builds. The server runtime requires
// internal/orchestrator, internal/hub, internal/web, and internal/team which
// are gated behind the localonly build tag. Rebuild with -tags localonly to
// enable the full single-host server.
func run(_ string, _ bool, _, _ string, _ bool, _ int, _ string) error {
	return errors.New("server is not available in this build; rebuild with -tags localonly")
}

// localOnlySubcmds returns nil in non-localonly builds; the team subcommand
// requires packages gated behind the localonly build tag.
func localOnlySubcmds() []*cobra.Command {
	return nil
}
