//go:build localonly

package team

import (
	"context"
	"log/slog"

	"github.com/junhoyeo/contrabass/internal/agent"
	"github.com/junhoyeo/contrabass/internal/config"
	"github.com/junhoyeo/contrabass/internal/tracker"
	"github.com/junhoyeo/contrabass/internal/types"
)

// This file is the exported boundary of the team package. Everything else in
// the package stays unexported; only the symbols the CLI wiring layer and the
// (untouched) localonly board/server/team-root files consume are re-exported
// here. It mirrors internal/cli/worker/facade.go.

// RunOptions configures a `contrabass team run` invocation.
type RunOptions = runOptions

// RunHooks injects a parent context, event handlers, and signal-handling
// behaviour into a team run. Used by the localonly TUI/web execution loop.
type RunHooks = runHooks

// EventHandler observes team lifecycle events during a run.
type EventHandler = eventHandler

// RunWithOptions runs the staged team pipeline with the given options.
func RunWithOptions(opts RunOptions) error {
	return runTeamWithOptions(opts)
}

// RunWithHooks runs the staged team pipeline with the given options and hooks.
func RunWithHooks(opts RunOptions, hooks RunHooks) error {
	return runTeamWithHooks(opts, hooks)
}

// ShowStatus prints the JSON status of a team to stdout.
func ShowStatus(cfgPath, teamName string) error {
	return showTeamStatus(cfgPath, teamName)
}

// Cancel cancels a running team.
func Cancel(cfgPath, teamName string) error {
	return cancelTeam(cfgPath, teamName)
}

// WorkerOptions configures a `contrabass team worker` invocation.
type WorkerOptions = workerOptions

// RunWorker runs a single team worker in a tmux pane.
func RunWorker(opts WorkerOptions) error {
	return runTeamWorker(opts)
}

// CreateRunner constructs an AgentRunner from the workflow config. Exported so
// the (untouched) localonly orchestrator path can build a runner.
func CreateRunner(cfg *config.WorkflowConfig, teamName string, logger *slog.Logger) (agent.AgentRunner, error) {
	return createRunner(cfg, teamName, logger)
}

// ResolveTeamNameForIssue resolves the team name for a board issue, honouring
// an optional override. Exported for the board-dispatch wiring layer.
func ResolveTeamNameForIssue(issue tracker.LocalBoardIssue, override string) string {
	return resolveTeamNameForIssue(issue, override)
}

// BuildTeamTasksFromBoardIssue builds the staged task list for a board issue.
func BuildTeamTasksFromBoardIssue(issue tracker.LocalBoardIssue) []types.TeamTask {
	return buildTeamTasksFromBoardIssue(issue)
}

// LogTeamEvents drains a team event channel into the structured logger until
// the channel closes or the context is cancelled.
func LogTeamEvents(ctx context.Context, logger *slog.Logger, events <-chan types.TeamEvent) {
	logTeamEvents(ctx, logger, events)
}
