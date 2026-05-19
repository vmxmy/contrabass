package initcmd

// This file is the exported boundary of the initcmd package. The scaffold
// templates stay unexported; only the symbols the CLI wiring layer and the
// package's own tests consume are re-exported here.

// CloudWorkflowTemplate is the default WORKFLOW.md scaffold for cloud-mode
// projects.
const CloudWorkflowTemplate = cloudWorkflowTemplate

// LocalWorkflowTemplate is the WORKFLOW.md scaffold for local-only projects.
const LocalWorkflowTemplate = localWorkflowTemplate
