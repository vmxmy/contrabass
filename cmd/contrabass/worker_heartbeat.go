package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/junhoyeo/contrabass/internal/types"
	workerv1 "github.com/junhoyeo/contrabass/internal/workerproto/v1"
)

const (
	workerHeartbeatDefaultInterval = 20 * time.Second
	workerHeartbeatMaxJitter       = 2 * time.Second
)

var errWorkerLeaseRevoked = errors.New("worker lease revoked")

type workerHeartbeatPostFunc func(context.Context, workerv1.RunID, workerv1.WorkerHeartbeatRequest) error

type workerHeartbeatScheduler struct {
	registration workerRegistration
	post         workerHeartbeatPostFunc
	interval     func(workerRegistration, workerv1.LeaseSec) time.Duration
	jitter       func(time.Duration) time.Duration
	now          func() time.Time
}

type workerRunProgressTracker struct {
	mu          sync.Mutex
	progress    string
	lastEventTs int64
	now         func() time.Time
}

func newWorkerHeartbeatScheduler(registration workerRegistration, post workerHeartbeatPostFunc) *workerHeartbeatScheduler {
	if post == nil && registration.APIBaseURL != "" {
		registration := registration
		post = func(ctx context.Context, runID workerv1.RunID, request workerv1.WorkerHeartbeatRequest) error {
			return postWorkerHeartbeat(ctx, registration, runID, request)
		}
	}
	return &workerHeartbeatScheduler{
		registration: registration,
		post:         post,
		interval:     workerHeartbeatBaseInterval,
		jitter:       jitterWorkerHeartbeatInterval,
		now:          time.Now,
	}
}

func (s *workerHeartbeatScheduler) Run(ctx context.Context, runID workerv1.RunID, leaseSec workerv1.LeaseSec, progress *workerRunProgressTracker) error {
	if s == nil || s.post == nil {
		return nil
	}
	if s.now == nil {
		s.now = time.Now
	}
	if s.jitter == nil {
		s.jitter = jitterWorkerHeartbeatInterval
	}
	if s.interval == nil {
		s.interval = workerHeartbeatBaseInterval
	}
	if progress == nil {
		progress = newWorkerRunProgressTracker(s.now())
	}

	baseInterval := s.interval(s.registration, leaseSec)
	timer := time.NewTimer(workerHeartbeatNextInterval(baseInterval, s.jitter))
	defer timer.Stop()

	for {
		select {
		case <-ctx.Done():
			return nil
		case <-timer.C:
			request := progress.Snapshot(s.now())
			if err := s.post(ctx, runID, request); err != nil {
				return err
			}
			timer.Reset(workerHeartbeatNextInterval(baseInterval, s.jitter))
		}
	}
}

func newWorkerRunProgressTracker(startedAt time.Time) *workerRunProgressTracker {
	if startedAt.IsZero() {
		startedAt = time.Now()
	}
	return &workerRunProgressTracker{
		progress:    "starting",
		lastEventTs: startedAt.UnixMilli(),
		now:         time.Now,
	}
}

func (t *workerRunProgressTracker) Observe(event types.AgentEvent, fallback time.Time) {
	if t == nil {
		return
	}
	ts := event.Timestamp
	if ts.IsZero() {
		ts = fallback
	}
	if ts.IsZero() {
		if t.now != nil {
			ts = t.now()
		} else {
			ts = time.Now()
		}
	}

	t.mu.Lock()
	defer t.mu.Unlock()
	t.lastEventTs = ts.UnixMilli()
	t.progress = workerProgressLabelFromAgentEvent(event)
}

func (t *workerRunProgressTracker) Snapshot(now time.Time) workerv1.WorkerHeartbeatRequest {
	if t == nil {
		return workerv1.WorkerHeartbeatRequest{
			LastEventTs:     workerv1.EpochMillis(now.UnixMilli()),
			Progress:        stringPtr("running"),
			ProtocolVersion: workerv1.ProtocolVersionCurrent,
		}
	}
	t.mu.Lock()
	defer t.mu.Unlock()

	lastEventTs := t.lastEventTs
	if lastEventTs == 0 {
		lastEventTs = now.UnixMilli()
	}
	progress := strings.TrimSpace(t.progress)
	if progress == "" {
		progress = "running"
	}
	return workerv1.WorkerHeartbeatRequest{
		LastEventTs:     workerv1.EpochMillis(lastEventTs),
		Progress:        stringPtr(progress),
		ProtocolVersion: workerv1.ProtocolVersionCurrent,
	}
}

func workerHeartbeatBaseInterval(registration workerRegistration, frameLeaseSec workerv1.LeaseSec) time.Duration {
	leaseSec := int(frameLeaseSec)
	if leaseSec <= 0 {
		leaseSec = int(registration.LeaseSec)
	}
	if leaseSec > 0 {
		interval := time.Duration(leaseSec) * time.Second / 3
		if interval < time.Second {
			return time.Second
		}
		return interval
	}
	if registration.HeartbeatIntervalSec > 0 {
		return time.Duration(registration.HeartbeatIntervalSec) * time.Second
	}
	return workerHeartbeatDefaultInterval
}

func workerHeartbeatNextInterval(base time.Duration, jitter func(time.Duration) time.Duration) time.Duration {
	if base <= 0 {
		base = workerHeartbeatDefaultInterval
	}
	if jitter == nil {
		return base
	}
	next := base + jitter(base)
	if next < time.Millisecond {
		return time.Millisecond
	}
	return next
}

func jitterWorkerHeartbeatInterval(base time.Duration) time.Duration {
	if base <= 0 {
		return 0
	}
	maxJitter := base / 10
	if maxJitter > workerHeartbeatMaxJitter {
		maxJitter = workerHeartbeatMaxJitter
	}
	if maxJitter <= 0 {
		return 0
	}
	span := int64(maxJitter)*2 + 1
	return time.Duration(rand.Int63n(span)) - maxJitter
}

func workerProgressLabelFromAgentEvent(event types.AgentEvent) string {
	if phase, ok := event.Data["phase"].(string); ok && strings.TrimSpace(phase) != "" {
		return truncateWorkerEventString(strings.TrimSpace(phase), 64)
	}
	eventType := strings.ToLower(event.Type)
	switch {
	case strings.Contains(eventType, "error"):
		return "error"
	case strings.Contains(eventType, "tool"):
		return "tooling"
	case strings.Contains(eventType, "diff") || strings.Contains(eventType, "edit"):
		return "editing"
	case strings.Contains(eventType, "complete") || strings.Contains(eventType, "done"):
		return "completing"
	case strings.Contains(eventType, "start"):
		return "starting"
	default:
		return "running"
	}
}

func postWorkerHeartbeat(
	ctx context.Context,
	registration workerRegistration,
	runID workerv1.RunID,
	request workerv1.WorkerHeartbeatRequest,
) error {
	endpoint, err := workerHeartbeatEndpoint(registration, runID)
	if err != nil {
		return err
	}
	payload, err := json.Marshal(request)
	if err != nil {
		return fmt.Errorf("encoding heartbeat request: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return fmt.Errorf("creating heartbeat request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+registration.SessionToken)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	resp, err := workerLoginHTTPClient.Do(req)
	if err != nil {
		return fmt.Errorf("posting heartbeat request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= http.StatusOK && resp.StatusCode < http.StatusMultipleChoices {
		return nil
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
	if resp.StatusCode == http.StatusConflict && strings.Contains(string(body), "lease_revoked") {
		return fmt.Errorf("%w for run %q: HTTP %d: %s", errWorkerLeaseRevoked, runID, resp.StatusCode, string(body))
	}
	if len(body) > 0 {
		return fmt.Errorf("heartbeat request failed for run %q: HTTP %d: %s", runID, resp.StatusCode, string(body))
	}
	return fmt.Errorf("heartbeat request failed for run %q: HTTP %d", runID, resp.StatusCode)
}

func workerHeartbeatEndpoint(registration workerRegistration, runID workerv1.RunID) (string, error) {
	return workerAPIEndpoint(registration.APIBaseURL, "/v1/runs/"+url.PathEscape(string(runID))+"/heartbeat")
}

func stringPtr(value string) *string {
	return &value
}
