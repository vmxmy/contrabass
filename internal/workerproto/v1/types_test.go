package v1

import (
	"encoding/json"
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
