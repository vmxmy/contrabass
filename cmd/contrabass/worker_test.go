package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"

	"github.com/spf13/cobra"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/junhoyeo/contrabass/internal/cli/worker"
	workerv1 "github.com/junhoyeo/contrabass/internal/workerproto/v1"
)

// These tests cover the CLI wiring layer: that the worker/login subcommands are
// registered on the root command, parse flags correctly, and delegate to the
// internal/cli/worker runtime. The runtime logic itself is unit-tested in the
// internal/cli/worker package.

type fakeWorkerEnrollmentStore struct {
	enrollments []worker.Enrollment
	byTeam      map[string]worker.Enrollment
}

func (s *fakeWorkerEnrollmentStore) StoreWorkerEnrollment(_ context.Context, enrollment worker.Enrollment) error {
	s.enrollments = append(s.enrollments, enrollment)
	if s.byTeam == nil {
		s.byTeam = make(map[string]worker.Enrollment)
	}
	s.byTeam[enrollment.TeamID] = enrollment
	return nil
}

func (s *fakeWorkerEnrollmentStore) LoadWorkerEnrollment(_ context.Context, teamID string) (worker.Enrollment, error) {
	enrollment, ok := s.byTeam[teamID]
	if !ok {
		return worker.Enrollment{}, worker.ErrEnrollmentNotFound
	}
	return enrollment, nil
}

func stubWorkerLoginDependencies(t *testing.T, client *http.Client, store worker.EnrollmentStore) func() {
	t.Helper()
	return worker.StubLoginDependencies(client, store)
}

func stubWorkerLookupPath(lookup func(string) (string, error)) func() {
	return worker.StubLookupPath(lookup)
}

func stubWorkerDispatchConsumer(consumer worker.DispatchConsumerFunc) func() {
	return worker.StubDispatchConsumer(consumer)
}

func missingWorkerLookupPath(string) (string, error) {
	return "", errors.New("not found")
}

func filterWorkerCapabilitiesForTest(raw any, excludedPrefixes ...string) []any {
	values, ok := raw.([]any)
	if !ok {
		return nil
	}
	filtered := make([]any, 0, len(values))
	for _, value := range values {
		text, ok := value.(string)
		if !ok {
			continue
		}
		excluded := false
		for _, prefix := range excludedPrefixes {
			if strings.HasPrefix(text, prefix) {
				excluded = true
				break
			}
		}
		if !excluded {
			filtered = append(filtered, text)
		}
	}
	return filtered
}

func resetWorkerFlagState() {
	for _, name := range []string{"team", "api-url", "max-concurrency", "ephemeral", "help"} {
		flag := workerCmd.Flags().Lookup(name)
		if flag == nil {
			continue
		}
		_ = flag.Value.Set(flag.DefValue)
		flag.Changed = false
	}
}

func workerLoginSubcommand() *cobra.Command {
	for _, sub := range workerCmd.Commands() {
		if sub.Name() == "login" {
			return sub
		}
	}
	return nil
}

func resetWorkerLoginFlagState() {
	login := workerLoginSubcommand()
	if login == nil {
		return
	}
	for _, name := range []string{"code", "api-url", "worker-id"} {
		flag := login.Flags().Lookup(name)
		if flag == nil {
			continue
		}
		_ = flag.Value.Set(flag.DefValue)
		flag.Changed = false
	}
}

func TestWorkerCommandIsRegistered(t *testing.T) {
	cmd := newRootCmd()

	worker, _, err := cmd.Find([]string{"worker"})
	require.NoError(t, err)
	require.NotNil(t, worker)
	assert.Equal(t, "worker", worker.Name())
}

func TestWorkerCommandValidation(t *testing.T) {
	defer resetWorkerFlagState()

	tests := []struct {
		name        string
		args        []string
		store       *fakeWorkerEnrollmentStore
		lookup      func(string) (string, error)
		wantErr     string
		wantNoError bool
	}{
		{
			name:    "requires team flag",
			args:    []string{"worker"},
			wantErr: `required flag(s) "team" not set`,
		},
		{
			name:    "without enrollment instructs login",
			args:    []string{"worker", "--team", "my-team"},
			store:   &fakeWorkerEnrollmentStore{},
			wantErr: `run "contrabass worker login" first`,
		},
		{
			name: "with enrollment loads credential before registration",
			args: []string{"worker", "--team", "my-team"},
			store: &fakeWorkerEnrollmentStore{byTeam: map[string]worker.Enrollment{
				"my-team": {
					TeamID:       "my-team",
					WorkerID:     "worker-1",
					RefreshToken: "refresh-token-123",
				},
			}},
			lookup:  missingWorkerLookupPath,
			wantErr: `no supported agent runner found on PATH`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.store != nil {
				restore := stubWorkerLoginDependencies(t, http.DefaultClient, tt.store)
				defer restore()
			}
			if tt.lookup != nil {
				restore := stubWorkerLookupPath(tt.lookup)
				defer restore()
			}

			cmd := newRootCmd()
			buf := new(bytes.Buffer)
			cmd.SetOut(buf)
			cmd.SetErr(buf)
			cmd.SetArgs(tt.args)

			err := cmd.Execute()
			if tt.wantNoError {
				require.NoError(t, err)
				return
			}

			require.Error(t, err)
			assert.Contains(t, err.Error(), tt.wantErr)
		})
	}
}

func TestWorkerCommandRegistersWithDetectedCapabilities(t *testing.T) {
	defer resetWorkerFlagState()

	store := &fakeWorkerEnrollmentStore{byTeam: map[string]worker.Enrollment{
		"team-1": {
			TeamID:       "team-1",
			WorkerID:     "worker-1",
			RefreshToken: "stored-refresh",
		},
	}}
	var refreshBody map[string]any
	var registerBody map[string]any
	var registerAuth string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/workers/refresh":
			require.NoError(t, json.NewDecoder(r.Body).Decode(&refreshBody))
			_, _ = w.Write([]byte(`{
				"sessionToken": "session-from-refresh",
				"expiresAt": 123456,
				"protocol_version": "1.0.0"
			}`))
		case "/v1/workers/register":
			registerAuth = r.Header.Get("Authorization")
			require.NoError(t, json.NewDecoder(r.Body).Decode(&registerBody))
			_, _ = w.Write([]byte(`{
				"sessionToken": "registered-session",
				"refreshToken": "rotated-refresh",
				"dispatchChannel": {
					"wsUrl": "wss://api.test/v1/workers/worker-1/dispatch-ws",
					"longPollUrl": "https://api.test/v1/workers/worker-1/dispatch?wait=25s"
				},
				"heartbeatIntervalSec": 20,
				"leaseSec": 60,
				"protocol_version": "1.0.0"
			}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	restoreDeps := stubWorkerLoginDependencies(t, server.Client(), store)
	defer restoreDeps()
	restoreConsumer := stubWorkerDispatchConsumer(func(context.Context, worker.Registration, worker.DispatchHandler, worker.LeaseRevokedHandler) error {
		return nil
	})
	defer restoreConsumer()
	restoreLookup := stubWorkerLookupPath(func(name string) (string, error) {
		switch name {
		case "codex", "omx", "git", "tmux":
			return "/usr/bin/" + name, nil
		default:
			return "", errors.New("not found")
		}
	})
	defer restoreLookup()

	cmd := newRootCmd()
	buf := new(bytes.Buffer)
	cmd.SetOut(buf)
	cmd.SetErr(buf)
	cmd.SetArgs([]string{
		"worker",
		"--team", "team-1",
		"--api-url", server.URL,
		"--max-concurrency", "3",
	})

	require.NoError(t, cmd.Execute())
	assert.Equal(t, map[string]any{
		"refreshToken":     "stored-refresh",
		"protocol_version": "1.0.0",
	}, refreshBody)
	assert.Equal(t, "Bearer session-from-refresh", registerAuth)
	assert.Equal(t, "team-1", registerBody["teamId"])
	assert.Equal(t, "worker-1", registerBody["workerId"])
	assert.Equal(t, float64(3), registerBody["maxConcurrency"])
	assert.Equal(t, "dev", registerBody["version"])
	assert.Equal(t, "local", registerBody["kind"])
	assert.Equal(t, "1.0.0", registerBody["protocol_version"])
	assert.ElementsMatch(t,
		[]any{"agent:codex", "agent:omx", "git", "tmux", "os:" + runtime.GOOS},
		filterWorkerCapabilitiesForTest(registerBody["capabilities"], "arch:"),
	)
	assert.Equal(t, "rotated-refresh", store.byTeam["team-1"].RefreshToken)
	assert.Contains(t, buf.String(), `Registered worker "worker-1" for team "team-1"`)
	assert.Contains(t, buf.String(), "wss://api.test/v1/workers/worker-1/dispatch-ws")
	assert.NotContains(t, buf.String(), "registered-session")
	assert.NotContains(t, buf.String(), "rotated-refresh")
}

func TestWorkerCommandHelpDocumentsEnrollment(t *testing.T) {
	defer resetWorkerFlagState()
	cmd := newRootCmd()
	buf := new(bytes.Buffer)
	cmd.SetOut(buf)
	cmd.SetErr(buf)
	cmd.SetArgs([]string{"worker", "--help"})

	require.NoError(t, cmd.Execute())
	output := buf.String()
	assert.Contains(t, output, "--team")
	assert.Contains(t, output, `contrabass worker login`)
}

func TestWorkerLoginCommandEnrollsWithOneTimeCode(t *testing.T) {
	defer resetWorkerLoginFlagState()

	var requestBody map[string]string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, http.MethodPost, r.Method)
		assert.Equal(t, "/v1/workers/enroll", r.URL.Path)
		require.NoError(t, json.NewDecoder(r.Body).Decode(&requestBody))

		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"teamId": "team-1",
			"workerId": "worker-1",
			"refreshToken": "refresh-token-123",
			"protocol_version": "1.0.0"
		}`))
	}))
	defer server.Close()

	store := &fakeWorkerEnrollmentStore{}
	restore := stubWorkerLoginDependencies(t, server.Client(), store)
	defer restore()

	cmd := newRootCmd()
	buf := new(bytes.Buffer)
	cmd.SetOut(buf)
	cmd.SetErr(buf)
	cmd.SetArgs([]string{
		"worker", "login",
		"--code", "ABC-123",
		"--api-url", server.URL,
		"--worker-id", "worker-1",
	})

	require.NoError(t, cmd.Execute())
	assert.Equal(t, map[string]string{
		"code":             "ABC-123",
		"workerId":         "worker-1",
		"protocol_version": "1.0.0",
	}, requestBody)
	require.Len(t, store.enrollments, 1)
	assert.Equal(t, worker.Enrollment{
		TeamID:       "team-1",
		WorkerID:     "worker-1",
		RefreshToken: "refresh-token-123",
	}, store.enrollments[0])
	assert.Contains(t, buf.String(), `Enrolled worker "worker-1" for team "team-1"`)
	assert.NotContains(t, buf.String(), "refresh-token-123")
}

func TestWorkerLoginCommandRejectsBadCode(t *testing.T) {
	defer resetWorkerLoginFlagState()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":"enrollment_invalid","protocol_version":"1.0.0"}`))
	}))
	defer server.Close()

	store := &fakeWorkerEnrollmentStore{}
	restore := stubWorkerLoginDependencies(t, server.Client(), store)
	defer restore()

	cmd := newRootCmd()
	buf := new(bytes.Buffer)
	cmd.SetOut(buf)
	cmd.SetErr(buf)
	cmd.SetArgs([]string{"worker", "login", "--code", "BAD-123", "--api-url", server.URL})

	err := cmd.Execute()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "enrollment code is invalid or expired")
	assert.Contains(t, err.Error(), "generate a fresh code")
	assert.Empty(t, store.enrollments)
}

func TestWorkerLoginCommandRequiresCode(t *testing.T) {
	resetWorkerLoginFlagState()
	defer resetWorkerLoginFlagState()

	cmd := newRootCmd()
	buf := new(bytes.Buffer)
	cmd.SetOut(buf)
	cmd.SetErr(buf)
	cmd.SetArgs([]string{"worker", "login"})

	err := cmd.Execute()
	require.Error(t, err)
	assert.Contains(t, err.Error(), `required flag(s) "code" not set`)
}

func TestWorkerCommandEphemeralFlagSendsHintInRegistration(t *testing.T) {
	resetWorkerFlagState()
	defer resetWorkerFlagState()

	store := &fakeWorkerEnrollmentStore{byTeam: map[string]worker.Enrollment{
		"ci-team": {TeamID: "ci-team", WorkerID: "worker-ci", RefreshToken: "refresh-ci"},
	}}
	var registerBody map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/workers/refresh":
			_, _ = w.Write([]byte(`{"sessionToken":"session-ci","protocol_version":"1.0.0"}`))
		case "/v1/workers/register":
			require.NoError(t, json.NewDecoder(r.Body).Decode(&registerBody))
			_, _ = w.Write([]byte(`{
				"sessionToken": "registered-session",
				"dispatchChannel": {
					"wsUrl": "wss://api.test/v1/workers/worker-ci/dispatch-ws",
					"longPollUrl": "https://api.test/v1/workers/worker-ci/dispatch?wait=25s"
				},
				"heartbeatIntervalSec": 10,
				"leaseSec": 30,
				"protocol_version": "1.0.0"
			}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	restoreDeps := stubWorkerLoginDependencies(t, server.Client(), store)
	defer restoreDeps()
	restoreConsumer := stubWorkerDispatchConsumer(func(context.Context, worker.Registration, worker.DispatchHandler, worker.LeaseRevokedHandler) error {
		return nil
	})
	defer restoreConsumer()
	restoreLookup := stubWorkerLookupPath(func(name string) (string, error) {
		if name == "codex" {
			return "/usr/bin/codex", nil
		}
		return "", errors.New("not found")
	})
	defer restoreLookup()

	cmd := newRootCmd()
	buf := new(bytes.Buffer)
	cmd.SetOut(buf)
	cmd.SetErr(buf)
	cmd.SetArgs([]string{"worker", "--team", "ci-team", "--api-url", server.URL, "--ephemeral"})

	require.NoError(t, cmd.Execute())
	assert.Equal(t, true, registerBody["ephemeral"], "ephemeral=true must be forwarded to registration request")
}

func TestWorkerCommandEphemeralFlagAppliesClientSideDefaultLeaseSec(t *testing.T) {
	resetWorkerFlagState()
	defer resetWorkerFlagState()

	store := &fakeWorkerEnrollmentStore{byTeam: map[string]worker.Enrollment{
		"ci-team": {TeamID: "ci-team", WorkerID: "worker-ci", RefreshToken: "refresh-ci"},
	}}
	var capturedRegistration worker.Registration
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/workers/refresh":
			_, _ = w.Write([]byte(`{"sessionToken":"session-ci","protocol_version":"1.0.0"}`))
		case "/v1/workers/register":
			// Cloud omits leaseSec (returns 0); client must apply ephemeral default.
			_, _ = w.Write([]byte(`{
				"sessionToken": "registered-session",
				"dispatchChannel": {
					"wsUrl": "wss://api.test/v1/workers/worker-ci/dispatch-ws",
					"longPollUrl": "https://api.test/v1/workers/worker-ci/dispatch?wait=25s"
				},
				"heartbeatIntervalSec": 0,
				"leaseSec": 0,
				"protocol_version": "1.0.0"
			}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	restoreDeps := stubWorkerLoginDependencies(t, server.Client(), store)
	defer restoreDeps()
	restoreConsumer := stubWorkerDispatchConsumer(func(_ context.Context, reg worker.Registration, _ worker.DispatchHandler, _ worker.LeaseRevokedHandler) error {
		capturedRegistration = reg
		return nil
	})
	defer restoreConsumer()
	restoreLookup := stubWorkerLookupPath(func(name string) (string, error) {
		if name == "codex" {
			return "/usr/bin/codex", nil
		}
		return "", errors.New("not found")
	})
	defer restoreLookup()

	cmd := newRootCmd()
	buf := new(bytes.Buffer)
	cmd.SetOut(buf)
	cmd.SetErr(buf)
	cmd.SetArgs([]string{"worker", "--team", "ci-team", "--api-url", server.URL, "--ephemeral"})

	require.NoError(t, cmd.Execute())
	assert.Equal(t, workerv1.LeaseSec(30), capturedRegistration.LeaseSec,
		"client must apply ephemeral default leaseSec when cloud returns 0")
	assert.True(t, capturedRegistration.Ephemeral, "registration must carry Ephemeral=true")
}

func TestWorkerCommandNonEphemeralDoesNotSendHint(t *testing.T) {
	resetWorkerFlagState()
	defer resetWorkerFlagState()

	store := &fakeWorkerEnrollmentStore{byTeam: map[string]worker.Enrollment{
		"team-x": {TeamID: "team-x", WorkerID: "worker-x", RefreshToken: "refresh-x"},
	}}
	var registerBody map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/workers/refresh":
			_, _ = w.Write([]byte(`{"sessionToken":"session-x","protocol_version":"1.0.0"}`))
		case "/v1/workers/register":
			require.NoError(t, json.NewDecoder(r.Body).Decode(&registerBody))
			_, _ = w.Write([]byte(`{
				"sessionToken": "registered-session",
				"dispatchChannel": {
					"wsUrl": "wss://api.test/v1/workers/worker-x/dispatch-ws",
					"longPollUrl": "https://api.test/v1/workers/worker-x/dispatch?wait=25s"
				},
				"heartbeatIntervalSec": 20,
				"leaseSec": 60,
				"protocol_version": "1.0.0"
			}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	restoreDeps := stubWorkerLoginDependencies(t, server.Client(), store)
	defer restoreDeps()
	restoreConsumer := stubWorkerDispatchConsumer(func(context.Context, worker.Registration, worker.DispatchHandler, worker.LeaseRevokedHandler) error {
		return nil
	})
	defer restoreConsumer()
	restoreLookup := stubWorkerLookupPath(func(name string) (string, error) {
		if name == "codex" {
			return "/usr/bin/codex", nil
		}
		return "", errors.New("not found")
	})
	defer restoreLookup()

	cmd := newRootCmd()
	buf := new(bytes.Buffer)
	cmd.SetOut(buf)
	cmd.SetErr(buf)
	cmd.SetArgs([]string{"worker", "--team", "team-x", "--api-url", server.URL})

	require.NoError(t, cmd.Execute())
	_, hasEphemeral := registerBody["ephemeral"]
	assert.False(t, hasEphemeral, "ephemeral field must be absent when --ephemeral is not set (omitempty)")
}
