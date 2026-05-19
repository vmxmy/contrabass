//go:build localonly

package team

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"time"

	"github.com/junhoyeo/contrabass/internal/agent"
	"github.com/junhoyeo/contrabass/internal/config"
	"github.com/junhoyeo/contrabass/internal/team"
	"github.com/junhoyeo/contrabass/internal/tmux"
)

// createRunner creates an AgentRunner based on the workflow config.
func createRunner(cfg *config.WorkflowConfig, teamName string, logger *slog.Logger) (agent.AgentRunner, error) {
	if err := cfg.ValidateWorkerMode(); err != nil {
		return nil, fmt.Errorf("invalid worker mode configuration: %w", err)
	}

	// Codex speaks JSONL over stdin/stdout and needs its own runner for the
	// initialize → thread/start → turn/start protocol. TmuxRunner cannot
	// drive this interaction, so codex always uses CodexRunner regardless of
	// worker_mode. Other agents (opencode, omx, omc, oh-my-opencode) can run
	// inside tmux panes because they are long-running servers or CLI tools
	// that accept a file/arg prompt.
	if cfg.AgentType() == "codex" || cfg.WorkerMode() != "tmux" {
		// Fall through to the per-agent-type switch below.
	} else if cfg.WorkerMode() == "tmux" {
		if !tmux.IsTmuxAvailable(context.Background(), nil) {
			return nil, errors.New("tmux worker mode requested, but tmux is not available in PATH")
		}

		session := tmux.NewSession(teamName, nil)
		registry := tmux.NewCLIRegistry()

		paths := team.NewPaths(cfg.TeamStateDir())
		store := team.NewStore(paths)
		heartbeat := team.NewHeartbeatMonitor(store, paths, time.Duration(cfg.TeamClaimLeaseSeconds())*time.Second)
		eventLogger := team.NewEventLogger(paths)
		dispatchQueue := team.NewDispatchQueue(store, paths, time.Duration(cfg.TeamClaimLeaseSeconds())*time.Second)

		// For tmux mode the CLIRegistry already knows the subcommand (e.g.
		// "app-server" for codex). If the user wrote "codex app-server" in
		// workflow.codex.binary_path we must extract just "codex" so the
		// registry's BuildArgs don't duplicate the subcommand.
		binaryPath := binaryPathForAgent(cfg)
		if fields := strings.Fields(binaryPath); len(fields) > 1 {
			binaryPath = fields[0]
		}

		return agent.NewTmuxRunner(agent.TmuxRunnerConfig{
			TeamName:         teamName,
			AgentType:        cfg.AgentType(),
			BinaryPath:       binaryPath,
			Session:          session,
			Registry:         registry,
			HeartbeatMonitor: heartbeat,
			EventLogger:      eventLogger,
			DispatchQueue:    dispatchQueue,
			PollInterval:     2 * time.Second,
			Logger:           logger,
		}), nil
	}

	switch cfg.AgentType() {
	case "codex":
		codexBin := os.Getenv("CODEX_BINARY")
		if codexBin == "" {
			codexBin = cfg.CodexBinaryPath()
		}
		runner := agent.NewCodexRunner(codexBin, cfg.CodexHandshakeTimeout())
		runner.WithOverloadParams(cfg.CodexOverloadRetryCap(), cfg.CodexOverloadStartDelay())
		if stallTimeoutMs := cfg.StallTimeoutMs(); stallTimeoutMs > 0 {
			runner.WithStreamReadTimeout(time.Duration(stallTimeoutMs) * time.Millisecond)
		}
		// Forward workflow-driven codex config so the spawned `codex app-server`
		// uses the workflow's model/approval_policy/sandbox instead of silently
		// inheriting whatever is in ~/.codex/config.toml. Empty fields are not
		// injected — codex falls back to its own defaults.
		runner.ConfigureCodex(agent.CodexRunnerOptions{
			Model:          cfg.Codex.Model,
			ApprovalPolicy: cfg.Codex.ApprovalPolicy,
			Sandbox:        cfg.Codex.Sandbox,
		})
		return runner, nil
	case "opencode":
		opencodeBin := os.Getenv("OPENCODE_BINARY")
		if opencodeBin == "" {
			opencodeBin = cfg.OpenCodeBinaryPath()
		}
		port := cfg.OpenCodePort()
		password := os.Getenv("OPENCODE_SERVER_PASSWORD")
		if password == "" {
			password = cfg.OpenCodePassword()
		}
		username := os.Getenv("OPENCODE_SERVER_USERNAME")
		if username == "" {
			username = cfg.OpenCodeUsername()
		}
		return agent.NewOpenCodeRunner(opencodeBin, port, password, username, 30*time.Second), nil
	case "omx":
		omxBin := os.Getenv("OMX_BINARY")
		if omxBin == "" {
			omxBin = cfg.OMXBinaryPath()
		}
		omxCfg := cfg.Clone()
		omxCfg.OMX.BinaryPath = omxBin
		return agent.NewOMXRunner(omxCfg, 30*time.Second), nil
	case "omc":
		omcBin := os.Getenv("OMC_BINARY")
		if omcBin == "" {
			omcBin = cfg.OMCBinaryPath()
		}
		omcCfg := cfg.Clone()
		omcCfg.OMC.BinaryPath = omcBin
		return agent.NewOMCRunner(omcCfg, 30*time.Second), nil
	case "oh-my-opencode":
		return agent.NewOhMyOpenCodeRunner(cfg, 30*time.Second)
	default:
		return nil, fmt.Errorf("unknown agent type: %q", cfg.AgentType())
	}
}

func binaryPathForAgent(cfg *config.WorkflowConfig) string {
	switch cfg.AgentType() {
	case "codex":
		if codexBin := os.Getenv("CODEX_BINARY"); codexBin != "" {
			return codexBin
		}
		return cfg.CodexBinaryPath()
	case "opencode":
		if opencodeBin := os.Getenv("OPENCODE_BINARY"); opencodeBin != "" {
			return opencodeBin
		}
		return cfg.OpenCodeBinaryPath()
	case "omx":
		if omxBin := os.Getenv("OMX_BINARY"); omxBin != "" {
			return omxBin
		}
		return cfg.OMXBinaryPath()
	case "omc":
		if omcBin := os.Getenv("OMC_BINARY"); omcBin != "" {
			return omcBin
		}
		return cfg.OMCBinaryPath()
	case "oh-my-opencode":
		if ohMyOpenCodeBin := os.Getenv("OH_MY_OPENCODE_BINARY"); ohMyOpenCodeBin != "" {
			return ohMyOpenCodeBin
		}
		return "oh-my-opencode"
	default:
		return ""
	}
}
