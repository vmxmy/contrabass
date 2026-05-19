package migrate

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/junhoyeo/contrabass/internal/config"
	"github.com/junhoyeo/contrabass/internal/tracker"
)

// cloudOptions configures a cloud migration load or upload.
type cloudOptions struct {
	TeamName   string
	RootDir    string
	APIBaseURL string
	AuthToken  string
	DryRun     bool
	HTTPClient *http.Client
}

type workflowSource struct {
	Path        string
	Bytes       int
	ContentHash string
	Content     string
}

type jsonFile struct {
	Name string
	Path string
	Raw  json.RawMessage
}

type boardSource struct {
	Dir          string
	ManifestPath string
	Manifest     *tracker.LocalBoardManifest
	Issues       []tracker.LocalBoardIssue
	Comments     map[string][]tracker.LocalBoardComment
	Entries      []cloudBoardEntry
}

type cloudBoardEntry struct {
	IssueRef         string `json:"issueRef"`
	ExternalID       string `json:"external_id"`
	RunID            string `json:"runId,omitempty"`
	AssignedWorkerID string `json:"assignedWorkerId,omitempty"`
	Phase            string `json:"phase"`
	LastUpdated      int64  `json:"lastUpdated"`
}

type cloudUploadResult struct {
	Config cloudUploadItemResult
	Board  cloudBoardUploadResult
}

type cloudUploadItemResult struct {
	Skipped bool
	Reason  string
}

type cloudBoardUploadResult struct {
	Uploaded []cloudBoardEntry
	Skipped  []cloudBoardEntry
}

type cloudSource struct {
	TeamName  string
	Workflow  workflowSource
	TeamState []jsonFile
	Board     boardSource
}

// RunCloud executes the "migrate cloud" command body.
func RunCloud(
	ctx context.Context,
	in io.Reader,
	out io.Writer,
	teamName string,
	rootDir string,
	apiBaseURL string,
	authToken string,
	dryRun bool,
) error {
	source, err := loadMigrateCloudSource(ctx, cloudOptions{
		TeamName: teamName,
		RootDir:  rootDir,
	})
	if err != nil {
		return err
	}

	printMigrateCloudSummary(out, source)
	if dryRun {
		printMigrateCloudDryRunPlan(out, source)
		return nil
	}
	if strings.TrimSpace(apiBaseURL) == "" {
		_, _ = fmt.Fprintln(out, "uploads require --api-base-url")
		return nil
	}
	if err := confirmMigrateCloudUpload(in, out, source); err != nil {
		return err
	}

	result, err := uploadMigrateCloudSource(ctx, source, cloudOptions{
		APIBaseURL: apiBaseURL,
		AuthToken:  authToken,
	})
	if err != nil {
		return err
	}
	printMigrateCloudUploadResult(out, result)
	return nil
}

func loadMigrateCloudSource(ctx context.Context, opts cloudOptions) (*cloudSource, error) {
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

	board.Entries = migrationBoardEntries(teamName, board.Issues)

	return &cloudSource{
		TeamName:  teamName,
		Workflow:  workflow,
		TeamState: teamState,
		Board:     board,
	}, nil
}

func readMigrationWorkflow(ctx context.Context, path string) (workflowSource, *config.WorkflowConfig, error) {
	if err := checkMigrationContext(ctx); err != nil {
		return workflowSource{}, nil, err
	}
	content, err := os.ReadFile(path)
	if err != nil {
		return workflowSource{}, nil, fmt.Errorf("reading workflow %s: %w", path, err)
	}
	if err := checkMigrationContext(ctx); err != nil {
		return workflowSource{}, nil, err
	}

	cfg, err := config.ParseWorkflow(path)
	if err != nil {
		return workflowSource{}, nil, fmt.Errorf("parsing workflow %s: %w", path, err)
	}

	sum := sha256.Sum256(content)
	return workflowSource{
		Path:        path,
		Bytes:       len(content),
		ContentHash: hex.EncodeToString(sum[:]),
		Content:     string(content),
	}, cfg, nil
}

func readMigrationJSONFiles(ctx context.Context, dir string) ([]jsonFile, error) {
	if err := checkMigrationContext(ctx); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}

	files := make([]jsonFile, 0, len(entries))
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
		files = append(files, jsonFile{
			Name: entry.Name(),
			Path: path,
			Raw:  json.RawMessage(raw),
		})
	}

	sort.Slice(files, func(i, j int) bool { return files[i].Name < files[j].Name })
	return files, nil
}

func readMigrationBoard(ctx context.Context, dir string) (boardSource, error) {
	manifestPath := filepath.Join(dir, "manifest.json")
	var manifest tracker.LocalBoardManifest
	if err := readMigrationJSONFile(ctx, manifestPath, &manifest); err != nil {
		return boardSource{}, err
	}

	issues, err := readMigrationBoardIssues(ctx, filepath.Join(dir, "issues"))
	if err != nil {
		return boardSource{}, err
	}
	comments, err := readMigrationBoardComments(ctx, filepath.Join(dir, "comments"))
	if err != nil {
		return boardSource{}, err
	}

	return boardSource{
		Dir:          dir,
		ManifestPath: manifestPath,
		Manifest:     &manifest,
		Issues:       issues,
		Comments:     comments,
		Entries:      migrationBoardEntries("", issues),
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

func migrationBoardEntries(teamName string, issues []tracker.LocalBoardIssue) []cloudBoardEntry {
	entries := make([]cloudBoardEntry, 0, len(issues))
	for _, issue := range issues {
		entry := cloudBoardEntry{
			IssueRef:    issue.ID,
			ExternalID:  migrationBoardExternalID(teamName, issue.ID),
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

func migrationBoardExternalID(teamName, issueID string) string {
	issueID = strings.TrimSpace(issueID)
	teamName = strings.TrimSpace(teamName)
	if teamName == "" {
		return issueID
	}
	return "internal:" + teamName + ":" + issueID
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

func printMigrateCloudSummary(w io.Writer, source *cloudSource) {
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
}

func printMigrateCloudDryRunPlan(w io.Writer, source *cloudSource) {
	if source == nil {
		return
	}

	_, _ = fmt.Fprintln(w, "dry-run migration plan:")
	_, _ = fmt.Fprintf(w, "- upload workflow config hash %s from %s\n", source.Workflow.ContentHash, source.Workflow.Path)
	_, _ = fmt.Fprintf(w, "- read %d team state json files from .contrabass/state/team/%s\n", len(source.TeamState), source.TeamName)
	_, _ = fmt.Fprintf(w, "- refresh %d board entries from %s\n", len(source.Board.Entries), source.Board.Dir)
	_, _ = fmt.Fprintln(w, "no uploads performed")
}

func confirmMigrateCloudUpload(r io.Reader, w io.Writer, source *cloudSource) error {
	if source == nil {
		return errors.New("migration source is required")
	}

	confirmation := "migrate " + source.TeamName
	_, _ = fmt.Fprintf(w, "This will upload local migration data for team %s. Type %q to continue: ", source.TeamName, confirmation)

	scanner := bufio.NewScanner(r)
	if !scanner.Scan() {
		if err := scanner.Err(); err != nil {
			return fmt.Errorf("reading migration confirmation: %w", err)
		}
		return errors.New("migration upload cancelled: confirmation required")
	}
	if strings.TrimSpace(scanner.Text()) != confirmation {
		return errors.New("migration upload cancelled")
	}
	return nil
}

func uploadMigrateCloudSource(ctx context.Context, source *cloudSource, opts cloudOptions) (cloudUploadResult, error) {
	if source == nil {
		return cloudUploadResult{}, errors.New("migration source is required")
	}
	client := opts.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	baseURL, err := normalizeMigrateCloudAPIBaseURL(opts.APIBaseURL)
	if err != nil {
		return cloudUploadResult{}, err
	}

	result := cloudUploadResult{}
	configExists, err := migrateCloudConfigExists(ctx, client, baseURL, opts.AuthToken, source.TeamName, source.Workflow.ContentHash)
	if err != nil {
		return result, err
	}
	if configExists {
		result.Config = cloudUploadItemResult{Skipped: true, Reason: "content hash already present"}
	} else if err := migrateCloudUploadConfig(ctx, client, baseURL, opts.AuthToken, source); err != nil {
		return result, err
	}

	existingExternalIDs, err := migrateCloudExistingBoardExternalIDs(ctx, client, baseURL, opts.AuthToken, source.TeamName)
	if err != nil {
		return result, err
	}
	for _, entry := range source.Board.Entries {
		if _, ok := existingExternalIDs[entry.ExternalID]; ok {
			result.Board.Skipped = append(result.Board.Skipped, entry)
			continue
		}
		result.Board.Uploaded = append(result.Board.Uploaded, entry)
	}
	if len(result.Board.Uploaded) > 0 {
		if err := migrateCloudUploadBoardEntries(ctx, client, baseURL, opts.AuthToken, source.TeamName, result.Board.Uploaded); err != nil {
			return result, err
		}
	}
	return result, nil
}

func normalizeMigrateCloudAPIBaseURL(raw string) (*url.URL, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, errors.New("--api-base-url is required for uploads")
	}
	baseURL, err := url.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("parsing api base url: %w", err)
	}
	if baseURL.Scheme == "" || baseURL.Host == "" {
		return nil, fmt.Errorf("api base url must be absolute: %s", raw)
	}
	baseURL.Path = strings.TrimRight(baseURL.Path, "/")
	baseURL.RawQuery = ""
	baseURL.Fragment = ""
	return baseURL, nil
}

func migrateCloudConfigExists(ctx context.Context, client *http.Client, baseURL *url.URL, token, teamName, hash string) (bool, error) {
	requestURL := migrateCloudURL(baseURL, "/v1/teams/"+url.PathEscape(teamName)+"/config/"+url.PathEscape(hash))
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, requestURL, nil)
	if err != nil {
		return false, err
	}
	setMigrateCloudHeaders(request, token)
	response, err := client.Do(request)
	if err != nil {
		return false, fmt.Errorf("checking config hash %s: %w", hash, err)
	}
	defer response.Body.Close()
	switch response.StatusCode {
	case http.StatusOK:
		return true, nil
	case http.StatusNotFound:
		return false, nil
	default:
		return false, migrateCloudUnexpectedStatus("checking config hash", response)
	}
}

func migrateCloudUploadConfig(ctx context.Context, client *http.Client, baseURL *url.URL, token string, source *cloudSource) error {
	body := map[string]string{
		"content_yaml": source.Workflow.Content,
		"created_by":   "migration",
		"notes":        "imported from " + source.Workflow.Path,
	}
	request, err := migrateCloudJSONRequest(ctx, http.MethodPost, migrateCloudURL(baseURL, "/v1/teams/"+url.PathEscape(source.TeamName)+"/config"), token, body)
	if err != nil {
		return err
	}
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("uploading config hash %s: %w", source.Workflow.ContentHash, err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return migrateCloudUnexpectedStatus("uploading config", response)
	}
	return nil
}

func migrateCloudExistingBoardExternalIDs(ctx context.Context, client *http.Client, baseURL *url.URL, token, teamName string) (map[string]struct{}, error) {
	requestURL := migrateCloudURL(baseURL, "/v1/teams/"+url.PathEscape(teamName)+"/board")
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, requestURL, nil)
	if err != nil {
		return nil, err
	}
	setMigrateCloudHeaders(request, token)
	response, err := client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("checking board external ids: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		return map[string]struct{}{}, nil
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, migrateCloudUnexpectedStatus("checking board external ids", response)
	}

	var body struct {
		Board map[string][]map[string]any `json:"board"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		return nil, fmt.Errorf("decoding board response: %w", err)
	}
	existing := make(map[string]struct{})
	for _, entries := range body.Board {
		for _, entry := range entries {
			if externalID := migrationBoardExternalIDFromMap(entry); externalID != "" {
				existing[externalID] = struct{}{}
			}
		}
	}
	return existing, nil
}

func migrationBoardExternalIDFromMap(entry map[string]any) string {
	for _, key := range []string{"external_id", "externalId"} {
		if value, ok := entry[key].(string); ok {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func migrateCloudUploadBoardEntries(ctx context.Context, client *http.Client, baseURL *url.URL, token, teamName string, entries []cloudBoardEntry) error {
	body := map[string][]cloudBoardEntry{"entries": entries}
	request, err := migrateCloudJSONRequest(ctx, http.MethodPost, migrateCloudURL(baseURL, "/v1/teams/"+url.PathEscape(teamName)+"/board/refresh"), token, body)
	if err != nil {
		return err
	}
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("uploading board entries: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return migrateCloudUnexpectedStatus("uploading board entries", response)
	}
	return nil
}

func migrateCloudJSONRequest(ctx context.Context, method, requestURL, token string, payload any) (*http.Request, error) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, method, requestURL, bytes.NewReader(encoded))
	if err != nil {
		return nil, err
	}
	setMigrateCloudHeaders(request, token)
	request.Header.Set("Content-Type", "application/json")
	return request, nil
}

func setMigrateCloudHeaders(request *http.Request, token string) {
	request.Header.Set("Accept", "application/json")
	if token = strings.TrimSpace(token); token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
}

func migrateCloudURL(baseURL *url.URL, path string) string {
	resolved := *baseURL
	resolved.Path = strings.TrimRight(baseURL.Path, "/") + path
	return resolved.String()
}

func migrateCloudUnexpectedStatus(action string, response *http.Response) error {
	body, _ := io.ReadAll(io.LimitReader(response.Body, 1024))
	message := strings.TrimSpace(string(body))
	if message == "" {
		message = response.Status
	}
	return fmt.Errorf("%s: %s", action, message)
}

func printMigrateCloudUploadResult(w io.Writer, result cloudUploadResult) {
	configAction := "uploaded"
	if result.Config.Skipped {
		configAction = "skipped (" + result.Config.Reason + ")"
	}
	_, _ = fmt.Fprintf(w, "config: %s\n", configAction)
	_, _ = fmt.Fprintf(w, "board uploads: %d uploaded, %d skipped by external_id\n", len(result.Board.Uploaded), len(result.Board.Skipped))
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
