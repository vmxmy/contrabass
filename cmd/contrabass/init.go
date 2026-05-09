package main

import (
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/spf13/cobra"
)

// cloudWorkflowTemplate is the default WORKFLOW.md for new cloud-mode projects.
// Tracker credentials live in Cloudflare Secrets Store and are not included here.
const cloudWorkflowTemplate = `---
# Agent runtime to use for dispatched issues (codex, opencode, omc, omx).
agent:
  type: codex

# Tracker credentials live in the cloud control plane — no API keys here.
# Configure them at https://app.contrabass.dev → team settings.
#
# Push this file to the cloud after editing:
#   First time:  contrabass migrate cloud --team <name>
#   Updates:     contrabass config push WORKFLOW.md
---
# {{ issue.title }}

{{ issue.description }}

URL: {{ issue.url }}

## Instructions

- Implement the minimal change that satisfies the requirements above.
- Commit your work with a concise message (feat/fix/refactor: ...).
- Do not modify test files unless the issue is specifically about tests.
`

// localWorkflowTemplate is the WORKFLOW.md for local-only (single-host) projects.
// Requires a --local-only build of the binary; --local-only is a secondary path.
const localWorkflowTemplate = `---
max_concurrency: 2
tracker:
  type: internal
agent:
  type: codex
codex:
  approval_policy: auto-edit
  sandbox: none
---
# {{ issue.title }}

{{ issue.description }}

## Instructions

- Implement the minimal change that satisfies the requirements above.
- Commit your work with a concise message (feat/fix/refactor: ...).
- Do not modify test files unless the issue is specifically about tests.
`

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

	output = strings.TrimSpace(output)
	if output == "" {
		output = "WORKFLOW.md"
	}

	if !force {
		if _, statErr := os.Stat(output); statErr == nil {
			return fmt.Errorf("%s already exists; use --force to overwrite", output)
		} else if !errors.Is(statErr, os.ErrNotExist) {
			return fmt.Errorf("checking %s: %w", output, statErr)
		}
	}

	tmpl := cloudWorkflowTemplate
	if localOnly {
		tmpl = localWorkflowTemplate
	}

	if err := os.WriteFile(output, []byte(tmpl), 0o644); err != nil {
		return fmt.Errorf("writing %s: %w", output, err)
	}

	_, _ = fmt.Fprintf(cmd.OutOrStdout(), "wrote %s\n", output)
	if localOnly {
		_, _ = fmt.Fprintln(cmd.OutOrStdout())
		_, _ = fmt.Fprintln(cmd.OutOrStdout(), "local-only mode — start the local runtime with:")
		_, _ = fmt.Fprintf(cmd.OutOrStdout(), "  contrabass team run --config %s\n", output)
	} else {
		_, _ = fmt.Fprintln(cmd.OutOrStdout())
		_, _ = fmt.Fprintln(cmd.OutOrStdout(), "next steps:")
		_, _ = fmt.Fprintf(cmd.OutOrStdout(), "  1. edit %s (set agent type, model, and prompt)\n", output)
		_, _ = fmt.Fprintln(cmd.OutOrStdout(), "  2. contrabass migrate cloud --team <name>   (first-time seed)")
		_, _ = fmt.Fprintln(cmd.OutOrStdout(), "  3. contrabass worker --team <name>           (start the worker)")
	}

	return nil
}
