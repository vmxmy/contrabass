package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	workerv1 "github.com/junhoyeo/contrabass/internal/workerproto/v1"
)

func TestWorkerRegistrationCurrentTokenFallsBackToStaticField(t *testing.T) {
	reg := workerRegistration{SessionToken: "static-token"}
	assert.Equal(t, "static-token", reg.currentToken())
}

func TestWorkerRegistrationCurrentTokenUsesSessionManager(t *testing.T) {
	reg := workerRegistration{SessionToken: "static-token"}
	mgr := &workerSessionManager{sessionToken: "managed-token"}
	reg.Session = mgr
	assert.Equal(t, "managed-token", reg.currentToken())
}

func TestWorkerSessionManagerCurrentTokenReturnsInitialToken(t *testing.T) {
	reg := workerRegistration{
		SessionToken: "initial-token",
		RefreshToken: "refresh-token",
		APIBaseURL:   "https://api.test",
	}
	mgr := newWorkerSessionManager(reg)
	assert.Equal(t, "initial-token", mgr.CurrentToken())
}

func TestWorkerSessionManagerRefreshUpdatesToken(t *testing.T) {
	var refreshCalls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, http.MethodPost, r.Method)
		assert.Equal(t, "/v1/workers/refresh", r.URL.Path)
		refreshCalls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"sessionToken":"refreshed-token","protocol_version":"1.0.0"}`))
	}))
	defer server.Close()

	restore := stubWorkerLoginDependencies(t, server.Client(), &fakeWorkerEnrollmentStore{})
	defer restore()

	reg := workerRegistration{
		SessionToken: "old-token",
		RefreshToken: "refresh-token",
		APIBaseURL:   server.URL,
	}
	mgr := newWorkerSessionManager(reg)

	require.NoError(t, mgr.Refresh(context.Background()))
	assert.Equal(t, "refreshed-token", mgr.CurrentToken())
	assert.Equal(t, int32(1), refreshCalls.Load())
}

func TestWorkerSessionManagerRefreshPropagatesError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":"refresh_revoked","protocol_version":"1.0.0"}`))
	}))
	defer server.Close()

	restore := stubWorkerLoginDependencies(t, server.Client(), &fakeWorkerEnrollmentStore{})
	defer restore()

	reg := workerRegistration{
		SessionToken: "initial-token",
		RefreshToken: "revoked-refresh",
		APIBaseURL:   server.URL,
	}
	mgr := newWorkerSessionManager(reg)

	err := mgr.Refresh(context.Background())
	require.Error(t, err)
	assert.Contains(t, err.Error(), "refresh_revoked")
	// Token must not change after a failed refresh.
	assert.Equal(t, "initial-token", mgr.CurrentToken())
}

func TestWorkerSessionManagerRunProactiveRefreshRotatesToken(t *testing.T) {
	var refreshCalls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		refreshCalls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"sessionToken":"rotated-token","protocol_version":"1.0.0"}`))
	}))
	defer server.Close()

	restore := stubWorkerLoginDependencies(t, server.Client(), &fakeWorkerEnrollmentStore{})
	defer restore()

	reg := workerRegistration{
		SessionToken: "initial-token",
		RefreshToken: "refresh-token",
		APIBaseURL:   server.URL,
	}
	mgr := newWorkerSessionManager(reg)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		mgr.RunProactiveRefresh(ctx, 5*time.Millisecond)
	}()

	require.Eventually(t, func() bool {
		return refreshCalls.Load() >= 2
	}, time.Second, time.Millisecond)
	assert.Equal(t, "rotated-token", mgr.CurrentToken())

	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("RunProactiveRefresh did not exit after context cancellation")
	}
}

func TestWorkerSessionManagerRunProactiveRefreshExitsOnContextCancel(t *testing.T) {
	reg := workerRegistration{
		SessionToken: "initial-token",
		RefreshToken: "refresh-token",
		APIBaseURL:   "https://api.test",
	}
	mgr := newWorkerSessionManager(reg)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		mgr.RunProactiveRefresh(ctx, time.Hour)
	}()

	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("RunProactiveRefresh did not exit after context cancellation")
	}
}

func TestWorkerSessionManagerConcurrentAccess(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"sessionToken":"concurrent-token","protocol_version":"1.0.0"}`))
	}))
	defer server.Close()

	restore := stubWorkerLoginDependencies(t, server.Client(), &fakeWorkerEnrollmentStore{})
	defer restore()

	reg := workerRegistration{
		SessionToken: "initial-token",
		RefreshToken: "refresh-token",
		APIBaseURL:   server.URL,
	}
	mgr := newWorkerSessionManager(reg)

	// Concurrent readers and a refresher must not race (run with -race).
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	for range 5 {
		go func() {
			for {
				select {
				case <-ctx.Done():
					return
				default:
					_ = mgr.CurrentToken()
				}
			}
		}()
	}
	for {
		select {
		case <-ctx.Done():
			return
		default:
			_ = mgr.Refresh(context.Background())
		}
	}
}

func TestWorkerCommandSessionManagerIsWiredAfterRegistration(t *testing.T) {
	defer resetWorkerFlagState()

	store := &fakeWorkerEnrollmentStore{byTeam: map[string]workerEnrollment{
		"team-soak": {TeamID: "team-soak", WorkerID: "worker-soak", RefreshToken: "soak-refresh"},
	}}

	var capturedRegistration workerRegistration
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/workers/refresh":
			_, _ = w.Write([]byte(`{"sessionToken":"soak-session","protocol_version":"1.0.0"}`))
		case "/v1/workers/register":
			_, _ = w.Write([]byte(`{
				"sessionToken": "soak-session",
				"dispatchChannel": {
					"wsUrl": "wss://api.test/dispatch-ws",
					"longPollUrl": "https://api.test/dispatch?wait=25s"
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

	cmd := newRootCmd()
	cmd.SetArgs([]string{"worker", "--team", "team-soak", "--api-url", server.URL})
	require.NoError(t, cmd.Execute())

	require.NotNil(t, capturedRegistration.Session,
		"Session manager must be set on the registration passed to the dispatch consumer")
	assert.Equal(t, "soak-session", capturedRegistration.Session.CurrentToken(),
		"Session manager must carry the initial session token")
	assert.Equal(t, workerv1.ProtocolVersionCurrent, capturedRegistration.ProtocolVersion)
}
