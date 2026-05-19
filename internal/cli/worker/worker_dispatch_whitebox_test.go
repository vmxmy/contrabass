package worker

import (
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

// TestConsumeWorkerDispatchesLongPollReissuesAfter204 validates the spec
// scenario "Long-poll times out with no work": when the cloud returns 204, the
// worker re-issues the long-poll until a dispatch arrives. This simulates WS
// blocked at the proxy (3 failures → fallback) followed by two 204 timeouts
// before the third long-poll delivers the dispatch frame.
func TestConsumeWorkerDispatchesLongPollReissuesAfter204(t *testing.T) {
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
		"runId": "run-204-reissue",
		"issueRef": "LIN-204",
		"branch": "contrabass/run-204-reissue",
		"prompt": "fix after 204 retries",
		"configHash": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		"leaseSec": 60,
		"artifactUploadURLs": {
			"logs": "https://r2.test/logs",
			"diff": "https://r2.test/diff",
			"summary": "https://r2.test/summary"
		},
		"protocol_version": "1.0.0"
	}`

	longPollAttempts := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/dispatch-ws":
			http.Error(w, "websocket blocked by proxy", http.StatusBadGateway)
		case "/dispatch":
			longPollAttempts++
			assert.Equal(t, "25s", r.URL.Query().Get("wait"))
			assert.Equal(t, "Bearer session-token", r.Header.Get("Authorization"))
			if longPollAttempts < 3 {
				w.WriteHeader(http.StatusNoContent)
				return
			}
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
	assert.Equal(t, 3, longPollAttempts, "worker must re-issue long-poll after each 204 until dispatch arrives")
	assert.Equal(t, workerv1.RunID("run-204-reissue"), got.RunID)
}

// TestConsumeWorkerDispatchesFallsBackForVariousProxyBlockCodes validates that
// any HTTP error response to the WS upgrade (400, 403, 502 — common proxy
// block codes) counts as a WS failure, so the worker reaches the threshold and
// switches to long-poll regardless of which non-101 status the proxy returns.
func TestConsumeWorkerDispatchesFallsBackForVariousProxyBlockCodes(t *testing.T) {
	tests := []struct {
		name       string
		statusCode int
	}{
		{name: "400 bad request", statusCode: http.StatusBadRequest},
		{name: "403 forbidden", statusCode: http.StatusForbidden},
		{name: "502 bad gateway", statusCode: http.StatusBadGateway},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
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
				"runId": "run-proxy-block",
				"issueRef": "LIN-999",
				"branch": "contrabass/run-proxy-block",
				"prompt": "fix after proxy block",
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
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/dispatch-ws":
					wsAttempts++
					http.Error(w, "proxy blocked", tt.statusCode)
				case "/dispatch":
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
			assert.Equal(t, workerWSFailureThreshold, wsAttempts,
				"exactly %d WS attempts expected before fallback for HTTP %d", workerWSFailureThreshold, tt.statusCode)
			assert.Equal(t, workerv1.RunID("run-proxy-block"), got.RunID)
		})
	}
}
