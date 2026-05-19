//go:build !localonly

package main

import (
	"errors"
	"fmt"
	"strings"

	"github.com/spf13/cobra"

	clitui "github.com/junhoyeo/contrabass/internal/cli/tui"
)

var tuiCmd = &cobra.Command{
	Use:   "tui",
	Short: "Watch the cloud team board in a read-only terminal UI",
	Long: `Open a read-only terminal UI connected to the Contrabass cloud control plane.
The TUI subscribes to live board updates, run events, and worker status changes
for the specified team via WebSocket.

Enrollment is required before using the TUI. If this machine has not been
enrolled yet, run "contrabass worker login" first.`,
	RunE: runTUI,
}

type tuiOptions struct {
	TeamID     string
	APIBaseURL string
}

func init() {
	tuiCmd.Flags().String("team", "", "cloud team ID to subscribe to (required)")
	tuiCmd.Flags().String("api-url", defaultWorkerAPIBaseURL, "Contrabass cloud API base URL")
	_ = tuiCmd.MarkFlagRequired("team")
}

func runTUI(cmd *cobra.Command, _ []string) error {
	opts, err := tuiOptionsFromFlags(cmd)
	if err != nil {
		return err
	}

	store, err := newWorkerLoginStore()
	if err != nil {
		return fmt.Errorf("opening OS credential store: %w", err)
	}
	enrollment, err := store.LoadWorkerEnrollment(cmd.Context(), opts.TeamID)
	if err != nil {
		if errors.Is(err, errWorkerEnrollmentNotFound) {
			return fmt.Errorf("no enrollment found for team %q; run \"contrabass worker login\" first", opts.TeamID)
		}
		return fmt.Errorf("loading worker enrollment from OS credential store: %w", err)
	}

	sessionToken, err := refreshWorkerSession(cmd.Context(), opts.APIBaseURL, enrollment.RefreshToken)
	if err != nil {
		return err
	}

	subscribeURL, err := clitui.SubscribeURL(opts.APIBaseURL, opts.TeamID)
	if err != nil {
		return err
	}

	return clitui.Run(cmd.Context(), clitui.ProgramConfig{
		TeamID:       opts.TeamID,
		SessionToken: sessionToken,
		SubscribeURL: subscribeURL,
	})
}

func tuiOptionsFromFlags(cmd *cobra.Command) (tuiOptions, error) {
	teamID, err := cmd.Flags().GetString("team")
	if err != nil {
		return tuiOptions{}, fmt.Errorf("getting team flag: %w", err)
	}
	apiBaseURL, err := cmd.Flags().GetString("api-url")
	if err != nil {
		return tuiOptions{}, fmt.Errorf("getting api-url flag: %w", err)
	}
	return tuiOptions{
		TeamID:     strings.TrimSpace(teamID),
		APIBaseURL: strings.TrimSpace(apiBaseURL),
	}, nil
}
