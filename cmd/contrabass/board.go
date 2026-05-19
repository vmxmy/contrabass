package main

import (
	"context"
	"fmt"

	"github.com/spf13/cobra"

	"github.com/junhoyeo/contrabass/internal/cli/board"
	"github.com/junhoyeo/contrabass/internal/tracker"
)

var boardCmd = &cobra.Command{
	Use:   "board",
	Short: "Manage the internal .contrabass issue board",
	Long:  "Manage the internal .contrabass issue board for tracker.type=internal workflows",
}

var boardInitCmd = &cobra.Command{
	Use:   "init",
	Short: "Initialize the internal board storage",
	RunE:  runBoardInit,
}

var boardListCmd = &cobra.Command{
	Use:   "list",
	Short: "List internal board issues",
	RunE:  runBoardList,
}

var boardCreateCmd = &cobra.Command{
	Use:   "create",
	Short: "Create an internal board issue",
	RunE:  runBoardCreate,
}

var boardShowCmd = &cobra.Command{
	Use:   "show <issue-id>",
	Short: "Show an internal board issue",
	Args:  cobra.ExactArgs(1),
	RunE:  runBoardShow,
}

var boardMoveCmd = &cobra.Command{
	Use:   "move <issue-id> <state>",
	Short: "Move an internal board issue to a new state",
	Args:  cobra.ExactArgs(2),
	RunE:  runBoardMove,
}

var boardCommentCmd = &cobra.Command{
	Use:   "comment <issue-id>",
	Short: "Add a comment to an internal board issue",
	Args:  cobra.ExactArgs(1),
	RunE:  runBoardComment,
}

var boardAssignCmd = &cobra.Command{
	Use:   "assign <issue-id> <assignee>",
	Short: "Assign an internal board issue",
	Args:  cobra.ExactArgs(2),
	RunE:  runBoardAssign,
}

func init() {
	for _, command := range []*cobra.Command{
		boardInitCmd,
		boardListCmd,
		boardCreateCmd,
		boardShowCmd,
		boardMoveCmd,
		boardCommentCmd,
		boardAssignCmd,
	} {
		command.Flags().String("config", "", "path to WORKFLOW.md file")
		command.Flags().String("dir", "", "override internal board directory")
	}

	boardInitCmd.Flags().String("prefix", "", "override local issue prefix")

	boardListCmd.Flags().String("state", "", "filter issues by state (todo, in_progress, retry, done)")

	boardCreateCmd.Flags().String("title", "", "issue title")
	boardCreateCmd.Flags().String("description", "", "issue description")
	boardCreateCmd.Flags().String("parent", "", "parent issue ID")
	boardCreateCmd.Flags().String("assignee", "", "assign the issue to a worker or team")
	boardCreateCmd.Flags().StringSlice("labels", nil, "issue labels")
	boardCreateCmd.Flags().StringSlice("blocked-by", nil, "board issue IDs that block this issue")
	_ = boardCreateCmd.MarkFlagRequired("title")

	boardCommentCmd.Flags().String("body", "", "comment body")
	_ = boardCommentCmd.MarkFlagRequired("body")

	boardCmd.AddCommand(
		boardInitCmd,
		boardListCmd,
		boardCreateCmd,
		boardShowCmd,
		boardMoveCmd,
		boardCommentCmd,
		boardAssignCmd,
	)
}

func runBoardInit(cmd *cobra.Command, _ []string) error {
	localTracker, err := loadLocalBoardTracker(cmd, true)
	if err != nil {
		return err
	}
	return board.InitBoard(context.Background(), cmd.OutOrStdout(), localTracker)
}

func runBoardList(cmd *cobra.Command, _ []string) error {
	localTracker, err := loadLocalBoardTracker(cmd, false)
	if err != nil {
		return err
	}

	filterRaw, err := cmd.Flags().GetString("state")
	if err != nil {
		return fmt.Errorf("getting state flag: %w", err)
	}

	return board.ListIssues(context.Background(), cmd.OutOrStdout(), localTracker, filterRaw)
}

func runBoardCreate(cmd *cobra.Command, _ []string) error {
	localTracker, err := loadLocalBoardTracker(cmd, true)
	if err != nil {
		return err
	}

	title, err := cmd.Flags().GetString("title")
	if err != nil {
		return fmt.Errorf("getting title flag: %w", err)
	}

	description, err := cmd.Flags().GetString("description")
	if err != nil {
		return fmt.Errorf("getting description flag: %w", err)
	}

	parentID, err := cmd.Flags().GetString("parent")
	if err != nil {
		return fmt.Errorf("getting parent flag: %w", err)
	}

	assignee, err := cmd.Flags().GetString("assignee")
	if err != nil {
		return fmt.Errorf("getting assignee flag: %w", err)
	}

	labels, err := cmd.Flags().GetStringSlice("labels")
	if err != nil {
		return fmt.Errorf("getting labels flag: %w", err)
	}

	blockedBy, err := cmd.Flags().GetStringSlice("blocked-by")
	if err != nil {
		return fmt.Errorf("getting blocked-by flag: %w", err)
	}

	return board.CreateIssue(context.Background(), cmd.OutOrStdout(), localTracker, board.CreateOptions{
		Title:       title,
		Description: description,
		ParentID:    parentID,
		Assignee:    assignee,
		Labels:      labels,
		BlockedBy:   blockedBy,
	})
}

func runBoardShow(cmd *cobra.Command, args []string) error {
	localTracker, err := loadLocalBoardTracker(cmd, false)
	if err != nil {
		return err
	}
	return board.ShowIssue(context.Background(), cmd.OutOrStdout(), localTracker, args[0])
}

func runBoardMove(cmd *cobra.Command, args []string) error {
	localTracker, err := loadLocalBoardTracker(cmd, false)
	if err != nil {
		return err
	}
	return board.MoveIssue(context.Background(), cmd.OutOrStdout(), localTracker, args[0], args[1])
}

func runBoardComment(cmd *cobra.Command, args []string) error {
	localTracker, err := loadLocalBoardTracker(cmd, false)
	if err != nil {
		return err
	}

	body, err := cmd.Flags().GetString("body")
	if err != nil {
		return fmt.Errorf("getting body flag: %w", err)
	}

	return board.CommentIssue(context.Background(), cmd.OutOrStdout(), localTracker, args[0], body)
}

func runBoardAssign(cmd *cobra.Command, args []string) error {
	localTracker, err := loadLocalBoardTracker(cmd, false)
	if err != nil {
		return err
	}
	return board.AssignIssue(context.Background(), cmd.OutOrStdout(), localTracker, args[0], args[1])
}

// loadLocalBoardTracker resolves the internal-board tracker from CLI flags. It
// stays a package-main identifier because the (untouched) localonly board
// dispatch command consumes it directly.
func loadLocalBoardTracker(cmd *cobra.Command, allowPrefixOverride bool) (*tracker.LocalTracker, error) {
	cfgPath, err := cmd.Flags().GetString("config")
	if err != nil {
		return nil, fmt.Errorf("getting config flag: %w", err)
	}

	dirOverride, err := cmd.Flags().GetString("dir")
	if err != nil {
		return nil, fmt.Errorf("getting dir flag: %w", err)
	}

	prefixOverride := ""
	if allowPrefixOverride && cmd.Flags().Lookup("prefix") != nil {
		prefixOverride, err = cmd.Flags().GetString("prefix")
		if err != nil {
			return nil, fmt.Errorf("getting prefix flag: %w", err)
		}
	}

	return board.LoadTracker(board.TrackerOptions{
		ConfigPath:     cfgPath,
		DirOverride:    dirOverride,
		PrefixOverride: prefixOverride,
	})
}
