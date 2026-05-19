package main

import (
	"fmt"

	"github.com/spf13/cobra"

	"github.com/junhoyeo/contrabass/internal/cli/migrate"
)

var migrateCmd = &cobra.Command{
	Use:   "migrate",
	Short: "Migrate local Contrabass data",
}

var migrateCloudCmd = &cobra.Command{
	Use:   "cloud",
	Short: "Prepare local team state for cloud migration",
	RunE:  runMigrateCloud,
}

func init() {
	migrateCloudCmd.Flags().String("team", "", "team name to migrate from .contrabass/state/team/<name>")
	migrateCloudCmd.Flags().String("root", ".", "project root containing WORKFLOW.md and .contrabass")
	migrateCloudCmd.Flags().String("api-base-url", "", "cloud API base URL used to upload migration rows")
	migrateCloudCmd.Flags().String("token", "", "bearer token for cloud migration uploads")
	migrateCloudCmd.Flags().Bool("dry-run", false, "print the migration plan without uploading")
	_ = migrateCloudCmd.MarkFlagRequired("team")

	migrateCmd.AddCommand(migrateCloudCmd)
}

func runMigrateCloud(cmd *cobra.Command, _ []string) error {
	teamName, err := cmd.Flags().GetString("team")
	if err != nil {
		return fmt.Errorf("getting team flag: %w", err)
	}
	rootDir, err := cmd.Flags().GetString("root")
	if err != nil {
		return fmt.Errorf("getting root flag: %w", err)
	}
	apiBaseURL, err := cmd.Flags().GetString("api-base-url")
	if err != nil {
		return fmt.Errorf("getting api-base-url flag: %w", err)
	}
	authToken, err := cmd.Flags().GetString("token")
	if err != nil {
		return fmt.Errorf("getting token flag: %w", err)
	}
	dryRun, err := cmd.Flags().GetBool("dry-run")
	if err != nil {
		return fmt.Errorf("getting dry-run flag: %w", err)
	}

	return migrate.RunCloud(
		cmd.Context(),
		cmd.InOrStdin(),
		cmd.OutOrStdout(),
		teamName,
		rootDir,
		apiBaseURL,
		authToken,
		dryRun,
	)
}
