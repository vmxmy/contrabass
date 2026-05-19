package worker

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sync"
	"time"

	workerv1 "github.com/junhoyeo/contrabass/internal/workerproto/v1"
)

// workerLeaseRevokedHandler is called by the dispatch loop when a
// "lease-revoked" WebSocket frame arrives. The implementation should signal
// the corresponding in-flight run to stop.
type workerLeaseRevokedHandler func(workerv1.RunID)

const workerDispatchAckSLA = 5 * time.Second

type workerAckingDispatchHandler struct {
	registration   workerRegistration
	maxConcurrency int
	startRun       workerDispatchHandler

	mu       sync.Mutex
	inFlight map[workerv1.RunID]context.CancelCauseFunc
}

func newWorkerAckingDispatchHandler(
	registration workerRegistration,
	maxConcurrency int,
	startRun workerDispatchHandler,
) *workerAckingDispatchHandler {
	if maxConcurrency < 1 {
		maxConcurrency = 1
	}
	if startRun == nil {
		startRun = func(context.Context, workerv1.WorkerDispatchFrame) error { return nil }
	}

	return &workerAckingDispatchHandler{
		registration:   registration,
		maxConcurrency: maxConcurrency,
		startRun:       startRun,
		inFlight:       make(map[workerv1.RunID]context.CancelCauseFunc),
	}
}

func (h *workerAckingDispatchHandler) Handle(ctx context.Context, frame workerv1.WorkerDispatchFrame) error {
	if frame.RunID == "" {
		return errors.New("dispatch frame missing runId")
	}

	// Each accepted run gets its own derived context so that lease revocation
	// (via RevokeRun) can cancel exactly one run without disturbing others.
	runCtx, cancelCause := context.WithCancelCause(ctx)

	if !h.tryAcquire(frame.RunID, cancelCause) {
		cancelCause(nil)
		return postWorkerDispatchAck(ctx, h.registration, frame.RunID, workerv1.Reject{
			Accept:          false,
			Reason:          workerv1.RejectReasonAtCapacity,
			ProtocolVersion: workerv1.ProtocolVersionCurrent,
		})
	}

	if err := postWorkerDispatchAck(ctx, h.registration, frame.RunID, workerv1.Accept{
		Accept:          true,
		ProtocolVersion: workerv1.ProtocolVersionCurrent,
	}); err != nil {
		h.release(frame.RunID)
		cancelCause(nil)
		return err
	}

	go func() {
		defer cancelCause(nil)
		defer h.release(frame.RunID)
		_ = h.startRun(runCtx, frame)
	}()
	return nil
}

// RevokeRun cancels the in-flight run identified by runID with errLeaseRevoked
// as the context cause. The executor detects this cause to perform the
// SIGTERM → SIGKILL grace sequence and worktree cleanup.
func (h *workerAckingDispatchHandler) RevokeRun(runID workerv1.RunID) {
	h.mu.Lock()
	cancelCause, ok := h.inFlight[runID]
	h.mu.Unlock()
	if ok && cancelCause != nil {
		cancelCause(errLeaseRevoked)
	}
}

func (h *workerAckingDispatchHandler) tryAcquire(runID workerv1.RunID, cancelCause context.CancelCauseFunc) bool {
	h.mu.Lock()
	defer h.mu.Unlock()

	if len(h.inFlight) >= h.maxConcurrency {
		return false
	}
	h.inFlight[runID] = cancelCause
	return true
}

func (h *workerAckingDispatchHandler) release(runID workerv1.RunID) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.inFlight, runID)
}

func postWorkerDispatchAck(
	ctx context.Context,
	registration workerRegistration,
	runID workerv1.RunID,
	request workerv1.WorkerAckRequest,
) error {
	ctx, cancel := context.WithTimeout(ctx, workerDispatchAckSLA)
	defer cancel()

	endpoint, err := workerAckEndpoint(registration, runID)
	if err != nil {
		return err
	}
	payload, err := json.Marshal(request)
	if err != nil {
		return fmt.Errorf("encoding ack request: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return fmt.Errorf("creating ack request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+registration.currentToken())
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	resp, err := workerLoginHTTPClient.Do(req)
	if err != nil {
		return fmt.Errorf("posting ack request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= http.StatusOK && resp.StatusCode < http.StatusMultipleChoices {
		return nil
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
	if len(body) > 0 {
		return fmt.Errorf("ack request failed for run %q: HTTP %d: %s", runID, resp.StatusCode, string(body))
	}
	return fmt.Errorf("ack request failed for run %q: HTTP %d", runID, resp.StatusCode)
}

func workerAckEndpoint(registration workerRegistration, runID workerv1.RunID) (string, error) {
	return workerAPIEndpoint(registration.APIBaseURL, "/v1/runs/"+url.PathEscape(string(runID))+"/ack")
}
