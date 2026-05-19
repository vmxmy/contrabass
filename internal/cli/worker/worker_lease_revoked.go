package worker

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	workerv1 "github.com/junhoyeo/contrabass/internal/workerproto/v1"
)

var workerLeaseRevokedGracePeriod = 5 * time.Second

// errLeaseRevoked is set as the context cancellation cause when the heartbeat
// API confirms the server has revoked the lease for a run.
var errLeaseRevoked = errors.New("lease revoked by cloud")

// decodeLeaseRevokedFrame unmarshals a "lease-revoked" WebSocket frame.
func decodeLeaseRevokedFrame(data []byte) (workerv1.LeaseRevokedFrame, error) {
	var frame workerv1.LeaseRevokedFrame
	if err := json.Unmarshal(data, &frame); err != nil {
		return workerv1.LeaseRevokedFrame{}, fmt.Errorf("decoding lease-revoked frame: %w", err)
	}
	if frame.RunID == "" {
		return workerv1.LeaseRevokedFrame{}, errors.New("lease-revoked frame missing runId")
	}
	return frame, nil
}

// signalProcess sends sig to the OS process identified by pid. pid ≤ 0 is a
// no-op so callers need not guard against zero/invalid PIDs.
func signalProcess(pid int, sig os.Signal) error {
	if pid <= 0 {
		return nil
	}
	proc, err := os.FindProcess(pid)
	if err != nil {
		return fmt.Errorf("find process %d: %w", pid, err)
	}
	return proc.Signal(sig)
}

// collectPartialArtifacts scans workspacePath for artifact files that may have
// been written by the agent before it was stopped. Files that do not exist are
// silently omitted; the uploader skips empty paths.
func collectPartialArtifacts(workspacePath string) workerArtifactFileSet {
	var files workerArtifactFileSet

	logsPath := filepath.Join(workspacePath, "logs.ndjson")
	if _, err := os.Stat(logsPath); err == nil {
		files.LogsPath = logsPath
	}

	diffPath := filepath.Join(workspacePath, "diff.patch")
	if _, err := os.Stat(diffPath); err == nil {
		files.DiffPath = diffPath
	}

	matches, _ := filepath.Glob(filepath.Join(workspacePath, "screenshots", "*"))
	sort.Strings(matches)
	for _, match := range matches {
		ext := strings.ToLower(filepath.Ext(match))
		switch ext {
		case ".png", ".jpg", ".jpeg", ".webp":
			files.ScreenshotPaths = append(files.ScreenshotPaths, match)
		}
	}

	return files
}
