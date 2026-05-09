package main

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	workerv1 "github.com/junhoyeo/contrabass/internal/workerproto/v1"
)

func TestWorkerArtifactUploaderUploadsFilesToPresignedURLs(t *testing.T) {
	tempDir := t.TempDir()
	logsPath := writeWorkerArtifactTestFile(t, tempDir, "logs.ndjson", []byte("{\"kind\":\"log\"}\n"))
	diffPath := writeWorkerArtifactTestFile(t, tempDir, "diff.patch", []byte("diff --git a/a b/a\n"))
	screenshotPath := writeWorkerArtifactTestFile(t, tempDir, "screen.png", []byte("PNG"))

	got := make(map[string]struct {
		contentType string
		body        string
	})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, http.MethodPut, r.Method)
		body, err := io.ReadAll(r.Body)
		require.NoError(t, err)
		got[r.URL.Path] = struct {
			contentType string
			body        string
		}{contentType: r.Header.Get("Content-Type"), body: string(body)}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	keys, err := newWorkerArtifactUploader(server.Client()).UploadFiles(context.Background(), workerv1.WorkerDispatchFrameArtifactUploadURLs{
		Logs:        workerv1.URL(server.URL + "/contrabass-artifacts/teams/team-1/runs/run-1/artifacts/logs.ndjson?X-Amz-Signature=logs"),
		Diff:        workerv1.URL(server.URL + "/contrabass-artifacts/teams/team-1/runs/run-1/artifacts/diff.patch?X-Amz-Signature=diff"),
		Screenshots: []workerv1.URL{workerv1.URL(server.URL + "/contrabass-artifacts/teams/team-1/runs/run-1/artifacts/screenshots/01.png?X-Amz-Signature=screen")},
	}, workerArtifactFileSet{
		LogsPath:        logsPath,
		DiffPath:        diffPath,
		ScreenshotPaths: []string{screenshotPath},
	})
	require.NoError(t, err)
	require.NotNil(t, keys.Logs)
	require.NotNil(t, keys.Diff)
	assert.Equal(t, workerv1.R2ObjectKey("teams/team-1/runs/run-1/artifacts/logs.ndjson"), *keys.Logs)
	assert.Equal(t, workerv1.R2ObjectKey("teams/team-1/runs/run-1/artifacts/diff.patch"), *keys.Diff)
	assert.Equal(t, []workerv1.R2ObjectKey{"teams/team-1/runs/run-1/artifacts/screenshots/01.png"}, keys.Screenshots)

	assert.Equal(t, workerArtifactLogsContentType, got["/contrabass-artifacts/teams/team-1/runs/run-1/artifacts/logs.ndjson"].contentType)
	assert.Equal(t, "{\"kind\":\"log\"}\n", got["/contrabass-artifacts/teams/team-1/runs/run-1/artifacts/logs.ndjson"].body)
	assert.Equal(t, workerArtifactDiffContentType, got["/contrabass-artifacts/teams/team-1/runs/run-1/artifacts/diff.patch"].contentType)
	assert.Equal(t, "diff --git a/a b/a\n", got["/contrabass-artifacts/teams/team-1/runs/run-1/artifacts/diff.patch"].body)
	assert.Equal(t, "image/png", got["/contrabass-artifacts/teams/team-1/runs/run-1/artifacts/screenshots/01.png"].contentType)
	assert.Equal(t, "PNG", got["/contrabass-artifacts/teams/team-1/runs/run-1/artifacts/screenshots/01.png"].body)
}

func TestWorkerArtifactUploaderAllowsPartialUploads(t *testing.T) {
	tempDir := t.TempDir()
	logsPath := writeWorkerArtifactTestFile(t, tempDir, "logs.ndjson", []byte("log\n"))

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "/bucket/teams/team-1/runs/run-1/artifacts/logs.ndjson", r.URL.Path)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	keys, err := newWorkerArtifactUploader(server.Client()).UploadFiles(context.Background(), workerv1.WorkerDispatchFrameArtifactUploadURLs{
		Logs: workerv1.URL(server.URL + "/bucket/teams/team-1/runs/run-1/artifacts/logs.ndjson"),
	}, workerArtifactFileSet{LogsPath: logsPath})
	require.NoError(t, err)
	require.NotNil(t, keys.Logs)
	assert.Equal(t, workerv1.R2ObjectKey("teams/team-1/runs/run-1/artifacts/logs.ndjson"), *keys.Logs)
	assert.Nil(t, keys.Diff)
	assert.Empty(t, keys.Screenshots)
}

func TestWorkerArtifactUploaderReportsPutErrors(t *testing.T) {
	tempDir := t.TempDir()
	logsPath := writeWorkerArtifactTestFile(t, tempDir, "logs.ndjson", []byte("log\n"))
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "signature expired", http.StatusForbidden)
	}))
	defer server.Close()

	_, err := newWorkerArtifactUploader(server.Client()).UploadFiles(context.Background(), workerv1.WorkerDispatchFrameArtifactUploadURLs{
		Logs: workerv1.URL(server.URL + "/bucket/teams/team-1/runs/run-1/artifacts/logs.ndjson"),
	}, workerArtifactFileSet{LogsPath: logsPath})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "upload logs artifact")
	assert.Contains(t, err.Error(), "HTTP 403")
	assert.Contains(t, err.Error(), "signature expired")
}

func TestWorkerR2ObjectKeyFromPresignedURL(t *testing.T) {
	tests := []struct {
		name    string
		putURL  string
		want    workerv1.R2ObjectKey
		wantErr string
	}{
		{
			name:   "extracts key after bucket path segment",
			putURL: "https://example.test/contrabass-artifacts/teams/team%201/runs/run%2B1/artifacts/diff.patch?X-Amz-Signature=abc",
			want:   "teams/team 1/runs/run+1/artifacts/diff.patch",
		},
		{
			name:    "requires absolute URL",
			putURL:  "/bucket/key",
			wantErr: "must be absolute",
		},
		{
			name:    "requires object key after bucket",
			putURL:  "https://example.test/bucket",
			wantErr: "does not include an R2 object key",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := workerR2ObjectKeyFromPresignedURL(tt.putURL)
			if tt.wantErr != "" {
				require.Error(t, err)
				assert.Contains(t, err.Error(), tt.wantErr)
				return
			}
			require.NoError(t, err)
			assert.Equal(t, tt.want, got)
		})
	}
}

func writeWorkerArtifactTestFile(t *testing.T, dir string, name string, body []byte) string {
	t.Helper()
	filePath := filepath.Join(dir, name)
	require.NoError(t, os.WriteFile(filePath, body, 0o600))
	return filePath
}
