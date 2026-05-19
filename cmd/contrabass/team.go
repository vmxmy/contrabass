//go:build localonly

package main

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/spf13/cobra"

	"github.com/junhoyeo/contrabass/internal/agent"
	"github.com/junhoyeo/contrabass/internal/cli/team"
	"github.com/junhoyeo/contrabass/internal/config"
	"github.com/junhoyeo/contrabass/internal/tracker"
	"github.com/junhoyeo/contrabass/internal/types"
)

// Thin re-exports kept so the (untouched) localonly board/server/team-root
// files continue to compile against the original package-main identifiers
// after the team runtime moved to internal/cli/team. These add no logic —
// they forward to the package. Mirrors cmd/contrabass/worker.go.

type teamRunOptions = team.RunOptions

type teamRunHooks = team.RunHooks

type teamEventHandler = team.EventHandler

func runTeamWithOptions(opts teamRunOptions) error { return team.RunWithOptions(opts) }

func runTeamWithHooks(opts teamRunOptions, hooks teamRunHooks) error {
	return team.RunWithHooks(opts, hooks)
}

func createRunner(cfg *config.WorkflowConfig, teamName string, logger *slog.Logger) (agent.AgentRunner, error) {
	return team.CreateRunner(cfg, teamName, logger)
}

func resolveTeamNameForIssue(issue tracker.LocalBoardIssue, override string) string {
	return team.ResolveTeamNameForIssue(issue, override)
}

func buildTeamTasksFromBoardIssue(issue tracker.LocalBoardIssue) []types.TeamTask {
	return team.BuildTeamTasksFromBoardIssue(issue)
}

func logTeamEvents(ctx context.Context, logger *slog.Logger, events <-chan types.TeamEvent) {
	team.LogTeamEvents(ctx, logger, events)
}

var teamCmd = &cobra.Command{
	Use:   "team",
	Short: "Manage coordinated agent teams",
	Long:  "Manage coordinated agent teams executing staged pipelines",
}

var teamRunCmd = &cobra.Command{
	Use:   "run",
	Short: "Run a team with the staged pipeline",
	RunE:  runTeam,
}

var teamStatusCmd = &cobra.Command{
	Use:   "status",
	Short: "Show team status",
	RunE:  showTeamStatus,
}

var teamCancelCmd = &cobra.Command{
	Use:   "cancel",
	Short: "Cancel a running team",
	RunE:  cancelTeam,
}

var teamWorkerCmd = &cobra.Command{
	Use:   "worker",
	Short: "Run as a team worker in a tmux pane",
	RunE:  runTeamWorker,
}

func init() {
	// teamRunCmd flags
	teamRunCmd.Flags().StringP("config", "c", "", "path to WORKFLOW.md file (required)")
	teamRunCmd.Flags().StringP("name", "n", "", "team name (required unless --issue is set)")
	teamRunCmd.Flags().StringP("tasks", "t", "", "path to tasks JSON file (required unless --issue is set)")
	teamRunCmd.Flags().String("issue", "", "internal board issue ID to hydrate into a team run")
	teamRunCmd.Flags().IntP("max-workers", "w", 0, "override max workers from config")
	teamRunCmd.Flags().String("worker-mode", "", "override worker mode from config (goroutine|tmux)")

	_ = teamRunCmd.MarkFlagRequired("config")

	// teamStatusCmd flags
	teamStatusCmd.Flags().StringP("config", "c", "", "path to WORKFLOW.md file (required)")
	teamStatusCmd.Flags().StringP("name", "n", "", "team name (required)")

	_ = teamStatusCmd.MarkFlagRequired("config")
	_ = teamStatusCmd.MarkFlagRequired("name")

	// teamCancelCmd flags
	teamCancelCmd.Flags().StringP("config", "c", "", "path to WORKFLOW.md file (required)")
	teamCancelCmd.Flags().StringP("name", "n", "", "team name (required)")

	_ = teamCancelCmd.MarkFlagRequired("config")
	_ = teamCancelCmd.MarkFlagRequired("name")

	// teamWorkerCmd flags
	teamWorkerCmd.Flags().StringP("config", "c", "", "path to WORKFLOW.md file (required)")
	teamWorkerCmd.Flags().StringP("name", "n", "", "team name (required)")
	teamWorkerCmd.Flags().String("worker-id", "", "worker ID (required)")
	teamWorkerCmd.Flags().String("task-file", "", "path to task prompt file")

	_ = teamWorkerCmd.MarkFlagRequired("config")
	_ = teamWorkerCmd.MarkFlagRequired("name")
	_ = teamWorkerCmd.MarkFlagRequired("worker-id")

	// Add subcommands to teamCmd
	teamCmd.AddCommand(teamRunCmd)
	teamCmd.AddCommand(teamStatusCmd)
	teamCmd.AddCommand(teamCancelCmd)
	teamCmd.AddCommand(teamWorkerCmd)
}

// runTeam executes the team run subcommand.
func runTeam(cmd *cobra.Command, _ []string) error {
	cfgPath, err := cmd.Flags().GetString("config")
	if err != nil {
		return fmt.Errorf("getting config flag: %w", err)
	}

	teamName, err := cmd.Flags().GetString("name")
	if err != nil {
		return fmt.Errorf("getting name flag: %w", err)
	}

	tasksPath, err := cmd.Flags().GetString("tasks")
	if err != nil {
		return fmt.Errorf("getting tasks flag: %w", err)
	}

	issueID, err := cmd.Flags().GetString("issue")
	if err != nil {
		return fmt.Errorf("getting issue flag: %w", err)
	}

	maxWorkers, err := cmd.Flags().GetInt("max-workers")
	if err != nil {
		return fmt.Errorf("getting max-workers flag: %w", err)
	}

	workerMode, err := cmd.Flags().GetString("worker-mode")
	if err != nil {
		return fmt.Errorf("getting worker-mode flag: %w", err)
	}

	return team.RunWithOptions(teamRunOptions{
		ConfigPath: cfgPath,
		TeamName:   teamName,
		TasksPath:  tasksPath,
		IssueID:    issueID,
		MaxWorkers: maxWorkers,
		WorkerMode: workerMode,
	})
}

// showTeamStatus displays the current status of a team.
func showTeamStatus(cmd *cobra.Command, _ []string) error {
	cfgPath, err := cmd.Flags().GetString("config")
	if err != nil {
		return fmt.Errorf("getting config flag: %w", err)
	}

	teamName, err := cmd.Flags().GetString("name")
	if err != nil {
		return fmt.Errorf("getting name flag: %w", err)
	}

	return team.ShowStatus(cfgPath, teamName)
}

// cancelTeam cancels a running team.
func cancelTeam(cmd *cobra.Command, _ []string) error {
	cfgPath, err := cmd.Flags().GetString("config")
	if err != nil {
		return fmt.Errorf("getting config flag: %w", err)
	}

	teamName, err := cmd.Flags().GetString("name")
	if err != nil {
		return fmt.Errorf("getting name flag: %w", err)
	}

	return team.Cancel(cfgPath, teamName)
}

// runTeamWorker runs a single team worker in a tmux pane.
func runTeamWorker(cmd *cobra.Command, _ []string) error {
	cfgPath, err := cmd.Flags().GetString("config")
	if err != nil {
		return fmt.Errorf("getting config flag: %w", err)
	}

	teamName, err := cmd.Flags().GetString("name")
	if err != nil {
		return fmt.Errorf("getting name flag: %w", err)
	}

	workerID, err := cmd.Flags().GetString("worker-id")
	if err != nil {
		return fmt.Errorf("getting worker-id flag: %w", err)
	}

	taskFile, err := cmd.Flags().GetString("task-file")
	if err != nil {
		return fmt.Errorf("getting task-file flag: %w", err)
	}

	return team.RunWorker(team.WorkerOptions{
		ConfigPath: cfgPath,
		TeamName:   teamName,
		WorkerID:   workerID,
		TaskFile:   taskFile,
	})
}
