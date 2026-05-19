package configcmd

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestConfigPushCommandPostsWorkflowConfig(t *testing.T) {
	cfgPath := writeConfigCommandFixture(t, "---\ntracker:\n  type: internal\n---\nPrompt.\n")
	var received map[string]string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "/v1/teams/team-1/config", r.URL.Path)
		assert.Equal(t, "Bearer test-token", r.Header.Get("Authorization"))
		assert.Equal(t, "application/json", r.Header.Get("Content-Type"))
		require.NoError(t, json.NewDecoder(r.Body).Decode(&received))
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"teamId":"team-1","version":7,"contentHash":"abc123","unchanged":false}`))
	}))
	t.Cleanup(server.Close)
	t.Cleanup(SetHTTPClient(server.Client()))

	cmd := NewCmd()
	out := new(bytes.Buffer)
	cmd.SetOut(out)
	cmd.SetErr(out)
	cmd.SetArgs([]string{
		"--api-url", server.URL,
		"--token", "test-token",
		"--team", "team-1",
		"push", cfgPath,
		"--created-by", "operator-1",
		"--notes", "initial import",
	})

	err := cmd.Execute()
	require.NoError(t, err)
	assert.Equal(t, map[string]string{
		"content_yaml": "---\ntracker:\n  type: internal\n---\nPrompt.\n",
		"created_by":   "operator-1",
		"notes":        "initial import",
	}, received)
	assert.Equal(t, "config created: team=team-1 version=7 hash=abc123\n", out.String())
}

func TestConfigImportMDCommandParsesAndPostsImportMetadata(t *testing.T) {
	cfgPath := writeConfigCommandFixture(t, "---\ntracker:\n  type: internal\n---\nFix it.\n")
	var received map[string]string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.NoError(t, json.NewDecoder(r.Body).Decode(&received))
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"teamId":"team-1","version":3,"contentHash":"def456","unchanged":true}`))
	}))
	t.Cleanup(server.Close)
	t.Cleanup(SetHTTPClient(server.Client()))

	cmd := NewCmd()
	out := new(bytes.Buffer)
	cmd.SetOut(out)
	cmd.SetErr(out)
	cmd.SetArgs([]string{
		"--api-url", server.URL,
		"--token", "test-token",
		"--team", "team-1",
		"import-md", cfgPath,
	})

	err := cmd.Execute()
	require.NoError(t, err)
	assert.Equal(t, "import", received["created_by"])
	assert.Equal(t, "imported from "+cfgPath, received["notes"])
	assert.Equal(t, "---\ntracker:\n  type: internal\n---\nFix it.\n", received["content_yaml"])
	assert.Equal(t, "config unchanged: team=team-1 version=3 hash=def456\n", out.String())
}

func TestConfigImportMDCommandRejectsInvalidWorkflowBeforePosting(t *testing.T) {
	cfgPath := writeConfigCommandFixture(t, "---\nmodel: [\n---\nPrompt.\n")
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		w.WriteHeader(http.StatusInternalServerError)
	}))
	t.Cleanup(server.Close)
	t.Cleanup(SetHTTPClient(server.Client()))

	cmd := NewCmd()
	out := new(bytes.Buffer)
	cmd.SetOut(out)
	cmd.SetErr(out)
	cmd.SetArgs([]string{
		"--api-url", server.URL,
		"--token", "test-token",
		"--team", "team-1",
		"import-md", cfgPath,
	})

	err := cmd.Execute()
	require.Error(t, err)
	assert.ErrorContains(t, err, "parsing workflow config")
	assert.Zero(t, requests)
}

func TestConfigPushCommandReportsStructuredAPIErrors(t *testing.T) {
	tests := []struct {
		name       string
		body       string
		wantErr    string
		statusCode int
	}{
		{
			name:       "field details",
			statusCode: http.StatusBadRequest,
			body:       `{"error":"config_invalid","details":[{"path":"tracker.type","message":"unknown tracker type"}]}`,
			wantErr:    "config api returned 400: config_invalid (tracker.type: unknown tracker type)",
		},
		{
			name:       "plain body",
			statusCode: http.StatusUnauthorized,
			body:       `unauthorized`,
			wantErr:    "config api returned 401: unauthorized",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfgPath := writeConfigCommandFixture(t, "---\ntracker:\n  type: internal\n---\nPrompt.\n")
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tt.statusCode)
				_, _ = w.Write([]byte(tt.body))
			}))
			t.Cleanup(server.Close)
			t.Cleanup(SetHTTPClient(server.Client()))

			cmd := NewCmd()
			out := new(bytes.Buffer)
			cmd.SetOut(out)
			cmd.SetErr(out)
			cmd.SetArgs([]string{
				"--api-url", server.URL,
				"--token", "test-token",
				"--team", "team-1",
				"push", cfgPath,
			})

			err := cmd.Execute()
			require.Error(t, err)
			assert.EqualError(t, err, tt.wantErr)
		})
	}
}

func TestConfigCommandUsesEnvironmentFallbacks(t *testing.T) {
	cfgPath := writeConfigCommandFixture(t, "---\ntracker:\n  type: internal\n---\nPrompt.\n")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "Bearer env-token", r.Header.Get("Authorization"))
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"teamId":"team-1","version":1,"contentHash":"hash","unchanged":false}`))
	}))
	t.Cleanup(server.Close)
	t.Cleanup(SetHTTPClient(server.Client()))
	t.Setenv("CONTRABASS_API_URL", server.URL)
	t.Setenv("CONTRABASS_API_TOKEN", "env-token")

	cmd := NewCmd()
	out := new(bytes.Buffer)
	cmd.SetOut(out)
	cmd.SetErr(out)
	cmd.SetArgs([]string{"--team", "team-1", "push", cfgPath})

	err := cmd.Execute()
	require.NoError(t, err)
	assert.Contains(t, out.String(), "config created")
}

func writeConfigCommandFixture(t *testing.T, content string) string {
	t.Helper()

	path := filepath.Join(t.TempDir(), "WORKFLOW.md")
	require.NoError(t, os.WriteFile(path, []byte(content), 0o600))
	return path
}
