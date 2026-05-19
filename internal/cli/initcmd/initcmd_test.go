package initcmd

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestCloudTemplateIsValid(t *testing.T) {
	t.Parallel()

	// Confirm the cloud template contains valid YAML front matter delimiters.
	assert.True(t, strings.HasPrefix(CloudWorkflowTemplate, "---\n"),
		"cloud template must start with front matter")
	count := strings.Count(CloudWorkflowTemplate, "---")
	assert.GreaterOrEqual(t, count, 2, "cloud template must have opening and closing --- delimiters")
}

func TestLocalTemplateIsValid(t *testing.T) {
	t.Parallel()

	assert.True(t, strings.HasPrefix(LocalWorkflowTemplate, "---\n"),
		"local template must start with front matter")
	count := strings.Count(LocalWorkflowTemplate, "---")
	assert.GreaterOrEqual(t, count, 2, "local template must have opening and closing --- delimiters")
}
