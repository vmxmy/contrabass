package initcmd

import (
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
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

// Options configures a WORKFLOW.md scaffold write.
type Options struct {
	Output    string
	LocalOnly bool
	Force     bool
}

// WriteWorkflow scaffolds a starter WORKFLOW.md and reports next steps to out.
func WriteWorkflow(out io.Writer, opts Options) error {
	output := strings.TrimSpace(opts.Output)
	if output == "" {
		output = "WORKFLOW.md"
	}

	if !opts.Force {
		if _, statErr := os.Stat(output); statErr == nil {
			return fmt.Errorf("%s already exists; use --force to overwrite", output)
		} else if !errors.Is(statErr, os.ErrNotExist) {
			return fmt.Errorf("checking %s: %w", output, statErr)
		}
	}

	tmpl := cloudWorkflowTemplate
	if opts.LocalOnly {
		tmpl = localWorkflowTemplate
	}

	if err := os.WriteFile(output, []byte(tmpl), 0o644); err != nil {
		return fmt.Errorf("writing %s: %w", output, err)
	}

	_, _ = fmt.Fprintf(out, "wrote %s\n", output)
	if opts.LocalOnly {
		_, _ = fmt.Fprintln(out)
		_, _ = fmt.Fprintln(out, "local-only mode — start the local runtime with:")
		_, _ = fmt.Fprintf(out, "  contrabass team run --config %s\n", output)
	} else {
		_, _ = fmt.Fprintln(out)
		_, _ = fmt.Fprintln(out, "next steps:")
		_, _ = fmt.Fprintf(out, "  1. edit %s (set agent type, model, and prompt)\n", output)
		_, _ = fmt.Fprintln(out, "  2. contrabass migrate cloud --team <name>   (first-time seed)")
		_, _ = fmt.Fprintln(out, "  3. contrabass worker --team <name>           (start the worker)")
	}

	return nil
}
