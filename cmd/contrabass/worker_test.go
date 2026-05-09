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
	"time"

	"github.com/coder/websocket"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	workerv1 "github.com/junhoyeo/contrabass/internal/workerproto/v1"
)

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
			store: &fakeWorkerEnrollmentStore{byTeam: map[string]workerEnrollment{
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

	store := &fakeWorkerEnrollmentStore{byTeam: map[string]workerEnrollment{
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
	restoreConsumer := stubWorkerDispatchConsumer(func(context.Context, workerRegistration, workerDispatchHandler, workerLeaseRevokedHandler) error {
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

func TestConsumeWorkerDispatchesReadsWebSocketDispatch(t *testing.T) {
	dispatchJSON := `{
		"type": "dispatch",
		"runId": "run-1",
		"issueRef": "LIN-123",
		"branch": "contrabass/run-1",
		"prompt": "fix it",
		"configHash": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		"leaseSec": 60,
		"artifactUploadURLs": {
			"logs": "https://r2.test/logs",
			"diff": "https://r2.test/diff",
			"summary": "https://r2.test/summary"
		},
		"protocol_version": "1.0.0"
	}`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "Bearer session-token", r.Header.Get("Authorization"))
		conn, err := websocket.Accept(w, r, nil)
		require.NoError(t, err)
		defer conn.CloseNow()
		require.NoError(t, conn.Write(r.Context(), websocket.MessageText, []byte(dispatchJSON)))
	}))
	defer server.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var got workerv1.WorkerDispatchFrame
	err := consumeWorkerDispatches(ctx, workerRegistration{
		SessionToken: "session-token",
		DispatchChannel: workerv1.WorkerRegisterResponseDispatchChannel{
			WsURL: workerv1.WsURL(strings.Replace(server.URL, "http://", "ws://", 1)),
		},
	}, func(_ context.Context, frame workerv1.WorkerDispatchFrame) error {
		got = frame
		cancel()
		return nil
	}, nil)

	require.ErrorIs(t, err, context.Canceled)
	assert.Equal(t, workerv1.RunID("run-1"), got.RunID)
	assert.Equal(t, workerv1.IssueRef("LIN-123"), got.IssueRef)
	assert.Equal(t, workerv1.ProtocolVersionCurrent, got.ProtocolVersion)
}

func TestConsumeWorkerDispatchesFallsBackToLongPollAfterThreeWSFailures(t *testing.T) {
	oldReconnectDelay := workerWSReconnectDelay
	oldFallbackRetryDelay := workerWSFallbackRetryDelay
	workerWSReconnectDelay = 0
	workerWSFallbackRetryDelay = time.Hour
	defer func() {
		workerWSReconnectDelay = oldReconnectDelay
		workerWSFallbackRetryDelay = oldFallbackRetryDelay
	}()

	dispatchJSON := `{
		"type": "dispatch",
		"runId": "run-long-poll",
		"issueRef": "LIN-456",
		"branch": "contrabass/run-long-poll",
		"prompt": "fix via long poll",
		"configHash": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		"leaseSec": 60,
		"artifactUploadURLs": {
			"logs": "https://r2.test/logs",
			"diff": "https://r2.test/diff",
			"summary": "https://r2.test/summary"
		},
		"protocol_version": "1.0.0"
	}`
	wsAttempts := 0
	longPollAttempts := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/dispatch-ws":
			wsAttempts++
			http.Error(w, "websocket blocked", http.StatusUpgradeRequired)
		case "/dispatch":
			longPollAttempts++
			assert.Equal(t, "25s", r.URL.Query().Get("wait"))
			assert.Equal(t, "Bearer session-token", r.Header.Get("Authorization"))
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(dispatchJSON))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	restoreDeps := stubWorkerLoginDependencies(t, server.Client(), &fakeWorkerEnrollmentStore{})
	defer restoreDeps()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var got workerv1.WorkerDispatchFrame
	err := consumeWorkerDispatches(ctx, workerRegistration{
		SessionToken: "session-token",
		DispatchChannel: workerv1.WorkerRegisterResponseDispatchChannel{
			WsURL:       workerv1.WsURL(strings.Replace(server.URL, "http://", "ws://", 1) + "/dispatch-ws"),
			LongPollURL: workerv1.URL(server.URL + "/dispatch?wait=25s"),
		},
	}, func(_ context.Context, frame workerv1.WorkerDispatchFrame) error {
		got = frame
		cancel()
		return nil
	}, nil)

	require.ErrorIs(t, err, context.Canceled)
	assert.Equal(t, 3, wsAttempts)
	assert.Equal(t, 1, longPollAttempts)
	assert.Equal(t, workerv1.RunID("run-long-poll"), got.RunID)
}

func TestConsumeWorkerDispatchesRetriesWebSocketWhileInLongPollFallback(t *testing.T) {
	oldReconnectDelay := workerWSReconnectDelay
	oldFallbackRetryDelay := workerWSFallbackRetryDelay
	workerWSReconnectDelay = 0
	workerWSFallbackRetryDelay = time.Millisecond
	defer func() {
		workerWSReconnectDelay = oldReconnectDelay
		workerWSFallbackRetryDelay = oldFallbackRetryDelay
	}()

	dispatchJSON := `{
		"type": "dispatch",
		"runId": "run-ws-recovered",
		"issueRef": "LIN-789",
		"branch": "contrabass/run-ws-recovered",
		"prompt": "fix after recovery",
		"configHash": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		"leaseSec": 60,
		"artifactUploadURLs": {
			"logs": "https://r2.test/logs",
			"diff": "https://r2.test/diff",
			"summary": "https://r2.test/summary"
		},
		"protocol_version": "1.0.0"
	}`
	wsAttempts := 0
	longPollAttempts := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/dispatch-ws":
			wsAttempts++
			if wsAttempts <= 3 {
				http.Error(w, "websocket blocked", http.StatusUpgradeRequired)
				return
			}
			conn, err := websocket.Accept(w, r, nil)
			require.NoError(t, err)
			defer conn.CloseNow()
			require.NoError(t, conn.Write(r.Context(), websocket.MessageText, []byte(dispatchJSON)))
		case "/dispatch":
			longPollAttempts++
			w.WriteHeader(http.StatusNoContent)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	restoreDeps := stubWorkerLoginDependencies(t, server.Client(), &fakeWorkerEnrollmentStore{})
	defer restoreDeps()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	var got workerv1.WorkerDispatchFrame
	err := consumeWorkerDispatches(ctx, workerRegistration{
		SessionToken: "session-token",
		DispatchChannel: workerv1.WorkerRegisterResponseDispatchChannel{
			WsURL:       workerv1.WsURL(strings.Replace(server.URL, "http://", "ws://", 1) + "/dispatch-ws"),
			LongPollURL: workerv1.URL(server.URL + "/dispatch?wait=25s"),
		},
	}, func(_ context.Context, frame workerv1.WorkerDispatchFrame) error {
		got = frame
		cancel()
		return nil
	}, nil)

	require.ErrorIs(t, err, context.Canceled)
	assert.GreaterOrEqual(t, wsAttempts, 4)
	assert.GreaterOrEqual(t, longPollAttempts, 1)
	assert.Equal(t, workerv1.RunID("run-ws-recovered"), got.RunID)
}

func TestWorkerAckingDispatchHandlerPostsAcceptBeforeStartingRun(t *testing.T) {
	ackBody := make(chan map[string]any, 1)
	started := make(chan struct{}, 1)
	releaseStart := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, http.MethodPost, r.Method)
		assert.Equal(t, "/v1/runs/run-1/ack", r.URL.Path)
		assert.Equal(t, "Bearer session-token", r.Header.Get("Authorization"))

		var body map[string]any
		require.NoError(t, json.NewDecoder(r.Body).Decode(&body))
		ackBody <- body
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	restoreDeps := stubWorkerLoginDependencies(t, server.Client(), &fakeWorkerEnrollmentStore{})
	defer restoreDeps()

	handler := newWorkerAckingDispatchHandler(workerRegistration{
		APIBaseURL:   server.URL,
		SessionToken: "session-token",
	}, 1, func(ctx context.Context, _ workerv1.WorkerDispatchFrame) error {
		started <- struct{}{}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-releaseStart:
			return nil
		}
	})

	err := handler.Handle(context.Background(), workerv1.WorkerDispatchFrame{RunID: "run-1"})
	require.NoError(t, err)

	select {
	case got := <-ackBody:
		assert.Equal(t, true, got["accept"])
		assert.Equal(t, "1.0.0", got["protocol_version"])
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for ack")
	}
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for run start")
	}

	handler.mu.Lock()
	_, inFlight := handler.inFlight["run-1"]
	handler.mu.Unlock()
	require.True(t, inFlight, "run should remain in flight until startRun exits")

	close(releaseStart)
	require.Eventually(t, func() bool {
		handler.mu.Lock()
		defer handler.mu.Unlock()
		_, inFlight := handler.inFlight["run-1"]
		return !inFlight
	}, time.Second, 10*time.Millisecond)
}

func TestWorkerAckingDispatchHandlerRejectsAtCapacity(t *testing.T) {
	var gotBody map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "/v1/runs/run-2/ack", r.URL.Path)
		require.NoError(t, json.NewDecoder(r.Body).Decode(&gotBody))
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	restoreDeps := stubWorkerLoginDependencies(t, server.Client(), &fakeWorkerEnrollmentStore{})
	defer restoreDeps()

	handler := newWorkerAckingDispatchHandler(workerRegistration{
		APIBaseURL:   server.URL,
		SessionToken: "session-token",
	}, 1, func(context.Context, workerv1.WorkerDispatchFrame) error {
		t.Fatal("startRun should not be called for at-capacity dispatch")
		return nil
	})
	handler.inFlight["run-1"] = func(error) {}

	err := handler.Handle(context.Background(), workerv1.WorkerDispatchFrame{RunID: "run-2"})
	require.NoError(t, err)
	assert.Equal(t, false, gotBody["accept"])
	assert.Equal(t, "at_capacity", gotBody["reason"])
	assert.Equal(t, "1.0.0", gotBody["protocol_version"])
}

func TestWorkerAckingDispatchHandlerRejectsSecondDispatchWhileFirstRunBlocked(t *testing.T) {
	ackBodies := make(chan map[string]any, 2)
	started := make(chan struct{}, 1)
	releaseStart := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		require.NoError(t, json.NewDecoder(r.Body).Decode(&body))
		body["path"] = r.URL.Path
		ackBodies <- body
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	restoreDeps := stubWorkerLoginDependencies(t, server.Client(), &fakeWorkerEnrollmentStore{})
	defer restoreDeps()

	handler := newWorkerAckingDispatchHandler(workerRegistration{
		APIBaseURL:   server.URL,
		SessionToken: "session-token",
	}, 1, func(ctx context.Context, _ workerv1.WorkerDispatchFrame) error {
		started <- struct{}{}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-releaseStart:
			return nil
		}
	})

	err := handler.Handle(context.Background(), workerv1.WorkerDispatchFrame{RunID: "run-1"})
	require.NoError(t, err)
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for first run start")
	}

	err = handler.Handle(context.Background(), workerv1.WorkerDispatchFrame{RunID: "run-2"})
	require.NoError(t, err)

	var firstAck, secondAck map[string]any
	for range 2 {
		select {
		case got := <-ackBodies:
			switch got["path"] {
			case "/v1/runs/run-1/ack":
				firstAck = got
			case "/v1/runs/run-2/ack":
				secondAck = got
			default:
				t.Fatalf("unexpected ack path %v", got["path"])
			}
		case <-time.After(time.Second):
			t.Fatal("timed out waiting for ack")
		}
	}

	require.NotNil(t, firstAck)
	require.NotNil(t, secondAck)
	assert.Equal(t, true, firstAck["accept"])
	assert.Equal(t, false, secondAck["accept"])
	assert.Equal(t, "at_capacity", secondAck["reason"])
	assert.Equal(t, "1.0.0", secondAck["protocol_version"])

	close(releaseStart)
	require.Eventually(t, func() bool {
		handler.mu.Lock()
		defer handler.mu.Unlock()
		return len(handler.inFlight) == 0
	}, time.Second, 10*time.Millisecond)
}

func TestPostWorkerDispatchAckReportsHTTPError(t *testing.T) {
	tests := []struct {
		name       string
		statusCode int
		body       string
		wantErr    string
	}{
		{
			name:       "structured response body",
			statusCode: http.StatusConflict,
			body:       `{"error":"lease_revoked","protocol_version":"1.0.0"}`,
			wantErr:    "lease_revoked",
		},
		{
			name:       "empty response body",
			statusCode: http.StatusInternalServerError,
			wantErr:    "HTTP 500",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tt.statusCode)
				_, _ = w.Write([]byte(tt.body))
			}))
			defer server.Close()
			restoreDeps := stubWorkerLoginDependencies(t, server.Client(), &fakeWorkerEnrollmentStore{})
			defer restoreDeps()

			err := postWorkerDispatchAck(context.Background(), workerRegistration{
				APIBaseURL:   server.URL,
				SessionToken: "session-token",
			}, "run-1", workerv1.Accept{
				Accept:          true,
				ProtocolVersion: workerv1.ProtocolVersionCurrent,
			})
			require.Error(t, err)
			assert.Contains(t, err.Error(), tt.wantErr)
		})
	}
}

func TestDecodeWorkerDispatchFrameRejectsUnsupportedType(t *testing.T) {
	_, err := decodeWorkerDispatchFrame([]byte(`{"type":"lease-revoked","runId":"run-1","protocol_version":"1.0.0"}`))
	require.ErrorIs(t, err, errWorkerDispatchUnsupported)
}

func TestDetectWorkerCapabilities(t *testing.T) {
	tests := []struct {
		name    string
		found   map[string]bool
		want    []string
		wantErr string
	}{
		{
			name:  "detects runners and host capabilities",
			found: map[string]bool{"codex": true, "opencode": true, "git": true},
			want:  []string{"agent:codex", "agent:opencode", "git"},
		},
		{
			name:    "refuses to run without an agent runner",
			found:   map[string]bool{"git": true, "tmux": true},
			wantErr: "missing runners: codex, opencode, omx, omc, mock",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			restore := stubWorkerLookupPath(func(name string) (string, error) {
				if tt.found[name] {
					return "/usr/bin/" + name, nil
				}
				return "", errors.New("not found")
			})
			defer restore()

			got, err := detectWorkerCapabilities()
			if tt.wantErr != "" {
				require.Error(t, err)
				assert.Contains(t, err.Error(), tt.wantErr)
				return
			}

			require.NoError(t, err)
			gotStrings := make([]string, 0, len(got))
			for _, capability := range got {
				gotStrings = append(gotStrings, string(capability))
			}
			for _, want := range tt.want {
				assert.Contains(t, gotStrings, want)
			}
			assert.Contains(t, gotStrings, "os:"+runtime.GOOS)
		})
	}
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
	assert.Equal(t, workerEnrollment{
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

	store := &fakeWorkerEnrollmentStore{byTeam: map[string]workerEnrollment{
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
	restoreConsumer := stubWorkerDispatchConsumer(func(context.Context, workerRegistration, workerDispatchHandler, workerLeaseRevokedHandler) error {
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

	store := &fakeWorkerEnrollmentStore{byTeam: map[string]workerEnrollment{
		"ci-team": {TeamID: "ci-team", WorkerID: "worker-ci", RefreshToken: "refresh-ci"},
	}}
	var capturedRegistration workerRegistration
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
	restoreConsumer := stubWorkerDispatchConsumer(func(_ context.Context, reg workerRegistration, _ workerDispatchHandler, _ workerLeaseRevokedHandler) error {
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
	assert.Equal(t, workerEphemeralDefaultLeaseSec, capturedRegistration.LeaseSec,
		"client must apply ephemeral default leaseSec when cloud returns 0")
	assert.True(t, capturedRegistration.Ephemeral, "registration must carry Ephemeral=true")
}

func TestWorkerCommandNonEphemeralDoesNotSendHint(t *testing.T) {
	resetWorkerFlagState()
	defer resetWorkerFlagState()

	store := &fakeWorkerEnrollmentStore{byTeam: map[string]workerEnrollment{
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
	restoreConsumer := stubWorkerDispatchConsumer(func(context.Context, workerRegistration, workerDispatchHandler, workerLeaseRevokedHandler) error {
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

type fakeWorkerEnrollmentStore struct {
	enrollments []workerEnrollment
	byTeam      map[string]workerEnrollment
}

func (s *fakeWorkerEnrollmentStore) StoreWorkerEnrollment(_ context.Context, enrollment workerEnrollment) error {
	s.enrollments = append(s.enrollments, enrollment)
	if s.byTeam == nil {
		s.byTeam = make(map[string]workerEnrollment)
	}
	s.byTeam[enrollment.TeamID] = enrollment
	return nil
}

func (s *fakeWorkerEnrollmentStore) LoadWorkerEnrollment(_ context.Context, teamID string) (workerEnrollment, error) {
	enrollment, ok := s.byTeam[teamID]
	if !ok {
		return workerEnrollment{}, errWorkerEnrollmentNotFound
	}
	return enrollment, nil
}

func stubWorkerLoginDependencies(t *testing.T, client *http.Client, store workerEnrollmentStore) func() {
	t.Helper()

	oldClient := workerLoginHTTPClient
	oldStore := newWorkerLoginStore
	workerLoginHTTPClient = client
	newWorkerLoginStore = func() (workerEnrollmentStore, error) {
		return store, nil
	}

	return func() {
		workerLoginHTTPClient = oldClient
		newWorkerLoginStore = oldStore
	}
}

func stubWorkerLookupPath(lookup func(string) (string, error)) func() {
	oldLookup := workerLookupPath
	workerLookupPath = lookup
	return func() {
		workerLookupPath = oldLookup
	}
}

func stubWorkerDispatchConsumer(consumer func(context.Context, workerRegistration, workerDispatchHandler, workerLeaseRevokedHandler) error) func() {
	oldConsumer := workerDispatchConsumer
	workerDispatchConsumer = consumer
	return func() {
		workerDispatchConsumer = oldConsumer
	}
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

func resetWorkerLoginFlagState() {
	for _, name := range []string{"code", "api-url", "worker-id"} {
		flag := workerLoginCmd.Flags().Lookup(name)
		if flag == nil {
			continue
		}
		_ = flag.Value.Set(flag.DefValue)
		flag.Changed = false
	}
}
