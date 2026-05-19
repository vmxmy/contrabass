//go:build localonly

package server

import (
	"context"
	"io"

	"github.com/junhoyeo/contrabass/internal/tracker"
)

// This file is the exported boundary of the cli/server package. Everything else
// in the package stays unexported; only the symbols the localonly CLI wiring
// layer consumes are re-exported here. It mirrors internal/cli/worker/facade.go
// and internal/cli/team/facade.go.

// Config carries the resolved root-command flags and ldflags build metadata
// into the single-host server runtime.
type Config = runConfig

// Run is the single-host server entry point. It parses the workflow config,
// starts the orchestrator (or team execution loop), the embedded dashboard,
// and the Charm TUI, blocking until shutdown.
func Run(cfg Config) error {
	return runServer(cfg)
}

// DispatchOptions configures a single internal-board dispatch pass.
type DispatchOptions = boardDispatchOptions

// DispatchBoardIssues dispatches runnable internal-board issues into team runs.
func DispatchBoardIssues(
	ctx context.Context,
	out io.Writer,
	localTracker *tracker.LocalTracker,
	opts DispatchOptions,
) error {
	return dispatchBoardIssues(ctx, out, localTracker, opts, runBoardDispatchTeam)
}

// SetBoardDispatchTeamRunner overrides the team runner used by the board
// dispatch subcommand, returning a restore func. For CLI-level test wiring
// only — mirrors internal/cli/worker StubDispatchConsumer.
func SetBoardDispatchTeamRunner(runner func(DispatchTeamOptions) error) func() {
	old := runBoardDispatchTeam
	runBoardDispatchTeam = runner
	return func() { runBoardDispatchTeam = old }
}

// DispatchTeamOptions is the option type passed to the board-dispatch team
// runner seam.
type DispatchTeamOptions = teamRunOptions
