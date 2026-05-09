//go:build localonly

package main

import (
	"context"
	"fmt"
	"io"
	"strings"

	"github.com/spf13/cobra"

	"github.com/junhoyeo/contrabass/internal/tracker"
)

var boardDispatchCmd = &cobra.Command{
	Use:   "dispatch",
	Short: "Dispatch the next runnable internal board issue into a team run",
	RunE:  runBoardDispatch,
}

type boardDispatchOptions struct {
	ConfigPath string
	TeamName   string
	MaxWorkers int
	UntilEmpty bool
}

var runBoardDispatchTeam = runTeamWithOptions

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

func dispatchBoardIssues(
	ctx context.Context,
	out io.Writer,
	localTracker *tracker.LocalTracker,
	opts boardDispatchOptions,
	runTeam func(teamRunOptions) error,
) error {
	dispatched := 0
	for {
		issueID, resolvedTeamName, found, err := dispatchNextBoardIssue(ctx, localTracker, opts, runTeam)
		if err != nil {
			return err
		}
		if !found {
			if !opts.UntilEmpty {
				return fmt.Errorf("no dispatchable internal board issue found")
			}
			if dispatched == 0 {
				_, _ = fmt.Fprintln(out, "board already drained")
				return nil
			}
			_, _ = fmt.Fprintf(out, "drained board after %d dispatches\n", dispatched)
			return nil
		}

		dispatched++
		_, _ = fmt.Fprintf(out, "dispatched %s to %s\n", issueID, resolvedTeamName)
		if !opts.UntilEmpty {
			return nil
		}
	}
}

func dispatchNextBoardIssue(
	ctx context.Context,
	localTracker *tracker.LocalTracker,
	opts boardDispatchOptions,
	runTeam func(teamRunOptions) error,
) (string, string, bool, error) {
	issue, found, err := localTracker.FindDispatchableIssue(ctx, opts.TeamName)
	if err != nil {
		return "", "", false, err
	}
	if !found {
		return "", "", false, nil
	}

	resolvedTeamName := resolveTeamNameForIssue(issue, opts.TeamName)
	if _, err := localTracker.AssignIssue(ctx, issue.ID, resolvedTeamName); err != nil {
		return "", "", false, err
	}
	if err := localTracker.PostComment(
		ctx,
		issue.ID,
		fmt.Sprintf("dispatch requested for team %s", resolvedTeamName),
	); err != nil {
		return "", "", false, err
	}

	if err := runTeam(teamRunOptions{
		ConfigPath: opts.ConfigPath,
		TeamName:   resolvedTeamName,
		IssueID:    issue.ID,
		MaxWorkers: opts.MaxWorkers,
	}); err != nil {
		return "", "", false, fmt.Errorf("dispatching %s to %s: %w", issue.ID, resolvedTeamName, err)
	}

	return issue.ID, resolvedTeamName, true, nil
}
