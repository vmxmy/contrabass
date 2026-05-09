package main

import (
	"fmt"

	"github.com/spf13/cobra"
)

type workerOptions struct {
	TeamID string
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
	_ = workerCmd.MarkFlagRequired("team")
	workerCmd.AddCommand(workerLoginCmd)
}

func runWorker(cmd *cobra.Command, _ []string) error {
	opts, err := workerOptionsFromFlags(cmd)
	if err != nil {
		return err
	}

	return fmt.Errorf("worker enrollment not found for team %q; run \"contrabass worker login\" first", opts.TeamID)
}

func workerOptionsFromFlags(cmd *cobra.Command) (workerOptions, error) {
	teamID, err := cmd.Flags().GetString("team")
	if err != nil {
		return workerOptions{}, fmt.Errorf("getting team flag: %w", err)
	}

	return workerOptions{TeamID: teamID}, nil
}
