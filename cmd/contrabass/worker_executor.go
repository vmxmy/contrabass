package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/junhoyeo/contrabass/internal/agent"
	"github.com/junhoyeo/contrabass/internal/config"
	"github.com/junhoyeo/contrabass/internal/tmux"
	"github.com/junhoyeo/contrabass/internal/types"
	workerv1 "github.com/junhoyeo/contrabass/internal/workerproto/v1"
	"github.com/junhoyeo/contrabass/internal/workspace"
	"golang.org/x/sync/errgroup"
)

type workerRunExecutor struct {
	teamID       string
	workerID     string
	agentType    string
	tmuxCapable  bool
	workspaceMgr *workspace.Manager
	tmuxSession  *tmux.Session
	registration workerRegistration

	provision  func(context.Context, *workspace.Manager, types.Issue) (string, error)
	openPane   func(context.Context, *tmux.Session, string, string) (string, error)
	runAgent   func(context.Context, agent.AgentRunner, types.Issue, string, string) error
	newRunner  func(string) (agent.AgentRunner, error)
	postEvents workerEventPostFunc
}

type workerRunExecutorConfig struct {
	TeamID           string
	WorkerID         string
	Capabilities     []workerv1.Capability
	WorkspaceBaseDir string
	Registration     workerRegistration

	Provision  func(context.Context, *workspace.Manager, types.Issue) (string, error)
	OpenPane   func(context.Context, *tmux.Session, string, string) (string, error)
	RunAgent   func(context.Context, agent.AgentRunner, types.Issue, string, string) error
	NewRunner  func(string) (agent.AgentRunner, error)
	PostEvents workerEventPostFunc
}

func newWorkerRunExecutor(cfg workerRunExecutorConfig) (*workerRunExecutor, error) {
	agentType, err := selectWorkerAgentType(cfg.Capabilities)
	if err != nil {
		return nil, err
	}
	baseDir := strings.TrimSpace(cfg.WorkspaceBaseDir)
	if baseDir == "" {
		baseDir = "."
	}
	provision := cfg.Provision
	if provision == nil {
		provision = workspace.Provision
	}
	openPane := cfg.OpenPane
	if openPane == nil {
		openPane = tmux.OpenPane
	}
	runAgent := cfg.RunAgent
	newRunner := cfg.NewRunner
	if newRunner == nil {
		newRunner = newWorkerAgentRunner
	}
	postEvents := cfg.PostEvents
	if postEvents == nil && cfg.Registration.APIBaseURL != "" {
		registration := cfg.Registration
		postEvents = func(ctx context.Context, runID workerv1.RunID, events []workerv1.WorkerEventLine) error {
			return postWorkerEvents(ctx, registration, runID, events)
		}
	}

	return &workerRunExecutor{
		teamID:       strings.TrimSpace(cfg.TeamID),
		workerID:     strings.TrimSpace(cfg.WorkerID),
		agentType:    agentType,
		tmuxCapable:  workerHasCapability(cfg.Capabilities, "tmux"),
		workspaceMgr: workspace.NewManager(baseDir),
		tmuxSession:  tmux.NewSession(firstNonEmpty(strings.TrimSpace(cfg.TeamID), "worker"), nil),
		registration: cfg.Registration,
		provision:    provision,
		openPane:     openPane,
		runAgent:     runAgent,
		newRunner:    newRunner,
		postEvents:   postEvents,
	}, nil
}

func (e *workerRunExecutor) Run(ctx context.Context, frame workerv1.WorkerDispatchFrame) error {
	if e == nil {
		return errors.New("worker run executor is nil")
	}
	issue := workerIssueFromDispatch(frame)
	if issue.ID == "" {
		return errors.New("dispatch frame missing runId")
	}

	workspacePath, err := e.provision(ctx, e.workspaceMgr, issue)
	if err != nil {
		return fmt.Errorf("provision worker workspace for run %q: %w", frame.RunID, err)
	}
	if e.tmuxCapable {
		paneTitle := firstNonEmpty(string(frame.IssueRef), string(frame.RunID))
		if _, err := e.openPane(ctx, e.tmuxSession, paneTitle, workspacePath); err != nil {
			return fmt.Errorf("open tmux pane for run %q: %w", frame.RunID, err)
		}
	}

	runner, err := e.newRunner(e.agentType)
	if err != nil {
		return err
	}
	defer runner.Close()

	runAgent := e.runAgent
	if runAgent == nil {
		runAgent = e.runAgentWithEventUpload
	}
	if err := runAgent(ctx, runner, issue, workspacePath, frame.Prompt); err != nil {
		return fmt.Errorf("run agent for run %q: %w", frame.RunID, err)
	}
	return nil
}

func (e *workerRunExecutor) runAgentWithEventUpload(
	ctx context.Context,
	runner agent.AgentRunner,
	issue types.Issue,
	workspacePath string,
	prompt string,
) error {
	if runner == nil {
		return errors.New("agent runner is nil")
	}
	if e.postEvents == nil {
		return agent.Run(ctx, runner, issue, workspacePath, prompt)
	}

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	proc, err := runner.Start(ctx, issue, workspacePath, prompt)
	if err != nil {
		return fmt.Errorf("start agent process: %w", err)
	}
	if proc == nil {
		return errors.New("agent runner returned nil process")
	}

	batcher := newWorkerEventBatcher(e.postEvents)
	g, gCtx := errgroup.WithContext(ctx)
	g.Go(func() error {
		err := batcher.Consume(gCtx, workerv1.RunID(issue.ID), proc.Events)
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return nil
		}
		return err
	})
	g.Go(func() error {
		select {
		case <-gCtx.Done():
			return gCtx.Err()
		case err, ok := <-proc.Done:
			if !ok {
				return nil
			}
			if err != nil {
				cancel()
			}
			return err
		}
	})

	return g.Wait()
}

func workerIssueFromDispatch(frame workerv1.WorkerDispatchFrame) types.Issue {
	issueRef := strings.TrimSpace(string(frame.IssueRef))
	return types.Issue{
		ID:         strings.TrimSpace(string(frame.RunID)),
		Identifier: issueRef,
		Title:      issueRef,
		BranchName: strings.TrimSpace(string(frame.Branch)),
		State:      types.Running,
	}
}

func selectWorkerAgentType(capabilities []workerv1.Capability) (string, error) {
	for _, candidate := range []string{"codex", "opencode", "omx", "omc", "mock"} {
		if workerHasCapability(capabilities, "agent:"+candidate) {
			return candidate, nil
		}
	}
	return "", errors.New("worker has no agent runner capability")
}

func workerHasCapability(capabilities []workerv1.Capability, want string) bool {
	for _, capability := range capabilities {
		if string(capability) == want {
			return true
		}
	}
	return false
}

func newWorkerAgentRunner(agentType string) (agent.AgentRunner, error) {
	cfg := &config.WorkflowConfig{}
	timeout := time.Duration(cfg.AgentTimeoutMs()) * time.Millisecond

	switch agentType {
	case "codex":
		binaryPath := os.Getenv("CODEX_BINARY")
		if binaryPath == "" {
			binaryPath = cfg.CodexBinaryPath()
		}
		runner := agent.NewCodexRunner(binaryPath, cfg.CodexHandshakeTimeout())
		runner.WithOverloadParams(cfg.CodexOverloadRetryCap(), cfg.CodexOverloadStartDelay())
		if stallTimeoutMs := cfg.StallTimeoutMs(); stallTimeoutMs > 0 {
			runner.WithStreamReadTimeout(time.Duration(stallTimeoutMs) * time.Millisecond)
		}
		return runner, nil
	case "opencode":
		binaryPath := os.Getenv("OPENCODE_BINARY")
		if binaryPath == "" {
			binaryPath = cfg.OpenCodeBinaryPath()
		}
		password := os.Getenv("OPENCODE_SERVER_PASSWORD")
		if password == "" {
			password = cfg.OpenCodePassword()
		}
		username := os.Getenv("OPENCODE_SERVER_USERNAME")
		if username == "" {
			username = cfg.OpenCodeUsername()
		}
		return agent.NewOpenCodeRunner(binaryPath, cfg.OpenCodePort(), password, username, timeout), nil
	case "omx":
		omxCfg := cfg.Clone()
		if binaryPath := os.Getenv("OMX_BINARY"); binaryPath != "" {
			omxCfg.OMX.BinaryPath = binaryPath
		}
		return agent.NewOMXRunner(omxCfg, timeout), nil
	case "omc":
		omcCfg := cfg.Clone()
		if binaryPath := os.Getenv("OMC_BINARY"); binaryPath != "" {
			omcCfg.OMC.BinaryPath = binaryPath
		}
		return agent.NewOMCRunner(omcCfg, timeout), nil
	case "mock":
		return &agent.MockRunner{}, nil
	default:
		return nil, fmt.Errorf("unknown worker agent type: %q", agentType)
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}
