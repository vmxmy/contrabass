//go:build localonly

package server

import (
	"context"
	"fmt"
	"io"

	clteam "github.com/junhoyeo/contrabass/internal/cli/team"
	"github.com/junhoyeo/contrabass/internal/tracker"
)

// boardDispatchOptions configures a single internal-board dispatch pass.
type boardDispatchOptions struct {
	ConfigPath string
	TeamName   string
	MaxWorkers int
	UntilEmpty bool
}

var runBoardDispatchTeam = clteam.RunWithOptions

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
