//go:build !localonly

package tui_test

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	clitui "github.com/junhoyeo/contrabass/internal/cli/tui"
)

// TestSubscribeURL verifies HTTP(S) base URLs are converted to ws(s) subscribe
// endpoints, mirroring the original cmd-level TestTUISubscribeURL coverage.
func TestSubscribeURL(t *testing.T) {
	tests := []struct {
		name       string
		apiBaseURL string
		teamID     string
		want       string
		wantErr    bool
	}{
		{
			name:       "https becomes wss",
			apiBaseURL: "https://api.contrabass.dev",
			teamID:     "acme",
			want:       "wss://api.contrabass.dev/v1/teams/acme/subscribe",
		},
		{
			name:       "http becomes ws",
			apiBaseURL: "http://localhost:8787",
			teamID:     "local-team",
			want:       "ws://localhost:8787/v1/teams/local-team/subscribe",
		},
		{
			name:       "trailing slash on base url is trimmed",
			apiBaseURL: "https://api.contrabass.dev/",
			teamID:     "team1",
			want:       "wss://api.contrabass.dev/v1/teams/team1/subscribe",
		},
		{
			name:       "empty api url returns error",
			apiBaseURL: "",
			teamID:     "team1",
			wantErr:    true,
		},
		{
			name:       "invalid url returns error",
			apiBaseURL: "not-a-url",
			teamID:     "team1",
			wantErr:    true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := clitui.SubscribeURL(tt.apiBaseURL, tt.teamID)
			if tt.wantErr {
				require.Error(t, err)
				return
			}
			require.NoError(t, err)
			assert.Equal(t, tt.want, got)
		})
	}
}
