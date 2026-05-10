package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os/exec"
	"runtime"
	"strings"

	"github.com/spf13/cobra"

	workerv1 "github.com/junhoyeo/contrabass/internal/workerproto/v1"
)

// workerEphemeralDefaultLeaseSec is the client-side fallback lease duration for
// --ephemeral workers when the cloud registration response omits leaseSec. CI
// runners vanish without warning, so a short lease lets the cloud detect and
// requeue orphaned runs quickly.
const workerEphemeralDefaultLeaseSec workerv1.LeaseSec = 30

type workerOptions struct {
	TeamID         string
	APIBaseURL     string
	MaxConcurrency int
	Ephemeral      bool
}

type workerRegistration struct {
	APIBaseURL           string
	SessionToken         string
	RefreshToken         string
	DispatchChannel      workerv1.WorkerRegisterResponseDispatchChannel
	HeartbeatIntervalSec int
	LeaseSec             workerv1.LeaseSec
	ProtocolVersion      workerv1.ProtocolVersion
	Ephemeral            bool
	// Session is a shared, refreshable token manager. All HTTP callers must use
	// currentToken() rather than reading SessionToken directly so that proactive
	// refresh (every ~45 min) is transparent to every call site.
	Session *workerSessionManager
}

// currentToken returns the most recently refreshed bearer token. Falls back to
// the static SessionToken field when no session manager is set (e.g., in tests
// that stub the dispatch consumer directly).
func (r workerRegistration) currentToken() string {
	if r.Session != nil {
		return r.Session.CurrentToken()
	}
	return r.SessionToken
}

var workerLookupPath = exec.LookPath
var workerDispatchConsumer = consumeWorkerDispatches

var workerCmd = &cobra.Command{
	Use:   "worker",
	Short: "Run a local worker daemon for a cloud team",
	Long: `Run a local worker daemon that registers with the Contrabass cloud control
plane, waits for dispatched runs, and executes them on this machine.

Enrollment is required before starting a worker. If this machine has not been
enrolled yet, run "contrabass worker login" first.`,
	RunE: runWorker,
}

func init() {
	workerCmd.Flags().String("team", "", "cloud team ID to register this worker with (required)")
	workerCmd.Flags().String("api-url", defaultWorkerAPIBaseURL, "Contrabass cloud API base URL")
	workerCmd.Flags().Int("max-concurrency", 1, "maximum concurrently-acked runs this worker accepts")
	workerCmd.Flags().Bool("ephemeral", false, "CI/ephemeral mode: hints the cloud to grant a shorter lease and applies shorter client-side lease defaults")
	_ = workerCmd.MarkFlagRequired("team")
	workerCmd.AddCommand(workerLoginCmd)
}

func runWorker(cmd *cobra.Command, _ []string) error {
	opts, err := workerOptionsFromFlags(cmd)
	if err != nil {
		return err
	}

	store, err := newWorkerLoginStore()
	if err != nil {
		return fmt.Errorf("opening OS credential store: %w", err)
	}
	enrollment, err := store.LoadWorkerEnrollment(cmd.Context(), opts.TeamID)
	if err != nil {
		if errors.Is(err, errWorkerEnrollmentNotFound) {
			return fmt.Errorf("worker enrollment not found for team %q; run \"contrabass worker login\" first", opts.TeamID)
		}
		return fmt.Errorf("loading worker enrollment from OS credential store: %w", err)
	}

	capabilities, err := detectWorkerCapabilities()
	if err != nil {
		return err
	}

	registration, err := registerWorker(cmd.Context(), opts, enrollment, capabilities)
	if err != nil {
		return err
	}
	if registration.RefreshToken != "" && registration.RefreshToken != enrollment.RefreshToken {
		enrollment.RefreshToken = registration.RefreshToken
		if err := store.StoreWorkerEnrollment(cmd.Context(), enrollment); err != nil {
			return fmt.Errorf("storing refreshed worker token in OS credential store: %w", err)
		}
	}

	// Start a proactive session-token refresh so the short-lived bearer token
	// (≤1 hour) is rotated transparently for all in-flight API calls throughout
	// a long soak run. The goroutine exits when ctx is cancelled via defer below.
	ctx, cancel := context.WithCancel(cmd.Context())
	defer cancel()
	session := newWorkerSessionManager(registration)
	registration.Session = session
	go session.RunProactiveRefresh(ctx, workerSessionRefreshInterval)

	fmt.Fprintf(
		cmd.OutOrStdout(),
		"Registered worker %q for team %q. Dispatch WebSocket: %s\n",
		enrollment.WorkerID,
		enrollment.TeamID,
		registration.DispatchChannel.WsURL,
	)
	executor, err := newWorkerRunExecutor(workerRunExecutorConfig{
		TeamID:       enrollment.TeamID,
		WorkerID:     enrollment.WorkerID,
		Capabilities: capabilities,
		Registration: registration,
	})
	if err != nil {
		return err
	}
	ackHandler := newWorkerAckingDispatchHandler(registration, opts.MaxConcurrency, executor.Run)
	return workerDispatchConsumer(ctx, registration, ackHandler.Handle, ackHandler.RevokeRun)
}

func workerOptionsFromFlags(cmd *cobra.Command) (workerOptions, error) {
	teamID, err := cmd.Flags().GetString("team")
	if err != nil {
		return workerOptions{}, fmt.Errorf("getting team flag: %w", err)
	}
	apiBaseURL, err := cmd.Flags().GetString("api-url")
	if err != nil {
		return workerOptions{}, fmt.Errorf("getting api-url flag: %w", err)
	}
	maxConcurrency, err := cmd.Flags().GetInt("max-concurrency")
	if err != nil {
		return workerOptions{}, fmt.Errorf("getting max-concurrency flag: %w", err)
	}
	if maxConcurrency < 1 {
		return workerOptions{}, errors.New("max-concurrency must be at least 1")
	}
	ephemeral, err := cmd.Flags().GetBool("ephemeral")
	if err != nil {
		return workerOptions{}, fmt.Errorf("getting ephemeral flag: %w", err)
	}

	return workerOptions{
		TeamID:         strings.TrimSpace(teamID),
		APIBaseURL:     strings.TrimSpace(apiBaseURL),
		MaxConcurrency: maxConcurrency,
		Ephemeral:      ephemeral,
	}, nil
}

func detectWorkerCapabilities() ([]workerv1.Capability, error) {
	runnerCommands := []struct {
		runner  string
		command string
	}{
		{runner: "codex", command: "codex"},
		{runner: "opencode", command: "opencode"},
		{runner: "omx", command: "omx"},
		{runner: "omc", command: "omc"},
		{runner: "mock", command: "mock"},
	}

	var capabilities []workerv1.Capability
	var missing []string
	for _, candidate := range runnerCommands {
		if _, err := workerLookupPath(candidate.command); err == nil {
			capabilities = append(capabilities, workerv1.Capability("agent:"+candidate.runner))
		} else {
			missing = append(missing, candidate.runner)
		}
	}
	if len(capabilities) == 0 {
		return nil, fmt.Errorf("no supported agent runner found on PATH; missing runners: %s", strings.Join(missing, ", "))
	}

	if _, err := workerLookupPath("git"); err == nil {
		capabilities = append(capabilities, "git")
	}
	if _, err := workerLookupPath("tmux"); err == nil {
		capabilities = append(capabilities, "tmux")
	}
	capabilities = append(capabilities,
		workerv1.Capability("os:"+runtime.GOOS),
		workerv1.Capability("arch:"+runtime.GOARCH),
	)

	return capabilities, nil
}

func registerWorker(
	ctx context.Context,
	opts workerOptions,
	enrollment workerEnrollment,
	capabilities []workerv1.Capability,
) (workerRegistration, error) {
	sessionToken, err := refreshWorkerSession(ctx, opts.APIBaseURL, enrollment.RefreshToken)
	if err != nil {
		return workerRegistration{}, err
	}

	// Embed the generated type and extend with the ephemeral hint. The cloud
	// uses this to grant a shorter lease; unknown fields are safe to send.
	request := struct {
		workerv1.WorkerRegisterRequest
		Ephemeral bool `json:"ephemeral,omitempty"`
	}{
		WorkerRegisterRequest: workerv1.WorkerRegisterRequest{
			TeamID:                    workerv1.TeamID(enrollment.TeamID),
			WorkerID:                  workerv1.WorkerID(enrollment.WorkerID),
			Capabilities:              capabilities,
			MaxConcurrency:            opts.MaxConcurrency,
			Version:                   version,
			SupportedProtocolVersions: []string{string(workerv1.ProtocolVersionCurrent)},
			ProtocolVersion:           workerv1.ProtocolVersionCurrent,
			Kind:                      workerv1.WorkerRegisterRequestKindLocal,
		},
		Ephemeral: opts.Ephemeral,
	}

	endpoint, err := workerAPIEndpoint(opts.APIBaseURL, "/v1/workers/register")
	if err != nil {
		return workerRegistration{}, err
	}
	payload, err := json.Marshal(request)
	if err != nil {
		return workerRegistration{}, fmt.Errorf("encoding registration request: %w", err)
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return workerRegistration{}, fmt.Errorf("creating registration request: %w", err)
	}
	httpReq.Header.Set("Authorization", "Bearer "+sessionToken)
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept", "application/json")

	resp, err := workerLoginHTTPClient.Do(httpReq)
	if err != nil {
		return workerRegistration{}, fmt.Errorf("posting registration request: %w", err)
	}
	defer resp.Body.Close()

	var response struct {
		SessionToken         string                                         `json:"sessionToken"`
		RefreshToken         string                                         `json:"refreshToken"`
		DispatchChannel      workerv1.WorkerRegisterResponseDispatchChannel `json:"dispatchChannel"`
		HeartbeatIntervalSec int                                            `json:"heartbeatIntervalSec"`
		LeaseSec             workerv1.LeaseSec                              `json:"leaseSec"`
		Error                string                                         `json:"error"`
		ProtocolVersion      workerv1.ProtocolVersion                       `json:"protocol_version"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&response); err != nil {
		return workerRegistration{}, fmt.Errorf("decoding registration response: %w", err)
	}
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		if response.Error != "" {
			return workerRegistration{}, fmt.Errorf("worker registration failed: %s (HTTP %d)", response.Error, resp.StatusCode)
		}
		return workerRegistration{}, fmt.Errorf("worker registration failed: HTTP %d", resp.StatusCode)
	}
	if response.SessionToken == "" || response.DispatchChannel.WsURL == "" || response.DispatchChannel.LongPollURL == "" {
		return workerRegistration{}, errors.New("registration response missing sessionToken, dispatchChannel.wsUrl, or dispatchChannel.longPollUrl")
	}

	leaseSec := response.LeaseSec
	if leaseSec == 0 && opts.Ephemeral {
		leaseSec = workerEphemeralDefaultLeaseSec
	}

	return workerRegistration{
		APIBaseURL:           opts.APIBaseURL,
		SessionToken:         response.SessionToken,
		RefreshToken:         response.RefreshToken,
		DispatchChannel:      response.DispatchChannel,
		HeartbeatIntervalSec: response.HeartbeatIntervalSec,
		LeaseSec:             leaseSec,
		ProtocolVersion:      response.ProtocolVersion,
		Ephemeral:            opts.Ephemeral,
	}, nil
}

func refreshWorkerSession(ctx context.Context, apiBaseURL, refreshToken string) (string, error) {
	endpoint, err := workerAPIEndpoint(apiBaseURL, "/v1/workers/refresh")
	if err != nil {
		return "", err
	}
	payload, err := json.Marshal(workerv1.WorkerRefreshRequest{
		RefreshToken:    workerv1.BearerToken(refreshToken),
		ProtocolVersion: workerv1.ProtocolVersionCurrent,
	})
	if err != nil {
		return "", fmt.Errorf("encoding refresh request: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return "", fmt.Errorf("creating refresh request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	resp, err := workerLoginHTTPClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("posting refresh request: %w", err)
	}
	defer resp.Body.Close()

	var response struct {
		SessionToken    string                   `json:"sessionToken"`
		Error           string                   `json:"error"`
		ProtocolVersion workerv1.ProtocolVersion `json:"protocol_version"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&response); err != nil {
		return "", fmt.Errorf("decoding refresh response: %w", err)
	}
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		switch response.Error {
		case "refresh_revoked", "refresh_expired", "refresh_invalid":
			return "", fmt.Errorf("worker refresh token is invalid; run \"contrabass worker login\" again (%s)", response.Error)
		case "":
			return "", fmt.Errorf("worker session refresh failed: HTTP %d", resp.StatusCode)
		default:
			return "", fmt.Errorf("worker session refresh failed: %s (HTTP %d)", response.Error, resp.StatusCode)
		}
	}
	if response.SessionToken == "" {
		return "", errors.New("refresh response missing sessionToken")
	}
	return response.SessionToken, nil
}

func workerAPIEndpoint(apiBaseURL, path string) (string, error) {
	if apiBaseURL == "" {
		return "", errors.New("api-url is required")
	}
	parsed, err := url.Parse(apiBaseURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", fmt.Errorf("invalid api-url %q", apiBaseURL)
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/") + path
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return parsed.String(), nil
}
