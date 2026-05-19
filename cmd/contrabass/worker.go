package main

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/spf13/cobra"

	"github.com/junhoyeo/contrabass/internal/cli/worker"
)

// Thin re-exports kept so the (untouched) tui command continues to compile
// against the original package-main identifiers after the worker runtime moved
// to internal/cli/worker. These add no logic — they forward to the package.
const defaultWorkerAPIBaseURL = worker.DefaultAPIBaseURL

var errWorkerEnrollmentNotFound = worker.ErrEnrollmentNotFound

func newWorkerLoginStore() (worker.EnrollmentStore, error) { return worker.NewLoginStore() }

func refreshWorkerSession(ctx context.Context, apiBaseURL, refreshToken string) (string, error) {
	return worker.RefreshSession(ctx, apiBaseURL, refreshToken)
}

func workerAPIEndpoint(apiBaseURL, path string) (string, error) {
	return worker.APIEndpoint(apiBaseURL, path)
}

var workerCmd = &cobra.Command{
	Use:   "worker",
	Short: "Run a local worker daemon for a cloud team",
	Long: `Run a local worker daemon that registers with the Contrabass cloud control
plane, waits for dispatched runs, and executes them on this machine.

Enrollment is required before starting a worker. If this machine has not been
enrolled yet, run "contrabass worker login" first.`,
	RunE: runWorker,
}

func init() {
	workerCmd.Flags().String("team", "", "cloud team ID to register this worker with (required)")
	workerCmd.Flags().String("api-url", defaultWorkerAPIBaseURL, "Contrabass cloud API base URL")
	workerCmd.Flags().Int("max-concurrency", 1, "maximum concurrently-acked runs this worker accepts")
	workerCmd.Flags().Bool("ephemeral", false, "CI/ephemeral mode: hints the cloud to grant a shorter lease and applies shorter client-side lease defaults")
	_ = workerCmd.MarkFlagRequired("team")
	workerCmd.AddCommand(worker.NewLoginCmd())
	worker.SetVersion(version)
}

func runWorker(cmd *cobra.Command, _ []string) error {
	teamID, err := cmd.Flags().GetString("team")
	if err != nil {
		return fmt.Errorf("getting team flag: %w", err)
	}
	apiBaseURL, err := cmd.Flags().GetString("api-url")
	if err != nil {
		return fmt.Errorf("getting api-url flag: %w", err)
	}
	maxConcurrency, err := cmd.Flags().GetInt("max-concurrency")
	if err != nil {
		return fmt.Errorf("getting max-concurrency flag: %w", err)
	}
	if maxConcurrency < 1 {
		return errors.New("max-concurrency must be at least 1")
	}
	ephemeral, err := cmd.Flags().GetBool("ephemeral")
	if err != nil {
		return fmt.Errorf("getting ephemeral flag: %w", err)
	}

	return worker.Run(cmd.Context(), worker.RunConfig{
		TeamID:         strings.TrimSpace(teamID),
		APIBaseURL:     strings.TrimSpace(apiBaseURL),
		MaxConcurrency: maxConcurrency,
		Ephemeral:      ephemeral,
	}, cmd.OutOrStdout())
}
