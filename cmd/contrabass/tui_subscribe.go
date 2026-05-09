package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/coder/websocket"
)

// Frame type constants broadcast on /v1/teams/{teamId}/subscribe.
const (
	tuiFrameTypeBoardUpdate   = "board-update"
	tuiFrameTypeRunEvent      = "run-event"
	tuiFrameTypeWorkerStatus  = "worker-status"
	tuiFrameTypeConfigChanged = "config-changed"
)

// tuiBoardEntry is one row in the team task board.
type tuiBoardEntry struct {
	IssueRef         string `json:"issueRef"`
	RunID            string `json:"runId,omitempty"`
	AssignedWorkerID string `json:"assignedWorkerId,omitempty"`
	Phase            string `json:"phase"`
	LastUpdated      string `json:"lastUpdated,omitempty"`
}

// tuiBoardUpdate is the board-update frame payload.
type tuiBoardUpdate struct {
	TeamID  string          `json:"teamId"`
	Entries []tuiBoardEntry `json:"entries"`
}

// tuiRunEvent is the run-event frame payload.
type tuiRunEvent struct {
	RunID     string          `json:"runId"`
	IssueRef  string          `json:"issueRef"`
	EventType string          `json:"eventType"`
	Payload   json.RawMessage `json:"payload,omitempty"`
	Timestamp string          `json:"timestamp,omitempty"`
}

// tuiWorkerStatus is the worker-status frame payload.
type tuiWorkerStatus struct {
	WorkerID string `json:"workerId"`
	Status   string `json:"status"`
	Kind     string `json:"kind,omitempty"`
}

// tuiConfigChanged is the config-changed frame payload.
type tuiConfigChanged struct {
	TeamID  string `json:"teamId"`
	Version string `json:"version"`
	Hash    string `json:"hash"`
}

// tuiSubscribeFrame is a fully decoded inbound frame from the subscribe WS.
type tuiSubscribeFrame struct {
	Type          string
	BoardUpdate   *tuiBoardUpdate
	RunEvent      *tuiRunEvent
	WorkerStatus  *tuiWorkerStatus
	ConfigChanged *tuiConfigChanged
}

// tuiFrameEnvelope peeks at shared top-level fields without allocating typed payloads.
type tuiFrameEnvelope struct {
	Type    string `json:"type"`
	EventID string `json:"eventId,omitempty"`
}

// parseTUIFrame decodes raw WS message bytes into a tuiSubscribeFrame.
// Unknown frame types are returned with Type set and all payload fields nil,
// so callers can ignore them for forward compatibility.
func parseTUIFrame(data []byte) (frame tuiSubscribeFrame, eventID string, err error) {
	var env tuiFrameEnvelope
	if err := json.Unmarshal(data, &env); err != nil {
		return tuiSubscribeFrame{}, "", fmt.Errorf("parsing frame envelope: %w", err)
	}
	frame.Type = env.Type

	switch env.Type {
	case tuiFrameTypeBoardUpdate:
		var p struct {
			tuiFrameEnvelope
			Board tuiBoardUpdate `json:"board"`
		}
		if err := json.Unmarshal(data, &p); err != nil {
			return frame, env.EventID, fmt.Errorf("parsing board-update payload: %w", err)
		}
		frame.BoardUpdate = &p.Board

	case tuiFrameTypeRunEvent:
		var p struct {
			tuiFrameEnvelope
			Event tuiRunEvent `json:"event"`
		}
		if err := json.Unmarshal(data, &p); err != nil {
			return frame, env.EventID, fmt.Errorf("parsing run-event payload: %w", err)
		}
		frame.RunEvent = &p.Event

	case tuiFrameTypeWorkerStatus:
		var p struct {
			tuiFrameEnvelope
			Worker tuiWorkerStatus `json:"worker"`
		}
		if err := json.Unmarshal(data, &p); err != nil {
			return frame, env.EventID, fmt.Errorf("parsing worker-status payload: %w", err)
		}
		frame.WorkerStatus = &p.Worker

	case tuiFrameTypeConfigChanged:
		var p struct {
			tuiFrameEnvelope
			Config tuiConfigChanged `json:"config"`
		}
		if err := json.Unmarshal(data, &p); err != nil {
			return frame, env.EventID, fmt.Errorf("parsing config-changed payload: %w", err)
		}
		frame.ConfigChanged = &p.Config
	}

	return frame, env.EventID, nil
}

// Reconnect backoff bounds for the subscribe WebSocket.
var (
	tuiWSInitialBackoff = 500 * time.Millisecond
	tuiWSMaxBackoff     = 30 * time.Second
)

// tuiSubscriber opens and maintains a WebSocket connection to the team
// subscribe endpoint, forwarding decoded frames to out. It reconnects with
// exponential backoff until ctx is cancelled.
type tuiSubscriber struct {
	subscribeURL   string
	sessionToken   string
	lastEventID    string
	onConnected    func() // called each time the WS handshake succeeds
	onReconnecting func() // called each time a reconnect attempt begins
}

// Run loops until ctx is cancelled, reconnecting on any non-context error.
func (s *tuiSubscriber) Run(ctx context.Context, out chan<- tuiSubscribeFrame) error {
	backoff := tuiWSInitialBackoff
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}

		connectStart := time.Now()
		err := s.connect(ctx, out)
		if err == nil || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return err
		}

		// Reset backoff if the connection stayed up long enough to be useful.
		if time.Since(connectStart) > 30*time.Second {
			backoff = tuiWSInitialBackoff
		}

		if s.onReconnecting != nil {
			s.onReconnecting()
		}

		// Exponential backoff: 25% fixed jitter to avoid thundering herd.
		jitter := backoff / 4
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(backoff + jitter):
		}
		backoff = min(backoff*2, tuiWSMaxBackoff)
	}
}

func (s *tuiSubscriber) connect(ctx context.Context, out chan<- tuiSubscribeFrame) error {
	url := s.subscribeURL
	if s.lastEventID != "" {
		url += "?last_event_id=" + s.lastEventID
	}

	headers := http.Header{}
	headers.Set("Authorization", "Bearer "+s.sessionToken)
	headers.Set("Accept", "application/json")

	conn, _, err := websocket.Dial(ctx, url, &websocket.DialOptions{
		HTTPHeader: headers,
	})
	if err != nil {
		return fmt.Errorf("tui subscribe dial: %w", err)
	}
	defer conn.CloseNow()

	if s.onConnected != nil {
		s.onConnected()
	}

	for {
		msgType, data, err := conn.Read(ctx)
		if err != nil {
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				return err
			}
			return fmt.Errorf("tui subscribe read: %w", err)
		}
		if msgType != websocket.MessageText {
			continue
		}

		frame, eventID, err := parseTUIFrame(data)
		if err != nil {
			// Malformed frames are skipped; don't disconnect.
			continue
		}
		if eventID != "" {
			s.lastEventID = eventID
		}

		select {
		case out <- frame:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}
