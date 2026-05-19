package configcmd

import (
	"fmt"
	"net/http"

	"github.com/spf13/cobra"
)

// This file is the exported boundary of the configcmd package. The cloud
// upload logic stays unexported; only the symbols the CLI wiring layer and
// the package's own tests consume are re-exported here.

// NewCmd builds the "config" Cobra command and its push/import-md subcommands.
func NewCmd() *cobra.Command {
	opts := &CloudOptions{}

	cmd := &cobra.Command{
		Use:   "config",
		Short: "Manage cloud workflow configuration",
	}
	cmd.PersistentFlags().StringVar(&opts.APIURL, "api-url", "", "Contrabass cloud API base URL (or CONTRABASS_API_URL)")
	cmd.PersistentFlags().StringVar(&opts.Token, "token", "", "Contrabass cloud API bearer token (or CONTRABASS_API_TOKEN)")
	cmd.PersistentFlags().StringVar(&opts.Team, "team", "", "cloud team id (required)")

	pushCmd := &cobra.Command{
		Use:   "push <path>",
		Short: "Push a workflow config file to the cloud config store",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			notes, err := cmd.Flags().GetString("notes")
			if err != nil {
				return fmt.Errorf("getting notes flag: %w", err)
			}
			createdBy, err := cmd.Flags().GetString("created-by")
			if err != nil {
				return fmt.Errorf("getting created-by flag: %w", err)
			}
			return Push(cmd.Context(), cmd.OutOrStdout(), opts, args[0], createdBy, notes)
		},
	}
	pushCmd.Flags().String("created-by", "cli", "creator recorded for the config version")
	pushCmd.Flags().String("notes", "", "audit notes recorded for the config version")

	importCmd := &cobra.Command{
		Use:   "import-md <path>",
		Short: "Import an existing WORKFLOW.md into the cloud config store",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return ImportMD(cmd.Context(), cmd.OutOrStdout(), opts, args[0])
		},
	}

	cmd.AddCommand(pushCmd, importCmd)
	return cmd
}

// SetHTTPClient overrides the HTTP client used for cloud uploads and returns a
// restore func. For test wiring only.
func SetHTTPClient(client *http.Client) func() {
	previous := configHTTPClient
	configHTTPClient = client
	return func() { configHTTPClient = previous }
}
