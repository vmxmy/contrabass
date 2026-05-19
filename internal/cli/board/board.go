package board

import (
	"context"
	"fmt"
	"io"
	"os"
	"strings"
	"text/tabwriter"

	"github.com/junhoyeo/contrabass/internal/config"
	"github.com/junhoyeo/contrabass/internal/tracker"
)

// TrackerOptions resolves the internal-board tracker connection from the
// workflow config plus CLI overrides.
type TrackerOptions struct {
	ConfigPath     string
	DirOverride    string
	PrefixOverride string
}

// LoadTracker builds a LocalTracker from the workflow config and overrides.
func LoadTracker(opts TrackerOptions) (*tracker.LocalTracker, error) {
	cfg := &config.WorkflowConfig{}
	if strings.TrimSpace(opts.ConfigPath) != "" {
		parsed, err := config.ParseWorkflow(opts.ConfigPath)
		if err != nil {
			return nil, fmt.Errorf("parsing workflow config: %w", err)
		}
		cfg = parsed
	}

	boardDir := cfg.LocalBoardDir()
	if opts.DirOverride != "" {
		boardDir = opts.DirOverride
	}

	issuePrefix := cfg.LocalIssuePrefix()
	if opts.PrefixOverride != "" {
		issuePrefix = opts.PrefixOverride
	}

	actor := os.Getenv("TRACKER_ACTOR")
	if actor == "" {
		actor = cfg.GitHubAssignee()
	}

	return tracker.NewLocalTracker(tracker.LocalConfig{
		BoardDir:    boardDir,
		IssuePrefix: issuePrefix,
		Actor:       actor,
	}), nil
}

// InitBoard initializes board storage and reports the location.
func InitBoard(ctx context.Context, out io.Writer, lt *tracker.LocalTracker) error {
	manifest, err := lt.InitBoard(ctx)
	if err != nil {
		return err
	}
	_, _ = fmt.Fprintf(out, "initialized board at %s (prefix %s)\n", lt.BoardDir(), manifest.IssuePrefix)
	return nil
}

// ListIssues prints the board issues, optionally filtered by state.
func ListIssues(ctx context.Context, out io.Writer, lt *tracker.LocalTracker, stateFilter string) error {
	var filter tracker.LocalBoardState
	if stateFilter != "" {
		parsed, err := tracker.ParseLocalBoardState(stateFilter)
		if err != nil {
			return err
		}
		filter = parsed
	}

	issues, err := lt.ListIssues(ctx, true)
	if err != nil {
		return err
	}

	w := tabwriter.NewWriter(out, 0, 0, 2, ' ', 0)
	_, _ = fmt.Fprintln(w, "ID\tSTATE\tASSIGNEE\tPARENT\tTITLE\tLABELS")
	for _, issue := range issues {
		if filter != "" && issue.State != filter {
			continue
		}
		_, _ = fmt.Fprintf(
			w,
			"%s\t%s\t%s\t%s\t%s\t%s\n",
			issue.ID,
			issue.State,
			issue.Assignee,
			issue.ParentID,
			issue.Title,
			strings.Join(issue.Labels, ","),
		)
	}

	return w.Flush()
}

// CreateOptions configures a new internal-board issue.
type CreateOptions struct {
	Title       string
	Description string
	ParentID    string
	Assignee    string
	Labels      []string
	BlockedBy   []string
}

// CreateIssue creates an issue and prints its ID.
func CreateIssue(ctx context.Context, out io.Writer, lt *tracker.LocalTracker, opts CreateOptions) error {
	issue, err := lt.CreateIssueWithOptions(ctx, tracker.LocalIssueCreateOptions{
		Title:       opts.Title,
		Description: opts.Description,
		ParentID:    opts.ParentID,
		Assignee:    opts.Assignee,
		Labels:      opts.Labels,
		BlockedBy:   opts.BlockedBy,
	})
	if err != nil {
		return err
	}
	_, _ = fmt.Fprintf(out, "%s\n", issue.ID)
	return nil
}

// ShowIssue prints an issue and its comments.
func ShowIssue(ctx context.Context, out io.Writer, lt *tracker.LocalTracker, issueID string) error {
	issue, err := lt.GetIssue(ctx, issueID)
	if err != nil {
		return err
	}

	comments, err := lt.ListComments(ctx, issueID)
	if err != nil {
		return err
	}

	_, _ = fmt.Fprintf(out, "ID: %s\n", issue.ID)
	_, _ = fmt.Fprintf(out, "State: %s\n", issue.State)
	_, _ = fmt.Fprintf(out, "Title: %s\n", issue.Title)
	_, _ = fmt.Fprintf(out, "Labels: %s\n", strings.Join(issue.Labels, ","))
	_, _ = fmt.Fprintf(out, "Assignee: %s\n", issue.Assignee)
	_, _ = fmt.Fprintf(out, "Parent: %s\n", issue.ParentID)
	_, _ = fmt.Fprintf(out, "Children: %s\n", strings.Join(issue.ChildIDs, ","))
	_, _ = fmt.Fprintf(out, "BlockedBy: %s\n", strings.Join(issue.BlockedBy, ","))
	_, _ = fmt.Fprintf(out, "ClaimedBy: %s\n", issue.ClaimedBy)
	if teamName, ok := issue.TrackerMeta["team_name"].(string); ok && teamName != "" {
		_, _ = fmt.Fprintf(out, "Team: %s\n", teamName)
	}
	if teamStatus, ok := issue.TrackerMeta["team_status"].(string); ok && teamStatus != "" {
		_, _ = fmt.Fprintf(out, "TeamStatus: %s\n", teamStatus)
	}
	if teamPhase, ok := issue.TrackerMeta["team_phase"].(string); ok && teamPhase != "" {
		_, _ = fmt.Fprintf(out, "TeamPhase: %s\n", teamPhase)
	}
	_, _ = fmt.Fprintf(out, "CreatedAt: %s\n", issue.CreatedAt.Format("2006-01-02T15:04:05Z07:00"))
	_, _ = fmt.Fprintf(out, "UpdatedAt: %s\n", issue.UpdatedAt.Format("2006-01-02T15:04:05Z07:00"))
	_, _ = fmt.Fprintln(out, "")
	_, _ = fmt.Fprintln(out, "Description:")
	_, _ = fmt.Fprintln(out, issue.Description)
	_, _ = fmt.Fprintln(out, "")
	_, _ = fmt.Fprintln(out, "Comments:")
	if len(comments) == 0 {
		_, _ = fmt.Fprintln(out, "(none)")
		return nil
	}

	for _, comment := range comments {
		_, _ = fmt.Fprintf(
			out,
			"- [%s] %s: %s\n",
			comment.CreatedAt.Format("2006-01-02T15:04:05Z07:00"),
			comment.Author,
			comment.Body,
		)
	}

	return nil
}

// MoveIssue transitions an issue to a new state.
func MoveIssue(ctx context.Context, out io.Writer, lt *tracker.LocalTracker, issueID, stateRaw string) error {
	state, err := tracker.ParseLocalBoardState(stateRaw)
	if err != nil {
		return err
	}

	issue, err := lt.MoveIssue(ctx, issueID, state)
	if err != nil {
		return err
	}

	_, _ = fmt.Fprintf(out, "%s -> %s\n", issue.ID, issue.State)
	return nil
}

// CommentIssue adds a comment to an issue.
func CommentIssue(ctx context.Context, out io.Writer, lt *tracker.LocalTracker, issueID, body string) error {
	if err := lt.AddComment(ctx, issueID, body); err != nil {
		return err
	}
	_, _ = fmt.Fprintf(out, "commented on %s\n", issueID)
	return nil
}

// AssignIssue assigns an issue to a worker or team.
func AssignIssue(ctx context.Context, out io.Writer, lt *tracker.LocalTracker, issueID, assignee string) error {
	issue, err := lt.AssignIssue(ctx, issueID, assignee)
	if err != nil {
		return err
	}
	_, _ = fmt.Fprintf(out, "%s -> %s\n", issue.ID, issue.Assignee)
	return nil
}
