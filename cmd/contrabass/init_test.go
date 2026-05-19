package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestInitCmd_CloudDefault(t *testing.T) {
	dir := t.TempDir()
	output := filepath.Join(dir, "WORKFLOW.md")

	cmd := newRootCmd()
	var stdout bytes.Buffer
	cmd.SetOut(&stdout)
	cmd.SetArgs([]string{"init", "--output", output})
	require.NoError(t, cmd.Execute())

	content, err := os.ReadFile(output)
	require.NoError(t, err)
	got := string(content)

	// cloud template must declare an agent section
	assert.Contains(t, got, "agent:")
	assert.Contains(t, got, "type: codex")
	// cloud template must NOT bake in a local tracker type
	assert.NotContains(t, got, "type: internal")
	// must include Liquid issue variables
	assert.Contains(t, got, "{{ issue.title }}")
	assert.Contains(t, got, "{{ issue.description }}")

	// stdout should tell the user the next steps
	out := stdout.String()
	assert.Contains(t, out, "wrote")
	assert.Contains(t, out, "next steps")
	assert.Contains(t, out, "contrabass worker")
}

func TestInitCmd_LocalOnly(t *testing.T) {
	dir := t.TempDir()
	output := filepath.Join(dir, "WORKFLOW.md")

	cmd := newRootCmd()
	cmd.SetArgs([]string{"init", "--output", output, "--local-only"})
	require.NoError(t, cmd.Execute())

	content, err := os.ReadFile(output)
	require.NoError(t, err)
	got := string(content)

	assert.Contains(t, got, "type: internal")
	assert.Contains(t, got, "{{ issue.title }}")
}

func TestInitCmd_ExistsNoForce(t *testing.T) {
	dir := t.TempDir()
	output := filepath.Join(dir, "WORKFLOW.md")
	require.NoError(t, os.WriteFile(output, []byte("existing"), 0o644))

	cmd := newRootCmd()
	cmd.SetArgs([]string{"init", "--output", output})
	err := cmd.Execute()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "already exists")

	// original file must be untouched
	raw, _ := os.ReadFile(output)
	assert.Equal(t, "existing", string(raw))
}

func TestInitCmd_Force(t *testing.T) {
	dir := t.TempDir()
	output := filepath.Join(dir, "WORKFLOW.md")
	require.NoError(t, os.WriteFile(output, []byte("existing"), 0o644))

	cmd := newRootCmd()
	cmd.SetArgs([]string{"init", "--output", output, "--force"})
	require.NoError(t, cmd.Execute())

	raw, err := os.ReadFile(output)
	require.NoError(t, err)
	assert.NotEqual(t, "existing", strings.TrimSpace(string(raw)))
	assert.Contains(t, string(raw), "agent:")
}

func TestInitCmd_DefaultOutputName(t *testing.T) {
	// Run from a temp dir so we don't litter the repo
	orig, err := os.Getwd()
	require.NoError(t, err)
	dir := t.TempDir()
	require.NoError(t, os.Chdir(dir))
	defer func() { _ = os.Chdir(orig) }()

	cmd := newRootCmd()
	cmd.SetArgs([]string{"init"})
	require.NoError(t, cmd.Execute())

	_, err = os.Stat("WORKFLOW.md")
	assert.NoError(t, err, "WORKFLOW.md should exist in cwd when --output is omitted")
}
