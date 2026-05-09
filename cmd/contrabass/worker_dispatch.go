package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/coder/websocket"

	workerv1 "github.com/junhoyeo/contrabass/internal/workerproto/v1"
)

const workerWSFailureThreshold = 3

var (
	workerWSReconnectDelay       = time.Second
	workerWSFallbackRetryDelay   = time.Minute
	errWorkerWebSocketUpgrade    = errors.New("worker websocket upgrade failed")
	errWorkerWebSocketClosed     = errors.New("worker websocket closed")
	errWorkerDispatchUnsupported = errors.New("unsupported worker dispatch frame")
)

type workerDispatchHandler func(context.Context, workerv1.WorkerDispatchFrame) error

func consumeWorkerDispatches(
	ctx context.Context,
	registration workerRegistration,
	handleDispatch workerDispatchHandler,
) error {
	if handleDispatch == nil {
		return errors.New("dispatch handler is required")
	}
	if registration.DispatchChannel.WsURL == "" && registration.DispatchChannel.LongPollURL == "" {
		return errors.New("registration response missing dispatch channel URLs")
	}

	wsFailures := 0
	inLongPollFallback := false
	nextWSRetry := time.Now()

	for {
		if err := ctx.Err(); err != nil {
			return err
		}

		if inLongPollFallback && time.Now().Before(nextWSRetry) {
			if err := longPollWorkerDispatch(ctx, registration, handleDispatch); err != nil {
				return err
			}
			continue
		}

		err := consumeWorkerDispatchWebSocket(ctx, registration, handleDispatch)
		if err == nil {
			wsFailures = 0
			inLongPollFallback = false
			continue
		}
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return err
		}
		if errors.Is(err, errWorkerWebSocketClosed) {
			wsFailures = 0
			inLongPollFallback = false
			if err := sleepWorkerDispatch(ctx, workerWSReconnectDelay); err != nil {
				return err
			}
			continue
		}
		if !errors.Is(err, errWorkerWebSocketUpgrade) {
			return err
		}

		wsFailures++
		if wsFailures >= workerWSFailureThreshold {
			inLongPollFallback = true
			nextWSRetry = time.Now().Add(workerWSFallbackRetryDelay)
			if err := longPollWorkerDispatch(ctx, registration, handleDispatch); err != nil {
				return err
			}
			continue
		}
		if err := sleepWorkerDispatch(ctx, workerWSReconnectDelay); err != nil {
			return err
		}
	}
}

func consumeWorkerDispatchWebSocket(
	ctx context.Context,
	registration workerRegistration,
	handleDispatch workerDispatchHandler,
) error {
	wsURL := string(registration.DispatchChannel.WsURL)
	if wsURL == "" {
		return fmt.Errorf("%w: dispatchChannel.wsUrl is empty", errWorkerWebSocketUpgrade)
	}

	headers := http.Header{}
	headers.Set("Authorization", "Bearer "+registration.SessionToken)
	headers.Set("Accept", "application/json")
	conn, resp, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{
		HTTPHeader: headers,
	})
	if err != nil {
		status := 0
		if resp != nil {
			status = resp.StatusCode
		}
		return fmt.Errorf("%w: %s (HTTP %d)", errWorkerWebSocketUpgrade, err, status)
	}
	defer conn.CloseNow()

	for {
		messageType, data, err := conn.Read(ctx)
		if err != nil {
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				return err
			}
			if closeStatus := websocket.CloseStatus(err); closeStatus != -1 {
				return fmt.Errorf("%w: %w", errWorkerWebSocketClosed, err)
			}
			return fmt.Errorf("%w: %w", errWorkerWebSocketClosed, err)
		}
		if messageType != websocket.MessageText {
			continue
		}
		frame, err := decodeWorkerDispatchFrame(data)
		if err != nil {
			return err
		}
		if err := handleDispatch(ctx, frame); err != nil {
			return err
		}
	}
}

func longPollWorkerDispatch(
	ctx context.Context,
	registration workerRegistration,
	handleDispatch workerDispatchHandler,
) error {
	longPollURL := string(registration.DispatchChannel.LongPollURL)
	if longPollURL == "" {
		return errors.New("registration response missing dispatchChannel.longPollUrl")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, longPollURL, nil)
	if err != nil {
		return fmt.Errorf("creating long-poll dispatch request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+registration.SessionToken)
	req.Header.Set("Accept", "application/json")

	resp, err := workerLoginHTTPClient.Do(req)
	if err != nil {
		return fmt.Errorf("long-poll dispatch request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNoContent {
		return nil
	}
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		if len(body) > 0 {
			return fmt.Errorf("long-poll dispatch failed: HTTP %d: %s", resp.StatusCode, string(body))
		}
		return fmt.Errorf("long-poll dispatch failed: HTTP %d", resp.StatusCode)
	}
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("reading long-poll dispatch response: %w", err)
	}
	frame, err := decodeWorkerDispatchFrame(data)
	if err != nil {
		return err
	}
	return handleDispatch(ctx, frame)
}

func decodeWorkerDispatchFrame(data []byte) (workerv1.WorkerDispatchFrame, error) {
	var envelope struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(data, &envelope); err != nil {
		return workerv1.WorkerDispatchFrame{}, fmt.Errorf("decoding dispatch frame envelope: %w", err)
	}
	if envelope.Type != "dispatch" {
		return workerv1.WorkerDispatchFrame{}, fmt.Errorf("%w: %q", errWorkerDispatchUnsupported, envelope.Type)
	}

	var frame workerv1.WorkerDispatchFrame
	if err := json.Unmarshal(data, &frame); err != nil {
		return workerv1.WorkerDispatchFrame{}, fmt.Errorf("decoding dispatch frame: %w", err)
	}
	if frame.ProtocolVersion == "" {
		frame.ProtocolVersion = workerv1.ProtocolVersionCurrent
	}
	return frame, nil
}

func sleepWorkerDispatch(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
