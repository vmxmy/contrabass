//go:build localonly

package main

import (
	"context"
	"fmt"
	"io"
	"strings"

	"github.com/spf13/cobra"

	"github.com/junhoyeo/contrabass/internal/cli/server"
	"github.com/junhoyeo/contrabass/internal/tracker"
)

// Thin cobra wiring for `contrabass board dispatch`. The dispatch logic lives
// in internal/cli/server; this file only parses flags and delegates. The
// dispatch seam types are re-exported so the (untouched) localonly board tests
// keep compiling against package-main identifiers.

type boardDispatchOptions = server.DispatchOptions

var runBoardDispatchTeam = func(opts teamRunOptions) error { return runTeamWithOptions(opts) }

var boardDispatchCmd = &cobra.Command{
	Use:   "dispatch",
	Short: "Dispatch the next runnable internal board issue into a team run",
	RunE:  runBoardDispatch,
}

func init() {
	boardDispatchCmd.Flags().String("config", "", "path to WORKFLOW.md file")
	boardDispatchCmd.Flags().String("dir", "", "override internal board directory")
	boardDispatchCmd.Flags().String("team-name", "", "override the team name used for dispatch")
	boardDispatchCmd.Flags().IntP("max-workers", "w", 0, "override max workers from config")
	boardDispatchCmd.Flags().Bool("until-empty", false, "keep dispatching runnable issues until the internal board is drained")

	boardCmd.AddCommand(boardDispatchCmd)
}

func runBoardDispatch(cmd *cobra.Command, _ []string) error {
	cfgPath, err := cmd.Flags().GetString("config")
	if err != nil {
		return fmt.Errorf("getting config flag: %w", err)
	}
	if strings.TrimSpace(cfgPath) == "" {
		return fmt.Errorf("board dispatch requires --config")
	}

	localTracker, err := loadLocalBoardTracker(cmd, false)
	if err != nil {
		return err
	}

	teamName, err := cmd.Flags().GetString("team-name")
	if err != nil {
		return fmt.Errorf("getting team-name flag: %w", err)
	}

	maxWorkers, err := cmd.Flags().GetInt("max-workers")
	if err != nil {
		return fmt.Errorf("getting max-workers flag: %w", err)
	}

	untilEmpty, err := cmd.Flags().GetBool("until-empty")
	if err != nil {
		return fmt.Errorf("getting until-empty flag: %w", err)
	}

	restore := server.SetBoardDispatchTeamRunner(runBoardDispatchTeam)
	defer restore()

	return dispatchBoardIssues(
		context.Background(),
		cmd.OutOrStdout(),
		localTracker,
		boardDispatchOptions{
			ConfigPath: cfgPath,
			TeamName:   strings.TrimSpace(teamName),
			MaxWorkers: maxWorkers,
			UntilEmpty: untilEmpty,
		},
		runBoardDispatchTeam,
	)
}

// dispatchBoardIssues delegates to the server package, preserving the
// package-main symbol the (untouched) localonly board tests call directly.
func dispatchBoardIssues(
	ctx context.Context,
	out io.Writer,
	localTracker *tracker.LocalTracker,
	opts boardDispatchOptions,
	runTeam func(teamRunOptions) error,
) error {
	restore := server.SetBoardDispatchTeamRunner(runTeam)
	defer restore()
	return server.DispatchBoardIssues(ctx, out, localTracker, opts)
}
