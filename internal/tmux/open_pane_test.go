package tmux

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestOpenPaneCreatesSessionWindowAndChangesDirectory(t *testing.T) {
	runner := &MockRunner{results: map[string]mockResult{
		"tmux has-session -t contrabass-team":                            {err: assert.AnError},
		"tmux new-session -d -s contrabass-team":                         {},
		"tmux new-window -t contrabass-team -n LIN-123 -P -F #{pane_id}": {output: []byte("%3\n")},
		"tmux send-keys -t %3 cd '/tmp/work tree' C-m":                   {},
	}}
	session := NewSession("team", runner)

	paneID, err := OpenPane(context.Background(), session, "LIN-123", "/tmp/work tree")
	require.NoError(t, err)

	assert.Equal(t, "%3", paneID)
	require.Len(t, runner.calls, 5)
	assert.Equal(t, []string{"has-session", "-t", "contrabass-team"}, runner.calls[0].args)
	assert.Equal(t, []string{"has-session", "-t", "contrabass-team"}, runner.calls[1].args)
	assert.Equal(t, []string{"new-session", "-d", "-s", "contrabass-team"}, runner.calls[2].args)
	assert.Equal(t, []string{"new-window", "-t", "contrabass-team", "-n", "LIN-123", "-P", "-F", "#{pane_id}"}, runner.calls[3].args)
	assert.Equal(t, []string{"send-keys", "-t", "%3", "cd '/tmp/work tree'", "C-m"}, runner.calls[4].args)
}
