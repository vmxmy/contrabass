package worker

import (
	"context"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path"
	"strings"

	workerv1 "github.com/junhoyeo/contrabass/internal/workerproto/v1"
)

const (
	workerArtifactLogsContentType = "application/x-ndjson"
	workerArtifactDiffContentType = "text/x-diff"
)

type workerArtifactFileSet struct {
	LogsPath        string
	DiffPath        string
	ScreenshotPaths []string
}

type workerArtifactUploader struct {
	client *http.Client
}

func newWorkerArtifactUploader(client *http.Client) *workerArtifactUploader {
	if client == nil {
		client = workerLoginHTTPClient
	}
	return &workerArtifactUploader{client: client}
}

func (u *workerArtifactUploader) UploadFiles(
	ctx context.Context,
	urls workerv1.WorkerDispatchFrameArtifactUploadURLs,
	files workerArtifactFileSet,
) (workerv1.ArtifactKeysPartial, error) {
	if u == nil {
		return workerv1.ArtifactKeysPartial{}, errors.New("worker artifact uploader is nil")
	}
	client := u.client
	if client == nil {
		client = http.DefaultClient
	}

	var keys workerv1.ArtifactKeysPartial
	if strings.TrimSpace(files.LogsPath) != "" {
		key, err := putWorkerArtifactFile(ctx, client, string(urls.Logs), files.LogsPath, workerArtifactLogsContentType)
		if err != nil {
			return workerv1.ArtifactKeysPartial{}, fmt.Errorf("upload logs artifact: %w", err)
		}
		keys.Logs = &key
	}
	if strings.TrimSpace(files.DiffPath) != "" {
		key, err := putWorkerArtifactFile(ctx, client, string(urls.Diff), files.DiffPath, workerArtifactDiffContentType)
		if err != nil {
			return workerv1.ArtifactKeysPartial{}, fmt.Errorf("upload diff artifact: %w", err)
		}
		keys.Diff = &key
	}
	for i, screenshotPath := range files.ScreenshotPaths {
		if strings.TrimSpace(screenshotPath) == "" {
			continue
		}
		if i >= len(urls.Screenshots) {
			return workerv1.ArtifactKeysPartial{}, fmt.Errorf("upload screenshot artifact %d: missing presigned URL", i+1)
		}
		key, err := putWorkerArtifactFile(ctx, client, string(urls.Screenshots[i]), screenshotPath, workerScreenshotContentType(screenshotPath))
		if err != nil {
			return workerv1.ArtifactKeysPartial{}, fmt.Errorf("upload screenshot artifact %d: %w", i+1, err)
		}
		keys.Screenshots = append(keys.Screenshots, key)
	}
	return keys, nil
}

func putWorkerArtifactFile(
	ctx context.Context,
	client *http.Client,
	putURL string,
	filePath string,
	contentType string,
) (workerv1.R2ObjectKey, error) {
	putURL = strings.TrimSpace(putURL)
	if putURL == "" {
		return "", errors.New("presigned PUT URL is required")
	}
	file, err := os.Open(filePath)
	if err != nil {
		return "", fmt.Errorf("open artifact file: %w", err)
	}
	defer file.Close()

	info, err := file.Stat()
	if err != nil {
		return "", fmt.Errorf("stat artifact file: %w", err)
	}
	key, err := workerR2ObjectKeyFromPresignedURL(putURL)
	if err != nil {
		return "", err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPut, putURL, file)
	if err != nil {
		return "", fmt.Errorf("create artifact PUT request: %w", err)
	}
	req.ContentLength = info.Size()
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}

	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("send artifact PUT request: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= http.StatusOK && resp.StatusCode < http.StatusMultipleChoices {
		return key, nil
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
	if len(body) > 0 {
		return "", fmt.Errorf("artifact PUT failed: HTTP %d: %s", resp.StatusCode, string(body))
	}
	return "", fmt.Errorf("artifact PUT failed: HTTP %d", resp.StatusCode)
}

func workerR2ObjectKeyFromPresignedURL(putURL string) (workerv1.R2ObjectKey, error) {
	parsed, err := url.Parse(putURL)
	if err != nil {
		return "", fmt.Errorf("parse presigned PUT URL: %w", err)
	}
	if parsed.Scheme == "" || parsed.Host == "" {
		return "", errors.New("presigned PUT URL must be absolute")
	}
	trimmedPath := strings.TrimPrefix(parsed.EscapedPath(), "/")
	parts := strings.SplitN(trimmedPath, "/", 2)
	if len(parts) != 2 || strings.TrimSpace(parts[1]) == "" {
		return "", errors.New("presigned PUT URL path does not include an R2 object key")
	}
	objectKey, err := url.PathUnescape(parts[1])
	if err != nil {
		return "", fmt.Errorf("decode R2 object key: %w", err)
	}
	if strings.HasPrefix(objectKey, "/") || strings.ContainsAny(objectKey, "\x00\r\n") {
		return "", errors.New("presigned PUT URL path contains an invalid R2 object key")
	}
	return workerv1.R2ObjectKey(objectKey), nil
}

func workerScreenshotContentType(filePath string) string {
	if contentType := mime.TypeByExtension(strings.ToLower(path.Ext(filePath))); contentType != "" {
		return contentType
	}
	return "application/octet-stream"
}
