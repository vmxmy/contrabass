package main

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/junhoyeo/contrabass/internal/config"
	"github.com/junhoyeo/contrabass/internal/tracker"
)

var migrateCmd = &cobra.Command{
	Use:   "migrate",
	Short: "Migrate local Contrabass data",
}

var migrateCloudCmd = &cobra.Command{
	Use:   "cloud",
	Short: "Prepare local team state for cloud migration",
	RunE:  runMigrateCloud,
}

type migrateCloudOptions struct {
	TeamName string
	RootDir  string
}

type migrateWorkflowSource struct {
	Path        string
	Bytes       int
	ContentHash string
}

type migrateJSONFile struct {
	Name string
	Path string
	Raw  json.RawMessage
}

type migrateBoardSource struct {
	Dir          string
	ManifestPath string
	Manifest     *tracker.LocalBoardManifest
	Issues       []tracker.LocalBoardIssue
	Comments     map[string][]tracker.LocalBoardComment
	Entries      []migrateCloudBoardEntry
}

type migrateCloudBoardEntry struct {
	IssueRef         string `json:"issueRef"`
	RunID            string `json:"runId,omitempty"`
	AssignedWorkerID string `json:"assignedWorkerId,omitempty"`
	Phase            string `json:"phase"`
	LastUpdated      int64  `json:"lastUpdated"`
}

type migrateCloudSource struct {
	TeamName  string
	Workflow  migrateWorkflowSource
	TeamState []migrateJSONFile
	Board     migrateBoardSource
}

func init() {
	migrateCloudCmd.Flags().String("team", "", "team name to migrate from .contrabass/state/team/<name>")
	migrateCloudCmd.Flags().String("root", ".", "project root containing WORKFLOW.md and .contrabass")
	_ = migrateCloudCmd.MarkFlagRequired("team")

	migrateCmd.AddCommand(migrateCloudCmd)
}

func runMigrateCloud(cmd *cobra.Command, _ []string) error {
	teamName, err := cmd.Flags().GetString("team")
	if err != nil {
		return fmt.Errorf("getting team flag: %w", err)
	}
	rootDir, err := cmd.Flags().GetString("root")
	if err != nil {
		return fmt.Errorf("getting root flag: %w", err)
	}

	source, err := loadMigrateCloudSource(cmd.Context(), migrateCloudOptions{
		TeamName: teamName,
		RootDir:  rootDir,
	})
	if err != nil {
		return err
	}

	printMigrateCloudSummary(cmd.OutOrStdout(), source)
	return nil
}

func loadMigrateCloudSource(ctx context.Context, opts migrateCloudOptions) (*migrateCloudSource, error) {
	teamName := strings.TrimSpace(opts.TeamName)
	if teamName == "" {
		return nil, errors.New("--team is required")
	}

	rootDir := strings.TrimSpace(opts.RootDir)
	if rootDir == "" {
		rootDir = "."
	}
	rootDir = filepath.Clean(rootDir)

	workflowPath := filepath.Join(rootDir, "WORKFLOW.md")
	workflow, cfg, err := readMigrationWorkflow(ctx, workflowPath)
	if err != nil {
		return nil, err
	}

	teamStateDir := filepath.Join(rootDir, cfg.TeamStateDir(), teamName)
	teamState, err := readMigrationJSONFiles(ctx, teamStateDir)
	if err != nil {
		return nil, fmt.Errorf("reading team state from %s: %w", teamStateDir, err)
	}

	boardDir := filepath.Join(rootDir, cfg.LocalBoardDir())
	board, err := readMigrationBoard(ctx, boardDir)
	if err != nil {
		return nil, fmt.Errorf("reading local board from %s: %w", boardDir, err)
	}

	return &migrateCloudSource{
		TeamName:  teamName,
		Workflow:  workflow,
		TeamState: teamState,
		Board:     board,
	}, nil
}

func readMigrationWorkflow(ctx context.Context, path string) (migrateWorkflowSource, *config.WorkflowConfig, error) {
	if err := checkMigrationContext(ctx); err != nil {
		return migrateWorkflowSource{}, nil, err
	}
	content, err := os.ReadFile(path)
	if err != nil {
		return migrateWorkflowSource{}, nil, fmt.Errorf("reading workflow %s: %w", path, err)
	}
	if err := checkMigrationContext(ctx); err != nil {
		return migrateWorkflowSource{}, nil, err
	}

	cfg, err := config.ParseWorkflow(path)
	if err != nil {
		return migrateWorkflowSource{}, nil, fmt.Errorf("parsing workflow %s: %w", path, err)
	}

	sum := sha256.Sum256(content)
	return migrateWorkflowSource{
		Path:        path,
		Bytes:       len(content),
		ContentHash: hex.EncodeToString(sum[:]),
	}, cfg, nil
}

func readMigrationJSONFiles(ctx context.Context, dir string) ([]migrateJSONFile, error) {
	if err := checkMigrationContext(ctx); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}

	files := make([]migrateJSONFile, 0, len(entries))
	for _, entry := range entries {
		if err := checkMigrationContext(ctx); err != nil {
			return nil, err
		}
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}

		path := filepath.Join(dir, entry.Name())
		raw, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("reading %s: %w", path, err)
		}
		var decoded any
		if err := json.Unmarshal(raw, &decoded); err != nil {
			return nil, fmt.Errorf("parsing %s: %w", path, err)
		}
		files = append(files, migrateJSONFile{
			Name: entry.Name(),
			Path: path,
			Raw:  json.RawMessage(raw),
		})
	}

	sort.Slice(files, func(i, j int) bool { return files[i].Name < files[j].Name })
	return files, nil
}

func readMigrationBoard(ctx context.Context, dir string) (migrateBoardSource, error) {
	manifestPath := filepath.Join(dir, "manifest.json")
	var manifest tracker.LocalBoardManifest
	if err := readMigrationJSONFile(ctx, manifestPath, &manifest); err != nil {
		return migrateBoardSource{}, err
	}

	issues, err := readMigrationBoardIssues(ctx, filepath.Join(dir, "issues"))
	if err != nil {
		return migrateBoardSource{}, err
	}
	comments, err := readMigrationBoardComments(ctx, filepath.Join(dir, "comments"))
	if err != nil {
		return migrateBoardSource{}, err
	}

	return migrateBoardSource{
		Dir:          dir,
		ManifestPath: manifestPath,
		Manifest:     &manifest,
		Issues:       issues,
		Comments:     comments,
		Entries:      migrationBoardEntries(issues),
	}, nil
}

func readMigrationBoardIssues(ctx context.Context, dir string) ([]tracker.LocalBoardIssue, error) {
	if err := checkMigrationContext(ctx); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}

	issues := make([]tracker.LocalBoardIssue, 0, len(entries))
	for _, entry := range entries {
		if err := checkMigrationContext(ctx); err != nil {
			return nil, err
		}
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		var issue tracker.LocalBoardIssue
		if err := readMigrationJSONFile(ctx, filepath.Join(dir, entry.Name()), &issue); err != nil {
			return nil, err
		}
		issues = append(issues, issue)
	}

	sort.Slice(issues, func(i, j int) bool {
		if issues[i].CreatedAt.Equal(issues[j].CreatedAt) {
			return issues[i].ID < issues[j].ID
		}
		return issues[i].CreatedAt.Before(issues[j].CreatedAt)
	})
	return issues, nil
}

func readMigrationBoardComments(ctx context.Context, dir string) (map[string][]tracker.LocalBoardComment, error) {
	if err := checkMigrationContext(ctx); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return map[string][]tracker.LocalBoardComment{}, nil
		}
		return nil, err
	}

	comments := make(map[string][]tracker.LocalBoardComment)
	for _, entry := range entries {
		if err := checkMigrationContext(ctx); err != nil {
			return nil, err
		}
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".jsonl" {
			continue
		}
		issueID := strings.TrimSuffix(entry.Name(), filepath.Ext(entry.Name()))
		parsed, err := readMigrationCommentFile(ctx, filepath.Join(dir, entry.Name()))
		if err != nil {
			return nil, err
		}
		comments[issueID] = parsed
	}
	return comments, nil
}

func readMigrationCommentFile(ctx context.Context, path string) ([]tracker.LocalBoardComment, error) {
	if err := checkMigrationContext(ctx); err != nil {
		return nil, err
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("opening %s: %w", path, err)
	}
	defer file.Close()

	var comments []tracker.LocalBoardComment
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		if err := checkMigrationContext(ctx); err != nil {
			return nil, err
		}
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var comment tracker.LocalBoardComment
		if err := json.Unmarshal([]byte(line), &comment); err != nil {
			return nil, fmt.Errorf("parsing %s: %w", path, err)
		}
		comments = append(comments, comment)
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("reading %s: %w", path, err)
	}
	return comments, nil
}

func readMigrationJSONFile(ctx context.Context, path string, target any) error {
	if err := checkMigrationContext(ctx); err != nil {
		return err
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if err := checkMigrationContext(ctx); err != nil {
		return err
	}
	if err := json.Unmarshal(raw, target); err != nil {
		return fmt.Errorf("parsing %s: %w", path, err)
	}
	return nil
}

func migrationBoardEntries(issues []tracker.LocalBoardIssue) []migrateCloudBoardEntry {
	entries := make([]migrateCloudBoardEntry, 0, len(issues))
	for _, issue := range issues {
		entry := migrateCloudBoardEntry{
			IssueRef:    issue.ID,
			Phase:       migrationBoardPhase(issue.State),
			LastUpdated: issue.UpdatedAt.UTC().UnixMilli(),
		}
		if entry.LastUpdated <= 0 {
			entry.LastUpdated = issue.CreatedAt.UTC().UnixMilli()
		}
		if entry.LastUpdated <= 0 {
			entry.LastUpdated = time.Now().UTC().UnixMilli()
		}
		entry.RunID = stringMeta(issue.TrackerMeta, "team_name")
		entry.AssignedWorkerID = strings.TrimPrefix(strings.TrimSpace(issue.ClaimedBy), "team:")
		if entry.AssignedWorkerID == "" {
			entry.AssignedWorkerID = stringMeta(issue.TrackerMeta, "last_worker_id")
		}
		entries = append(entries, entry)
	}
	return entries
}

func migrationBoardPhase(state tracker.LocalBoardState) string {
	switch state {
	case tracker.LocalBoardStateInProgress:
		return "running"
	case tracker.LocalBoardStateDone:
		return "done"
	default:
		return "open"
	}
}

func stringMeta(values map[string]interface{}, key string) string {
	if values == nil {
		return ""
	}
	value, ok := values[key]
	if !ok {
		return ""
	}
	stringValue, ok := value.(string)
	if !ok {
		return ""
	}
	return strings.TrimSpace(stringValue)
}

func printMigrateCloudSummary(w io.Writer, source *migrateCloudSource) {
	if source == nil {
		return
	}

	commentCount := 0
	for _, comments := range source.Board.Comments {
		commentCount += len(comments)
	}

	_, _ = fmt.Fprintf(w, "loaded cloud migration source for team %s\n", source.TeamName)
	_, _ = fmt.Fprintf(w, "workflow: %s (%d bytes, sha256 %s)\n", source.Workflow.Path, source.Workflow.Bytes, source.Workflow.ContentHash)
	_, _ = fmt.Fprintf(w, "team state: %d json files\n", len(source.TeamState))
	_, _ = fmt.Fprintf(w, "board: %d issues, %d comments, %d refresh entries\n", len(source.Board.Issues), commentCount, len(source.Board.Entries))
	_, _ = fmt.Fprintln(w, "uploads are deferred to the idempotent upload task")
}

func checkMigrationContext(ctx context.Context) error {
	if ctx == nil {
		return nil
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
		return nil
	}
}
