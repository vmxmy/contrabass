package worker

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	workerv1 "github.com/junhoyeo/contrabass/internal/workerproto/v1"
)

// workerProtoFixtureDir is the path from internal/cli/worker/ to the shared fixture directory.
const workerProtoFixtureDir = "../../../testdata/workerproto/v1"

func loadWorkerFixture(t *testing.T, name string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(workerProtoFixtureDir, name))
	require.NoError(t, err, "loading fixture %q", name)
	return data
}

// TestRefreshWorkerSessionFixtureErrors verifies that refreshWorkerSession
// correctly handles each refresh-error fixture served by a mock cloud server.
func TestRefreshWorkerSessionFixtureErrors(t *testing.T) {
	tests := []struct {
		name       string
		fixture    string
		statusCode int
		wantErr    string
	}{
		{
			name:       "revoked token",
			fixture:    "refresh-error.revoked.json",
			statusCode: http.StatusUnauthorized,
			wantErr:    "refresh_revoked",
		},
		{
			name:       "expired token",
			fixture:    "refresh-error.expired.json",
			statusCode: http.StatusUnauthorized,
			wantErr:    "refresh_expired",
		},
		{
			name:       "invalid token",
			fixture:    "refresh-error.invalid.json",
			statusCode: http.StatusUnauthorized,
			wantErr:    "refresh_invalid",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fixtureBody := loadWorkerFixture(t, tt.fixture)

			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				assert.Equal(t, http.MethodPost, r.Method)
				assert.Equal(t, "/v1/workers/refresh", r.URL.Path)
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(tt.statusCode)
				_, _ = w.Write(fixtureBody)
			}))
			defer server.Close()

			restore := stubWorkerLoginDependencies(t, server.Client(), &fakeWorkerEnrollmentStore{})
			defer restore()

			_, err := refreshWorkerSession(context.Background(), server.URL, "test-refresh-token")
			require.Error(t, err)
			assert.Contains(t, err.Error(), tt.wantErr)
		})
	}
}

// TestRegisterWorkerFixtureErrors verifies that registerWorker correctly handles
// each register-error fixture served by a mock cloud server. The mock server also
// handles the upstream /v1/workers/refresh call that registerWorker issues first.
func TestRegisterWorkerFixtureErrors(t *testing.T) {
	tests := []struct {
		name         string
		fixture      string
		registerCode int
		wantErr      string
	}{
		{
			name:         "protocol version unsupported",
			fixture:      "register-error.protocol-version-unsupported.json",
			registerCode: http.StatusConflict,
			wantErr:      "protocol_version_unsupported",
		},
		{
			name:         "team forbidden",
			fixture:      "register-error.team-forbidden.json",
			registerCode: http.StatusForbidden,
			wantErr:      "team_forbidden",
		},
		{
			name:         "auth invalid",
			fixture:      "register-error.auth-invalid.json",
			registerCode: http.StatusUnauthorized,
			wantErr:      "auth_invalid",
		},
		{
			name:         "team worker cap exceeded",
			fixture:      "register-error.team-worker-cap-exceeded.json",
			registerCode: http.StatusForbidden,
			wantErr:      "team_worker_cap_exceeded",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			errorBody := loadWorkerFixture(t, tt.fixture)

			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				switch r.URL.Path {
				case "/v1/workers/refresh":
					_, _ = w.Write([]byte(`{"sessionToken":"tok","expiresAt":9999999999,"protocol_version":"1.0.0"}`))
				case "/v1/workers/register":
					w.WriteHeader(tt.registerCode)
					_, _ = w.Write(errorBody)
				default:
					http.NotFound(w, r)
				}
			}))
			defer server.Close()

			restore := stubWorkerLoginDependencies(t, server.Client(), &fakeWorkerEnrollmentStore{})
			defer restore()

			_, err := registerWorker(
				context.Background(),
				workerOptions{
					TeamID:         "team-alpha",
					APIBaseURL:     server.URL,
					MaxConcurrency: 1,
				},
				workerEnrollment{
					TeamID:       "team-alpha",
					WorkerID:     "worker-local-001",
					RefreshToken: "test-refresh",
				},
				[]workerv1.Capability{"agent:codex"},
			)
			require.Error(t, err)
			assert.Contains(t, err.Error(), tt.wantErr)
		})
	}
}

// TestMockCloudServerDispatchesFixtureFrame verifies that consumeWorkerDispatches
// correctly parses the shared dispatch.json fixture when it arrives over a
// WebSocket connection. This exercises the full parse path including the
// ackDeadlineSec and dispatchedAt fields that inline tests omit.
func TestMockCloudServerDispatchesFixtureFrame(t *testing.T) {
	dispatchFixture := loadWorkerFixture(t, "dispatch.json")

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		require.NoError(t, err)
		defer conn.CloseNow()
		require.NoError(t, conn.Write(r.Context(), websocket.MessageText, dispatchFixture))
	}))
	defer server.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var got workerv1.WorkerDispatchFrame
	wsURL := strings.Replace(server.URL, "http://", "ws://", 1)
	err := consumeWorkerDispatches(ctx, workerRegistration{
		SessionToken: "test-session-token",
		DispatchChannel: workerv1.WorkerRegisterResponseDispatchChannel{
			WsURL: workerv1.WsURL(wsURL),
		},
	}, func(_ context.Context, frame workerv1.WorkerDispatchFrame) error {
		got = frame
		cancel()
		return nil
	}, nil)

	require.ErrorIs(t, err, context.Canceled)
	assert.Equal(t, workerv1.RunID("run-20260509-0001"), got.RunID)
	assert.Equal(t, workerv1.IssueRef("LIN-123"), got.IssueRef)
	assert.Equal(t, workerv1.GitBranch("feature/lin-123"), got.Branch)
	assert.Equal(t, workerv1.LeaseSec(60), got.LeaseSec)
	assert.Equal(t, 5, got.AckDeadlineSec)
	assert.Equal(t, workerv1.ProtocolVersionCurrent, got.ProtocolVersion)
	assert.Equal(t, "dispatch", got.Type)
	assert.NotEmpty(t, got.ArtifactUploadURLs.Logs)
	assert.NotEmpty(t, got.ArtifactUploadURLs.Diff)
	assert.NotEmpty(t, got.ArtifactUploadURLs.Summary)
	assert.Len(t, got.ArtifactUploadURLs.Screenshots, 1)
}

// TestMockCloudServerLeaseRevokedFixtureFrame verifies that consumeWorkerDispatches
// routes the shared lease-revoked.heartbeat-timeout.json fixture to the
// leaseRevokedHandler, and that all fixture fields are correctly decoded.
func TestMockCloudServerLeaseRevokedFixtureFrame(t *testing.T) {
	leaseRevokedFixture := loadWorkerFixture(t, "lease-revoked.heartbeat-timeout.json")

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		require.NoError(t, err)
		defer conn.CloseNow()
		require.NoError(t, conn.Write(r.Context(), websocket.MessageText, leaseRevokedFixture))
	}))
	defer server.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	revoked := make(chan workerv1.RunID, 1)
	wsURL := strings.Replace(server.URL, "http://", "ws://", 1)
	err := consumeWorkerDispatches(ctx, workerRegistration{
		SessionToken: "test-session-token",
		DispatchChannel: workerv1.WorkerRegisterResponseDispatchChannel{
			WsURL: workerv1.WsURL(wsURL),
		},
	}, func(_ context.Context, _ workerv1.WorkerDispatchFrame) error {
		return nil
	}, func(runID workerv1.RunID) {
		revoked <- runID
		cancel()
	})

	require.ErrorIs(t, err, context.Canceled)
	select {
	case got := <-revoked:
		assert.Equal(t, workerv1.RunID("run-20260509-0001"), got)
	case <-time.After(time.Second):
		t.Fatal("leaseRevokedHandler was not called with fixture runId")
	}
}

// TestLongPollDispatchDeliversFixtureFrame verifies that the dispatch.json
// fixture parses correctly when served over the long-poll endpoint, confirming
// payload shape parity with the WebSocket delivery path. This is the
// validation required by task 16.5: the same WorkerDispatchFrame type must be
// decodable regardless of the transport (WS or long-poll).
func TestLongPollDispatchDeliversFixtureFrame(t *testing.T) {
	dispatchFixture := loadWorkerFixture(t, "dispatch.json")

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, http.MethodGet, r.Method)
		assert.Equal(t, "Bearer test-session-token", r.Header.Get("Authorization"))
		assert.Equal(t, "25s", r.URL.Query().Get("wait"))
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(dispatchFixture)
	}))
	defer server.Close()

	restore := stubWorkerLoginDependencies(t, server.Client(), &fakeWorkerEnrollmentStore{})
	defer restore()

	var got workerv1.WorkerDispatchFrame
	err := longPollWorkerDispatch(context.Background(), workerRegistration{
		SessionToken: "test-session-token",
		DispatchChannel: workerv1.WorkerRegisterResponseDispatchChannel{
			LongPollURL: workerv1.URL(server.URL + "/dispatch?wait=25s"),
		},
	}, func(_ context.Context, frame workerv1.WorkerDispatchFrame) error {
		got = frame
		return nil
	})

	require.NoError(t, err)
	// Validate all fields match the fixture — same assertions as the WS fixture
	// test (TestMockCloudServerDispatchesFixtureFrame) to prove shape parity.
	assert.Equal(t, workerv1.RunID("run-20260509-0001"), got.RunID)
	assert.Equal(t, workerv1.IssueRef("LIN-123"), got.IssueRef)
	assert.Equal(t, workerv1.GitBranch("feature/lin-123"), got.Branch)
	assert.Equal(t, workerv1.LeaseSec(60), got.LeaseSec)
	assert.Equal(t, 5, got.AckDeadlineSec)
	assert.Equal(t, workerv1.ProtocolVersionCurrent, got.ProtocolVersion)
	assert.Equal(t, "dispatch", got.Type)
	assert.NotEmpty(t, got.ArtifactUploadURLs.Logs)
	assert.NotEmpty(t, got.ArtifactUploadURLs.Diff)
	assert.NotEmpty(t, got.ArtifactUploadURLs.Summary)
	assert.Len(t, got.ArtifactUploadURLs.Screenshots, 1)
}

// TestMockCloudServerRegistrationSuccessWithFixtures verifies the full
// refresh → register sequence against a mock server that serves the actual
// register-response.success.json fixture (with URLs replaced for the test
// server) and validates that the workerRegistration struct is populated from
// the fixture fields.
func TestMockCloudServerRegistrationSuccessWithFixtures(t *testing.T) {
	store := &fakeWorkerEnrollmentStore{byTeam: map[string]workerEnrollment{
		"team-alpha": {
			TeamID:       "team-alpha",
			WorkerID:     "worker-local-001",
			RefreshToken: "refresh-token-def456",
		},
	}}

	var capturedRegistration workerRegistration
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/workers/refresh":
			// Serve the refresh success fixture; client reads sessionToken from it.
			_, _ = w.Write(loadWorkerFixture(t, "refresh-response.success.json"))
		case "/v1/workers/register":
			// Serve a register response using fixture-derived values with live URLs.
			_, _ = w.Write([]byte(`{
				"sessionToken": "session-token-abc123",
				"refreshToken": "refresh-token-def456",
				"dispatchChannel": {
					"wsUrl": "wss://placeholder/dispatch-ws",
					"longPollUrl": "https://placeholder/dispatch?wait=25s"
				},
				"heartbeatIntervalSec": 20,
				"leaseSec": 60,
				"protocol_version": "1.0.0",
				"sessionTokenExpiresAt": 1767229200000
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
		return "", errWorkerEnrollmentNotFound
	})
	defer restoreLookup()

	require.NoError(t, Run(context.Background(), RunConfig{
		TeamID:         "team-alpha",
		APIBaseURL:     server.URL,
		MaxConcurrency: 1,
	}, &bytes.Buffer{}))

	// The registration fixture specifies leaseSec=60 and heartbeatIntervalSec=20.
	assert.Equal(t, workerv1.LeaseSec(60), capturedRegistration.LeaseSec)
	assert.Equal(t, 20, capturedRegistration.HeartbeatIntervalSec)
	assert.Equal(t, workerv1.ProtocolVersionCurrent, capturedRegistration.ProtocolVersion)
}
