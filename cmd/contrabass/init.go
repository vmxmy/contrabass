package main

import (
	"fmt"

	"github.com/spf13/cobra"

	"github.com/junhoyeo/contrabass/internal/cli/initcmd"
)

func newInitCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "init",
		Short: "Create a starter WORKFLOW.md in the current directory",
		Long: `Create a starter WORKFLOW.md for a new Contrabass project.

The default template targets cloud mode: tracker credentials live in the
Cloudflare control plane and the file is deployed with:

  contrabass migrate cloud --team <name>   (first-time seed)
  contrabass config push WORKFLOW.md       (subsequent updates)

Workers on developer machines pick up dispatched issues with:

  contrabass worker --team <name>

Use --local-only to generate a template for the legacy single-host runtime
instead (requires a --local-only build of the binary; supported but secondary).`,
		RunE: runInitWorkflow,
	}
	cmd.Flags().String("output", "WORKFLOW.md", "path to write the template file")
	cmd.Flags().Bool("local-only", false, "generate a local-only template (supported but secondary; requires LOCAL_ONLY build)")
	cmd.Flags().Bool("force", false, "overwrite an existing file")
	return cmd
}

func runInitWorkflow(cmd *cobra.Command, _ []string) error {
	output, err := cmd.Flags().GetString("output")
	if err != nil {
		return fmt.Errorf("getting output flag: %w", err)
	}
	localOnly, err := cmd.Flags().GetBool("local-only")
	if err != nil {
		return fmt.Errorf("getting local-only flag: %w", err)
	}
	force, err := cmd.Flags().GetBool("force")
	if err != nil {
		return fmt.Errorf("getting force flag: %w", err)
	}

	return initcmd.WriteWorkflow(cmd.OutOrStdout(), initcmd.Options{
		Output:    output,
		LocalOnly: localOnly,
		Force:     force,
	})
}
