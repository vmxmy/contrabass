package configcmd

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	workflowconfig "github.com/junhoyeo/contrabass/internal/config"
)

const defaultConfigRequestTimeout = 30 * time.Second

// configHTTPClient is the HTTP client used for cloud config uploads. It is a
// package var so tests can swap in an httptest server client.
var configHTTPClient = &http.Client{Timeout: defaultConfigRequestTimeout}

// CloudOptions holds the resolved cloud API connection settings.
type CloudOptions struct {
	APIURL string
	Token  string
	Team   string
}

type configPushResponse struct {
	TeamID      string `json:"teamId"`
	Version     int    `json:"version"`
	ContentHash string `json:"contentHash"`
	Unchanged   bool   `json:"unchanged"`
}

type configErrorResponse struct {
	Error   string `json:"error"`
	Details []struct {
		Path    string `json:"path"`
		Message string `json:"message"`
	} `json:"details"`
}

// Push reads a workflow config file and uploads it to the cloud config store.
func Push(
	ctx context.Context,
	out io.Writer,
	opts *CloudOptions,
	path string,
	createdBy string,
	notes string,
) error {
	content, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("reading config file: %w", err)
	}
	return pushConfigContent(ctx, out, opts, string(content), createdBy, notes)
}

// ImportMD validates a WORKFLOW.md and uploads it with import metadata.
func ImportMD(ctx context.Context, out io.Writer, opts *CloudOptions, path string) error {
	if _, err := workflowconfig.ParseWorkflow(path); err != nil {
		return fmt.Errorf("parsing workflow config: %w", err)
	}

	content, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("reading workflow config: %w", err)
	}

	return pushConfigContent(ctx, out, opts, string(content), "import", "imported from "+path)
}

func pushConfigContent(
	ctx context.Context,
	out io.Writer,
	opts *CloudOptions,
	content string,
	createdBy string,
	notes string,
) error {
	resolved, err := resolveConfigCloudOptions(opts)
	if err != nil {
		return err
	}

	response, err := postTeamConfig(ctx, resolved, content, createdBy, notes)
	if err != nil {
		return err
	}

	status := "created"
	if response.Unchanged {
		status = "unchanged"
	}
	fmt.Fprintf(
		out,
		"config %s: team=%s version=%d hash=%s\n",
		status,
		response.TeamID,
		response.Version,
		response.ContentHash,
	)
	return nil
}

func resolveConfigCloudOptions(opts *CloudOptions) (CloudOptions, error) {
	if opts == nil {
		return CloudOptions{}, errors.New("config options are required")
	}

	resolved := *opts
	if strings.TrimSpace(resolved.APIURL) == "" {
		resolved.APIURL = os.Getenv("CONTRABASS_API_URL")
	}
	if strings.TrimSpace(resolved.APIURL) == "" {
		resolved.APIURL = os.Getenv("CONTRABASS_API_BASE_URL")
	}
	if strings.TrimSpace(resolved.Token) == "" {
		resolved.Token = os.Getenv("CONTRABASS_API_TOKEN")
	}

	resolved.APIURL = strings.TrimSpace(resolved.APIURL)
	resolved.Token = strings.TrimSpace(resolved.Token)
	resolved.Team = strings.TrimSpace(resolved.Team)

	if resolved.APIURL == "" {
		return CloudOptions{}, errors.New("config command requires --api-url or CONTRABASS_API_URL")
	}
	if resolved.Token == "" {
		return CloudOptions{}, errors.New("config command requires --token or CONTRABASS_API_TOKEN")
	}
	if resolved.Team == "" {
		return CloudOptions{}, errors.New("config command requires --team")
	}

	parsed, err := url.Parse(resolved.APIURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return CloudOptions{}, fmt.Errorf("invalid config api url %q", resolved.APIURL)
	}
	resolved.APIURL = strings.TrimRight(resolved.APIURL, "/")

	return resolved, nil
}

func postTeamConfig(
	ctx context.Context,
	opts CloudOptions,
	content string,
	createdBy string,
	notes string,
) (configPushResponse, error) {
	requestBody := map[string]string{
		"content_yaml": content,
		"created_by":   createdBy,
	}
	if strings.TrimSpace(notes) != "" {
		requestBody["notes"] = notes
	}

	encoded, err := json.Marshal(requestBody)
	if err != nil {
		return configPushResponse{}, fmt.Errorf("encoding config request: %w", err)
	}

	endpoint := fmt.Sprintf("%s/v1/teams/%s/config", opts.APIURL, url.PathEscape(opts.Team))
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(encoded))
	if err != nil {
		return configPushResponse{}, fmt.Errorf("creating config request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+opts.Token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	resp, err := configHTTPClient.Do(req)
	if err != nil {
		return configPushResponse{}, fmt.Errorf("posting config: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return configPushResponse{}, fmt.Errorf("reading config response: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return configPushResponse{}, formatConfigAPIError(resp.StatusCode, body)
	}

	var result configPushResponse
	if err := json.Unmarshal(body, &result); err != nil {
		return configPushResponse{}, fmt.Errorf("decoding config response: %w", err)
	}
	return result, nil
}

func formatConfigAPIError(statusCode int, body []byte) error {
	var apiErr configErrorResponse
	if err := json.Unmarshal(body, &apiErr); err == nil && strings.TrimSpace(apiErr.Error) != "" {
		var b strings.Builder
		fmt.Fprintf(&b, "config api returned %d: %s", statusCode, apiErr.Error)
		for _, detail := range apiErr.Details {
			if detail.Path == "" && detail.Message == "" {
				continue
			}
			fmt.Fprintf(&b, " (%s: %s)", detail.Path, detail.Message)
		}
		return errors.New(b.String())
	}

	text := strings.TrimSpace(string(body))
	if text == "" {
		return fmt.Errorf("config api returned %d", statusCode)
	}
	return fmt.Errorf("config api returned %d: %s", statusCode, text)
}
