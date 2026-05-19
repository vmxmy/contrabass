//go:build !localonly

package tui

import (
	"context"
	"strings"

	"github.com/junhoyeo/contrabass/internal/cli/worker"
)

// This file is the exported boundary of the cli/tui package. Everything else in
// the package stays unexported; only the symbols the CLI wiring layer consumes
// are re-exported here. It mirrors internal/cli/worker/facade.go and
// internal/cli/team/facade.go.

// ProgramConfig holds the configuration for the read-only cloud TUI.
type ProgramConfig = tuiProgramConfig

// Run starts the read-only cloud TUI program and its background WebSocket
// subscriber, blocking until the user quits or ctx is cancelled.
func Run(ctx context.Context, cfg ProgramConfig) error {
	return runTUIProgram(ctx, cfg)
}

// SubscribeURL converts an HTTP(S) API base URL into the WebSocket URL for the
// team subscription endpoint (/v1/teams/{teamId}/subscribe).
func SubscribeURL(apiBaseURL, teamID string) (string, error) {
	endpoint, err := worker.APIEndpoint(apiBaseURL, "/v1/teams/"+teamID+"/subscribe")
	if err != nil {
		return "", err
	}
	switch {
	case strings.HasPrefix(endpoint, "https://"):
		return "wss://" + endpoint[len("https://"):], nil
	case strings.HasPrefix(endpoint, "http://"):
		return "ws://" + endpoint[len("http://"):], nil
	default:
		return endpoint, nil
	}
}
