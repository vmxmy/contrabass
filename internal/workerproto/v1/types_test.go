package v1

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestWorkerProtocolTypesMarshalWireFields(t *testing.T) {
	tests := []struct {
		name string
		in   any
		want map[string]any
	}{
		{
			name: "register request keeps mixed casing",
			in: WorkerRegisterRequest{
				TeamID:                    "team-1",
				WorkerID:                  "worker-1",
				Capabilities:              []Capability{"agent:codex", "git"},
				MaxConcurrency:            2,
				Version:                   "dev",
				SupportedProtocolVersions: []string{"1.0.0"},
			},
			want: map[string]any{
				"teamId":                      "team-1",
				"workerId":                    "worker-1",
				"capabilities":                []any{"agent:codex", "git"},
				"maxConcurrency":              float64(2),
				"version":                     "dev",
				"supported_protocol_versions": []any{"1.0.0"},
			},
		},
		{
			name: "dispatch frame includes protocol version",
			in: WorkerDispatchFrame{
				Type:            "dispatch",
				ProtocolVersion: ProtocolVersionCurrent,
				RunID:           "run-1",
				IssueRef:        "LIN-123",
				Branch:          "feature/lin-123",
				Prompt:          "fix the issue",
				ConfigHash:      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
				LeaseSec:        60,
				ArtifactUploadURLs: WorkerDispatchFrameArtifactUploadURLs{
					Logs:    "https://example.test/logs",
					Diff:    "https://example.test/diff",
					Summary: "https://example.test/summary",
				},
			},
			want: map[string]any{
				"type":             "dispatch",
				"protocol_version": "1.0.0",
				"runId":            "run-1",
				"issueRef":         "LIN-123",
				"branch":           "feature/lin-123",
				"prompt":           "fix the issue",
				"configHash":       "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
				"leaseSec":         float64(60),
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			encoded, err := json.Marshal(tt.in)
			require.NoError(t, err)

			var got map[string]any
			require.NoError(t, json.Unmarshal(encoded, &got))
			for key, want := range tt.want {
				assert.Equal(t, want, got[key], "field %s", key)
			}
		})
	}
}

func TestWorkerProtocolOneOfVariantInterfaces(t *testing.T) {
	var _ WorkerAckRequest = Accept{}
	var _ WorkerAckRequest = Reject{}
	var _ WorkerCompleteRequest = SucceededCompletion{}
	var _ WorkerCompleteRequest = FailedCompletion{}
	var _ WorkerCompleteRequest = CancelledCompletion{}
}

func TestWorkerProtocolFixturesDecode(t *testing.T) {
	fixtureDir := filepath.Join("..", "..", "..", "testdata", "workerproto", "v1")
	tests := []struct {
		name string
		file string
		out  any
	}{
		{name: "register request", file: "register-request.local.json", out: &WorkerRegisterRequest{}},
		{name: "register response", file: "register-response.success.json", out: &WorkerRegisterResponse{}},
		{name: "register protocol error", file: "register-error.protocol-version-unsupported.json", out: &ProtocolVersionUnsupportedError{}},
		{name: "register team forbidden", file: "register-error.team-forbidden.json", out: &TeamForbiddenError{}},
		{name: "register worker cap exceeded", file: "register-error.team-worker-cap-exceeded.json", out: &TeamWorkerCapExceededError{}},
		{name: "register auth invalid", file: "register-error.auth-invalid.json", out: &AuthInvalidError{}},
		{name: "dispatch frame", file: "dispatch.json", out: &WorkerDispatchFrame{}},
		{name: "ack accept", file: "ack.accept.json", out: &Accept{}},
		{name: "ack reject", file: "ack.reject.json", out: &Reject{}},
		{name: "heartbeat", file: "heartbeat.json", out: &WorkerHeartbeatRequest{}},
		{name: "heartbeat lease revoked", file: "heartbeat-error.lease-revoked.json", out: &LeaseRevokedError{}},
		{name: "heartbeat lease holder mismatch", file: "heartbeat-error.lease-holder-mismatch.json", out: &LeaseHolderMismatchError{}},
		{name: "heartbeat run unknown", file: "heartbeat-error.run-unknown.json", out: &RunUnknownError{}},
		{name: "heartbeat run terminal", file: "heartbeat-error.run-terminal.json", out: &RunTerminalError{}},
		{name: "start event", file: "event-line.start.json", out: &WorkerEventLine{}},
		{name: "log event", file: "event-line.log.json", out: &WorkerEventLine{}},
		{name: "tool call event", file: "event-line.tool-call.json", out: &WorkerEventLine{}},
		{name: "diff event", file: "event-line.diff.json", out: &WorkerEventLine{}},
		{name: "error event", file: "event-line.error.json", out: &WorkerEventLine{}},
		{name: "phase event", file: "event-line.phase.json", out: &WorkerEventLine{}},
		{name: "events request", file: "events-request.json", out: &WorkerEventsRequest{}},
		{name: "events too large", file: "events-error.too-large.json", out: &EventsTooLargeError{}},
		{name: "events too many", file: "events-error.too-many.json", out: &EventsTooManyError{}},
		{name: "events invalid ndjson", file: "events-error.invalid-ndjson.json", out: &InvalidNDJSONError{}},
		{name: "complete succeeded", file: "complete.succeeded.json", out: &SucceededCompletion{}},
		{name: "complete failed", file: "complete.failed.json", out: &FailedCompletion{}},
		{name: "complete cancelled", file: "complete.cancelled.json", out: &CancelledCompletion{}},
		{name: "complete lease revoked", file: "complete-error.lease-revoked.json", out: &LeaseRevokedError{}},
		{name: "lease revoked frame", file: "lease-revoked.heartbeat-timeout.json", out: &LeaseRevokedFrame{}},
		{name: "refresh request", file: "refresh-request.json", out: &WorkerRefreshRequest{}},
		{name: "refresh response", file: "refresh-response.success.json", out: &WorkerRefreshResponse{}},
		{name: "refresh revoked", file: "refresh-error.revoked.json", out: &RefreshRevokedError{}},
		{name: "refresh expired", file: "refresh-error.expired.json", out: &RefreshExpiredError{}},
		{name: "refresh invalid", file: "refresh-error.invalid.json", out: &RefreshInvalidError{}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			raw := readFixture(t, fixtureDir, tt.file)
			require.NoError(t, json.Unmarshal(raw, tt.out))

			var golden any
			require.NoError(t, json.Unmarshal(raw, &golden))
			roundTrip, err := json.Marshal(tt.out)
			require.NoError(t, err)
			var got any
			require.NoError(t, json.Unmarshal(roundTrip, &got))
			assert.Equal(t, golden, got)
		})
	}
}

func TestWorkerProtocolFixturesCarryProtocolVersion(t *testing.T) {
	fixtureDir := filepath.Join("..", "..", "..", "testdata", "workerproto", "v1")
	entries, err := os.ReadDir(fixtureDir)
	require.NoError(t, err)

	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}

		t.Run(entry.Name(), func(t *testing.T) {
			raw := readFixture(t, fixtureDir, entry.Name())
			var value any
			require.NoError(t, json.Unmarshal(raw, &value))
			assertFixtureProtocolVersion(t, value)
		})
	}
}

func readFixture(t *testing.T, dir, name string) []byte {
	t.Helper()

	raw, err := os.ReadFile(filepath.Join(dir, name))
	require.NoError(t, err)
	return raw
}

func assertFixtureProtocolVersion(t *testing.T, value any) {
	t.Helper()

	switch typed := value.(type) {
	case []any:
		require.NotEmpty(t, typed)
		for _, item := range typed {
			assertFixtureProtocolVersion(t, item)
		}
	case map[string]any:
		require.Contains(t, typed, "protocol_version")
		assert.Equal(t, string(ProtocolVersionCurrent), typed["protocol_version"])
	default:
		require.Failf(t, "unsupported fixture shape", "type %T", value)
	}
}
