package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"runtime"
	"strings"
	"time"

	"github.com/99designs/keyring"
	"github.com/spf13/cobra"

	workerv1 "github.com/junhoyeo/contrabass/internal/workerproto/v1"
)

const (
	defaultWorkerAPIBaseURL = "https://api.contrabass.dev"
	workerCredentialService = "contrabass-worker"
)

type workerLoginOptions struct {
	Code       string
	APIBaseURL string
	WorkerID   string
}

type workerEnrollment struct {
	TeamID       string `json:"teamId"`
	WorkerID     string `json:"workerId"`
	RefreshToken string `json:"refreshToken"`
}

type workerEnrollmentStore interface {
	StoreWorkerEnrollment(ctx context.Context, enrollment workerEnrollment) error
}

var (
	workerLoginHTTPClient = &http.Client{Timeout: 30 * time.Second}
	newWorkerLoginStore   = func() (workerEnrollmentStore, error) {
		return newWorkerCredentialKeyringStore()
	}
)

var workerLoginCmd = &cobra.Command{
	Use:   "login",
	Short: "Enroll this machine as a cloud worker",
	Long: `Exchange a one-time enrollment code from the Contrabass dashboard for a
worker refresh token and store it in the OS-native credential store.`,
	RunE: runWorkerLogin,
}

func init() {
	workerLoginCmd.Flags().String("code", "", "one-time enrollment code from the dashboard (required)")
	workerLoginCmd.Flags().String("api-url", defaultWorkerAPIBaseURL, "Contrabass cloud API base URL")
	workerLoginCmd.Flags().String("worker-id", "", "optional worker ID to request during enrollment")
	_ = workerLoginCmd.MarkFlagRequired("code")
}

func runWorkerLogin(cmd *cobra.Command, _ []string) error {
	opts, err := workerLoginOptionsFromFlags(cmd)
	if err != nil {
		return err
	}

	enrollment, err := exchangeWorkerEnrollmentCode(cmd.Context(), opts)
	if err != nil {
		return err
	}

	store, err := newWorkerLoginStore()
	if err != nil {
		return fmt.Errorf("opening OS credential store: %w", err)
	}
	if err := store.StoreWorkerEnrollment(cmd.Context(), enrollment); err != nil {
		return fmt.Errorf("storing worker refresh token in OS credential store: %w", err)
	}

	fmt.Fprintf(cmd.OutOrStdout(), "Enrolled worker %q for team %q. Refresh token stored in OS credential store.\n", enrollment.WorkerID, enrollment.TeamID)
	return nil
}

func workerLoginOptionsFromFlags(cmd *cobra.Command) (workerLoginOptions, error) {
	code, err := cmd.Flags().GetString("code")
	if err != nil {
		return workerLoginOptions{}, fmt.Errorf("getting code flag: %w", err)
	}
	apiBaseURL, err := cmd.Flags().GetString("api-url")
	if err != nil {
		return workerLoginOptions{}, fmt.Errorf("getting api-url flag: %w", err)
	}
	workerID, err := cmd.Flags().GetString("worker-id")
	if err != nil {
		return workerLoginOptions{}, fmt.Errorf("getting worker-id flag: %w", err)
	}

	opts := workerLoginOptions{
		Code:       strings.TrimSpace(code),
		APIBaseURL: strings.TrimSpace(apiBaseURL),
		WorkerID:   strings.TrimSpace(workerID),
	}
	if opts.Code == "" {
		return workerLoginOptions{}, errors.New("code is required")
	}
	return opts, nil
}

func exchangeWorkerEnrollmentCode(ctx context.Context, opts workerLoginOptions) (workerEnrollment, error) {
	endpoint, err := workerEnrollEndpoint(opts.APIBaseURL)
	if err != nil {
		return workerEnrollment{}, err
	}

	body := map[string]string{
		"code":             opts.Code,
		"protocol_version": string(workerv1.ProtocolVersionCurrent),
	}
	if opts.WorkerID != "" {
		body["workerId"] = opts.WorkerID
	}

	payload, err := json.Marshal(body)
	if err != nil {
		return workerEnrollment{}, fmt.Errorf("encoding enrollment request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return workerEnrollment{}, fmt.Errorf("creating enrollment request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	resp, err := workerLoginHTTPClient.Do(req)
	if err != nil {
		return workerEnrollment{}, fmt.Errorf("posting enrollment request: %w", err)
	}
	defer resp.Body.Close()

	var response struct {
		TeamID          string `json:"teamId"`
		WorkerID        string `json:"workerId"`
		RefreshToken    string `json:"refreshToken"`
		Error           string `json:"error"`
		ProtocolVersion string `json:"protocol_version"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&response); err != nil {
		return workerEnrollment{}, fmt.Errorf("decoding enrollment response: %w", err)
	}

	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		if response.Error == "enrollment_invalid" {
			return workerEnrollment{}, errors.New("enrollment code is invalid or expired; generate a fresh code from the dashboard")
		}
		if response.Error != "" {
			return workerEnrollment{}, fmt.Errorf("enrollment failed: %s (HTTP %d)", response.Error, resp.StatusCode)
		}
		return workerEnrollment{}, fmt.Errorf("enrollment failed: HTTP %d", resp.StatusCode)
	}

	if response.TeamID == "" || response.WorkerID == "" || response.RefreshToken == "" {
		return workerEnrollment{}, errors.New("enrollment response missing teamId, workerId, or refreshToken")
	}

	return workerEnrollment{
		TeamID:       response.TeamID,
		WorkerID:     response.WorkerID,
		RefreshToken: response.RefreshToken,
	}, nil
}

func workerEnrollEndpoint(apiBaseURL string) (string, error) {
	if apiBaseURL == "" {
		return "", errors.New("api-url is required")
	}
	parsed, err := url.Parse(apiBaseURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", fmt.Errorf("invalid api-url %q", apiBaseURL)
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/") + "/v1/workers/enroll"
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return parsed.String(), nil
}

func newWorkerCredentialKeyringStore() (workerEnrollmentStore, error) {
	backends, err := workerNativeCredentialBackends()
	if err != nil {
		return nil, err
	}
	ring, err := keyring.Open(keyring.Config{
		AllowedBackends:         backends,
		ServiceName:             workerCredentialService,
		KeychainName:            "login",
		LibSecretCollectionName: "default",
		WinCredPrefix:           workerCredentialService,
	})
	if err != nil {
		return nil, err
	}
	return workerCredentialKeyringStore{ring: ring}, nil
}

func workerNativeCredentialBackends() ([]keyring.BackendType, error) {
	switch runtime.GOOS {
	case "darwin":
		return []keyring.BackendType{keyring.KeychainBackend}, nil
	case "linux":
		return []keyring.BackendType{keyring.SecretServiceBackend}, nil
	case "windows":
		return []keyring.BackendType{keyring.WinCredBackend}, nil
	default:
		return nil, fmt.Errorf("no OS-native credential store configured for %s", runtime.GOOS)
	}
}

type workerCredentialKeyringStore struct {
	ring keyring.Keyring
}

func (s workerCredentialKeyringStore) StoreWorkerEnrollment(_ context.Context, enrollment workerEnrollment) error {
	data, err := json.Marshal(enrollment)
	if err != nil {
		return fmt.Errorf("encoding credential payload: %w", err)
	}
	return s.ring.Set(keyring.Item{
		Key:         workerCredentialKey(enrollment.TeamID),
		Data:        data,
		Label:       fmt.Sprintf("Contrabass worker refresh token for %s", enrollment.TeamID),
		Description: "Contrabass cloud worker enrollment",
	})
}

func workerCredentialKey(teamID string) string {
	return "worker/" + teamID
}
