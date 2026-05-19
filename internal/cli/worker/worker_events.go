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
	"strings"
	"time"

	"github.com/junhoyeo/contrabass/internal/types"
	workerv1 "github.com/junhoyeo/contrabass/internal/workerproto/v1"
)

const (
	workerEventsMaxPerBatch = 200
	workerEventsMaxBytes    = 512 * 1024
	workerEventsMaxLatency  = 2 * time.Second
)

type workerEventPostFunc func(context.Context, workerv1.RunID, []workerv1.WorkerEventLine) error

type workerEventBatcher struct {
	maxEvents     int
	maxBytes      int
	flushInterval time.Duration
	post          workerEventPostFunc
	now           func() time.Time
}

func newWorkerEventBatcher(post workerEventPostFunc) *workerEventBatcher {
	return &workerEventBatcher{
		maxEvents:     workerEventsMaxPerBatch,
		maxBytes:      workerEventsMaxBytes,
		flushInterval: workerEventsMaxLatency,
		post:          post,
		now:           time.Now,
	}
}

func (b *workerEventBatcher) Consume(ctx context.Context, runID workerv1.RunID, events <-chan types.AgentEvent) error {
	if b == nil {
		return errors.New("worker event batcher is nil")
	}
	if b.post == nil {
		return errors.New("worker event post function is required")
	}
	if b.maxEvents < 1 {
		b.maxEvents = workerEventsMaxPerBatch
	}
	if b.maxBytes < 1 {
		b.maxBytes = workerEventsMaxBytes
	}
	if b.flushInterval <= 0 {
		b.flushInterval = workerEventsMaxLatency
	}
	if b.now == nil {
		b.now = time.Now
	}

	timer := time.NewTimer(b.flushInterval)
	defer timer.Stop()
	resetTimer := func() {
		if !timer.Stop() {
			select {
			case <-timer.C:
			default:
			}
		}
		timer.Reset(b.flushInterval)
	}

	batch := make([]workerv1.WorkerEventLine, 0, b.maxEvents)
	batchBytes := 0
	seq := 0
	flush := func() error {
		if len(batch) == 0 {
			return nil
		}
		toPost := append([]workerv1.WorkerEventLine(nil), batch...)
		batch = batch[:0]
		batchBytes = 0
		resetTimer()
		postCtx := ctx
		if ctx.Err() != nil {
			postCtx = context.WithoutCancel(ctx)
		}
		return b.post(postCtx, runID, toPost)
	}

	for {
		select {
		case <-ctx.Done():
			if err := flush(); err != nil {
				return err
			}
			return ctx.Err()
		case <-timer.C:
			if err := flush(); err != nil {
				return err
			}
			resetTimer()
		case event, ok := <-events:
			if !ok {
				return flush()
			}
			seq++
			line := workerEventLineFromAgentEvent(event, seq, b.now())
			lineBytes, err := workerEventLineSize(line)
			if err != nil {
				return err
			}
			if len(batch) > 0 && (len(batch) >= b.maxEvents || batchBytes+lineBytes > b.maxBytes) {
				if err := flush(); err != nil {
					return err
				}
			}
			batch = append(batch, line)
			batchBytes += lineBytes
			if len(batch) >= b.maxEvents || batchBytes >= b.maxBytes {
				if err := flush(); err != nil {
					return err
				}
			}
		}
	}
}

func workerEventLineFromAgentEvent(event types.AgentEvent, seq int, fallback time.Time) workerv1.WorkerEventLine {
	ts := event.Timestamp
	if ts.IsZero() {
		ts = fallback
	}
	line := workerv1.WorkerEventLine{
		"protocol_version": string(workerv1.ProtocolVersionCurrent),
		"ts":               ts.UnixMilli(),
		"seq":              seq,
	}
	if isWorkerErrorAgentEvent(event) {
		line["kind"] = "error"
		line["payload"] = map[string]interface{}{
			"errorClass": truncateWorkerEventString(event.Type, 128),
			"message":    truncateWorkerEventString(workerAgentEventMessage(event), 8192),
			"fatal":      event.Type == "session.error",
		}
		return line
	}

	source := "agent"
	line["kind"] = "log"
	line["payload"] = map[string]interface{}{
		"level":   "info",
		"message": truncateWorkerEventString(workerAgentEventMessage(event), 8192),
		"source":  source,
	}
	return line
}

func isWorkerErrorAgentEvent(event types.AgentEvent) bool {
	eventType := strings.ToLower(event.Type)
	return strings.Contains(eventType, "error")
}

func workerAgentEventMessage(event types.AgentEvent) string {
	if message, ok := event.Data["message"].(string); ok && strings.TrimSpace(message) != "" {
		return event.Type + ": " + message
	}
	if errText, ok := event.Data["error"].(string); ok && strings.TrimSpace(errText) != "" {
		return event.Type + ": " + errText
	}
	if len(event.Data) == 0 {
		return event.Type
	}
	payload, err := json.Marshal(event.Data)
	if err != nil {
		return event.Type
	}
	return event.Type + ": " + string(payload)
}

func truncateWorkerEventString(value string, maxLen int) string {
	if maxLen < 1 || len(value) <= maxLen {
		return value
	}
	return value[:maxLen]
}

func workerEventLineSize(line workerv1.WorkerEventLine) (int, error) {
	payload, err := json.Marshal(line)
	if err != nil {
		return 0, fmt.Errorf("encoding worker event line: %w", err)
	}
	return len(payload) + 1, nil
}

func postWorkerEvents(
	ctx context.Context,
	registration workerRegistration,
	runID workerv1.RunID,
	events []workerv1.WorkerEventLine,
) error {
	if len(events) == 0 {
		return nil
	}
	if len(events) > workerEventsMaxPerBatch {
		mid := len(events) / 2
		if err := postWorkerEvents(ctx, registration, runID, events[:mid]); err != nil {
			return err
		}
		return postWorkerEvents(ctx, registration, runID, events[mid:])
	}
	err := postWorkerEventsOnce(ctx, registration, runID, events)
	if err == nil {
		return nil
	}
	if errors.Is(err, errWorkerEventsTooLarge) && len(events) > 1 {
		mid := len(events) / 2
		if err := postWorkerEvents(ctx, registration, runID, events[:mid]); err != nil {
			return err
		}
		return postWorkerEvents(ctx, registration, runID, events[mid:])
	}
	return err
}

var errWorkerEventsTooLarge = errors.New("worker events batch too large")

func postWorkerEventsOnce(
	ctx context.Context,
	registration workerRegistration,
	runID workerv1.RunID,
	events []workerv1.WorkerEventLine,
) error {
	endpoint, err := workerEventsEndpoint(registration, runID)
	if err != nil {
		return err
	}
	payload, err := encodeWorkerEventsNDJSON(events)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return fmt.Errorf("creating events request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+registration.currentToken())
	req.Header.Set("Content-Type", "application/x-ndjson")
	req.Header.Set("Accept", "application/json")

	resp, err := workerLoginHTTPClient.Do(req)
	if err != nil {
		return fmt.Errorf("posting events request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= http.StatusOK && resp.StatusCode < http.StatusMultipleChoices {
		return nil
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
	if resp.StatusCode == http.StatusRequestEntityTooLarge {
		return fmt.Errorf("%w for run %q: HTTP %d: %s", errWorkerEventsTooLarge, runID, resp.StatusCode, string(body))
	}
	if len(body) > 0 {
		return fmt.Errorf("events request failed for run %q: HTTP %d: %s", runID, resp.StatusCode, string(body))
	}
	return fmt.Errorf("events request failed for run %q: HTTP %d", runID, resp.StatusCode)
}

func encodeWorkerEventsNDJSON(events []workerv1.WorkerEventLine) ([]byte, error) {
	var buf bytes.Buffer
	for _, event := range events {
		line, err := json.Marshal(event)
		if err != nil {
			return nil, fmt.Errorf("encoding worker event line: %w", err)
		}
		buf.Write(line)
		buf.WriteByte('\n')
	}
	return buf.Bytes(), nil
}

func workerEventsEndpoint(registration workerRegistration, runID workerv1.RunID) (string, error) {
	return workerAPIEndpoint(registration.APIBaseURL, "/v1/runs/"+url.PathEscape(string(runID))+"/events")
}
