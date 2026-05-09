package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/junhoyeo/contrabass/internal/types"
	workerv1 "github.com/junhoyeo/contrabass/internal/workerproto/v1"
)

func TestWorkerHeartbeatBaseIntervalUsesLeaseThird(t *testing.T) {
	tests := []struct {
		name         string
		registration workerRegistration
		frameLease   workerv1.LeaseSec
		want         time.Duration
	}{
		{
			name:       "dispatch lease takes precedence",
			frameLease: 90,
			registration: workerRegistration{
				LeaseSec:             60,
				HeartbeatIntervalSec: 5,
			},
			want: 30 * time.Second,
		},
		{
			name:         "registration lease defaults to one third",
			registration: workerRegistration{LeaseSec: 60, HeartbeatIntervalSec: 15},
			want:         20 * time.Second,
		},
		{
			name:         "registration heartbeat is fallback",
			registration: workerRegistration{HeartbeatIntervalSec: 7},
			want:         7 * time.Second,
		},
		{
			name: "default interval is twenty seconds",
			want: workerHeartbeatDefaultInterval,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.want, workerHeartbeatBaseInterval(tt.registration, tt.frameLease))
		})
	}
}

func TestWorkerHeartbeatNextIntervalAppliesBoundedJitter(t *testing.T) {
	base := 20 * time.Second
	assert.Equal(t, 18*time.Second, workerHeartbeatNextInterval(base, func(time.Duration) time.Duration {
		return -2 * time.Second
	}))
	assert.Equal(t, 22*time.Second, workerHeartbeatNextInterval(base, func(time.Duration) time.Duration {
		return 2 * time.Second
	}))

	for i := 0; i < 100; i++ {
		got := workerHeartbeatNextInterval(base, jitterWorkerHeartbeatInterval)
		assert.GreaterOrEqual(t, got, 18*time.Second)
		assert.LessOrEqual(t, got, 22*time.Second)
	}
}

func TestWorkerHeartbeatSchedulerPostsProgressAndLastEvent(t *testing.T) {
	posted := make(chan workerv1.WorkerHeartbeatRequest, 1)
	scheduler := newWorkerHeartbeatScheduler(workerRegistration{}, func(_ context.Context, runID workerv1.RunID, request workerv1.WorkerHeartbeatRequest) error {
		assert.Equal(t, workerv1.RunID("run-1"), runID)
		posted <- request
		return nil
	})
	scheduler.interval = func(workerRegistration, workerv1.LeaseSec) time.Duration { return 10 * time.Millisecond }
	scheduler.jitter = func(time.Duration) time.Duration { return 0 }
	scheduler.now = func() time.Time { return time.UnixMilli(2000) }
	progress := newWorkerRunProgressTracker(time.UnixMilli(1000))
	progress.Observe(types.AgentEvent{
		Type:      "tool_call",
		Timestamp: time.UnixMilli(1234),
	}, time.UnixMilli(1500))

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- scheduler.Run(ctx, "run-1", 60, progress) }()

	select {
	case got := <-posted:
		require.NotNil(t, got.Progress)
		assert.Equal(t, "tooling", *got.Progress)
		assert.Equal(t, workerv1.EpochMillis(1234), got.LastEventTs)
		assert.Equal(t, workerv1.ProtocolVersionCurrent, got.ProtocolVersion)
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for heartbeat")
	}

	cancel()
	select {
	case err := <-done:
		assert.NoError(t, err)
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for scheduler stop")
	}
}

func TestPostWorkerHeartbeatUsesJSONAndMapsLeaseRevoked(t *testing.T) {
	tests := []struct {
		name       string
		statusCode int
		body       string
		wantErr    error
	}{
		{name: "success", statusCode: http.StatusNoContent},
		{name: "lease revoked", statusCode: http.StatusConflict, body: `{"error":"lease_revoked","protocol_version":"1.0.0"}`, wantErr: errWorkerLeaseRevoked},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var gotBody workerv1.WorkerHeartbeatRequest
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				assert.Equal(t, http.MethodPost, r.Method)
				assert.Equal(t, "/v1/runs/run-1/heartbeat", r.URL.Path)
				assert.Equal(t, "Bearer session-token", r.Header.Get("Authorization"))
				assert.Equal(t, "application/json", r.Header.Get("Content-Type"))
				body, err := io.ReadAll(r.Body)
				require.NoError(t, err)
				require.NoError(t, json.Unmarshal(body, &gotBody))
				w.WriteHeader(tt.statusCode)
				_, _ = w.Write([]byte(tt.body))
			}))
			defer server.Close()
			restoreDeps := stubWorkerLoginDependencies(t, server.Client(), &fakeWorkerEnrollmentStore{})
			defer restoreDeps()

			progress := "running"
			err := postWorkerHeartbeat(context.Background(), workerRegistration{
				APIBaseURL:   server.URL,
				SessionToken: "session-token",
			}, "run-1", workerv1.WorkerHeartbeatRequest{
				Progress:        &progress,
				LastEventTs:     1234,
				ProtocolVersion: workerv1.ProtocolVersionCurrent,
			})
			if tt.wantErr != nil {
				require.Error(t, err)
				assert.True(t, errors.Is(err, tt.wantErr))
			} else {
				require.NoError(t, err)
			}
			assert.Equal(t, workerv1.EpochMillis(1234), gotBody.LastEventTs)
			require.NotNil(t, gotBody.Progress)
			assert.Equal(t, "running", *gotBody.Progress)
		})
	}
}
