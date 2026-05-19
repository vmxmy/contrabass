//go:build localonly

package team

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/junhoyeo/contrabass/internal/config"
	"github.com/junhoyeo/contrabass/internal/team"
	"github.com/junhoyeo/contrabass/internal/tracker"
	"github.com/junhoyeo/contrabass/internal/types"
	"github.com/junhoyeo/contrabass/internal/workspace"
)

type runOptions struct {
	ConfigPath string
	TeamName   string
	TasksPath  string
	IssueID    string
	MaxWorkers int
	WorkerMode string
}

type runHooks struct {
	ParentContext        context.Context
	EventHandlers        []eventHandler
	DisableSignalHandler bool
}

func logTeamEvents(ctx context.Context, logger *slog.Logger, events <-chan types.TeamEvent) {
	for {
		select {
		case <-ctx.Done():
			return
		case event, ok := <-events:
			if !ok {
				return
			}
			logger.Info("team event",
				"type", event.Type,
				"team", event.TeamName,
				"data", event.Data,
			)
		}
	}
}

func runTeamWithOptions(opts runOptions) error {
	return runTeamWithHooks(opts, runHooks{})
}

func runTeamWithHooks(opts runOptions, hooks runHooks) error {
	switch {
	case opts.TasksPath != "" && opts.IssueID != "":
		return errors.New("provide either --tasks or --issue, not both")
	case opts.TasksPath == "" && opts.IssueID == "":
		return errors.New("either --tasks or --issue is required")
	case opts.TeamName == "" && opts.IssueID == "":
		return errors.New("team name is required when running from --tasks")
	}

	// 1. Parse config
	cfg, err := config.ParseWorkflow(opts.ConfigPath)
	if err != nil {
		return fmt.Errorf("parsing workflow config: %w", err)
	}

	if opts.WorkerMode != "" {
		cfg.Team.WorkerMode = opts.WorkerMode
	}

	var tasks []types.TeamTask
	var boardSyncer *boardIssueSyncer
	teamName := opts.TeamName
	if opts.IssueID != "" {
		if cfg.TrackerType() != "internal" && cfg.TrackerType() != "local" {
			return fmt.Errorf("team run --issue requires tracker.type internal/local, got %q", cfg.TrackerType())
		}

		localTracker := tracker.NewLocalTracker(tracker.LocalConfig{
			BoardDir:    cfg.LocalBoardDir(),
			IssuePrefix: cfg.LocalIssuePrefix(),
		})

		issue, err := localTracker.GetIssue(context.Background(), opts.IssueID)
		if err != nil {
			return fmt.Errorf("loading internal board issue %q: %w", opts.IssueID, err)
		}

		if teamName == "" {
			teamName = resolveTeamNameForIssue(issue, "")
		}
		localTracker = tracker.NewLocalTracker(tracker.LocalConfig{
			BoardDir:    cfg.LocalBoardDir(),
			IssuePrefix: cfg.LocalIssuePrefix(),
			Actor:       "team:" + teamName,
		})
		childIssues, err := localTracker.ListChildIssues(context.Background(), issue.ID)
		if err != nil {
			return fmt.Errorf("loading child issues for %q: %w", opts.IssueID, err)
		}

		teamPlan := buildBoardTeamPlan(issue, childIssues)
		tasks = teamPlan.Tasks
		boardSyncer = newBoardIssueSyncer(localTracker, opts.IssueID, teamName, teamPlan.TaskIssueIDs)
	} else {
		// 4. Read tasks JSON file
		tasksData, err := os.ReadFile(opts.TasksPath)
		if err != nil {
			return fmt.Errorf("reading tasks file: %w", err)
		}

		if err := json.Unmarshal(tasksData, &tasks); err != nil {
			return fmt.Errorf("unmarshalling tasks: %w", err)
		}
	}

	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))

	repoPath, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("getting working directory: %w", err)
	}
	workspaceMgr := workspace.NewManager(repoPath)

	runner, err := createRunner(cfg, teamName, logger)
	if err != nil {
		return fmt.Errorf("creating agent runner: %w", err)
	}
	defer runner.Close()

	// 6. Create coordinator
	coordinator := team.NewCoordinator(teamName, cfg, runner, workspaceMgr, logger)

	// 7. Create TeamConfig
	teamCfg := types.TeamConfig{
		MaxWorkers:        cfg.TeamMaxWorkers(),
		MaxFixLoops:       cfg.TeamMaxFixLoops(),
		ClaimLeaseSeconds: cfg.TeamClaimLeaseSeconds(),
		StateDir:          cfg.TeamStateDir(),
		AgentType:         cfg.AgentType(),
		BoardIssueID:      opts.IssueID,
	}

	// Override max workers if provided — update both teamCfg and the parsed
	// config so that Coordinator.runExecPhase (which reads c.cfg.TeamMaxWorkers())
	// sees the CLI override.
	if opts.MaxWorkers > 0 {
		teamCfg.MaxWorkers = opts.MaxWorkers
		cfg.Team.MaxWorkers = opts.MaxWorkers
	}

	// 8. Initialize team
	if err := coordinator.Initialize(teamCfg); err != nil {
		return fmt.Errorf("initializing team: %w", err)
	}

	// 9. Set up signal handling
	parentCtx := hooks.ParentContext
	if parentCtx == nil {
		parentCtx = context.Background()
	}

	ctx, cancel := context.WithCancel(parentCtx)
	defer cancel()

	signalChan := make(chan os.Signal, 1)
	if !hooks.DisableSignalHandler {
		signal.Notify(signalChan, os.Interrupt, syscall.SIGTERM)
		defer signal.Stop(signalChan)

		go func() {
			select {
			case <-ctx.Done():
				return
			case <-signalChan:
				logger.Info("received signal, cancelling team")
				cancel()
			}
		}()
	}

	// 10. Start event consumer goroutine
	handlers := append([]eventHandler{}, hooks.EventHandlers...)
	if boardSyncer != nil {
		if err := boardSyncer.Start(ctx); err != nil {
			return fmt.Errorf("starting board sync: %w", err)
		}
		handlers = append(handlers, boardSyncer.HandleEvent)
	}
	var eventsDone <-chan struct{}
	if len(handlers) == 0 {
		go logTeamEvents(ctx, logger, coordinator.Events)
	} else {
		eventsDone = consumeTeamEvents(ctx, logger, coordinator.Events, handlers...)
	}

	// 11. Run team — coordinator.Run closes Events on return, which
	// causes consumeTeamEvents to drain remaining events and signal done.
	runErr := coordinator.Run(ctx, tasks)

	// Wait for event consumer to finish processing all buffered events
	// (including pipeline_completed) before calling Finalize. This
	// eliminates the race where both HandleEvent and Finalize update
	// board issue state simultaneously.
	if eventsDone != nil {
		<-eventsDone
	}

	if boardSyncer != nil {
		boardSyncer.Finalize(context.Background(), runErr)
	}

	if runErr != nil {
		return fmt.Errorf("running team: %w", runErr)
	}
	return nil
}

// showTeamStatus displays the current status of a team.
func showTeamStatus(cfgPath, teamName string) error {
	// Parse config
	cfg, err := config.ParseWorkflow(cfgPath)
	if err != nil {
		return fmt.Errorf("parsing workflow config: %w", err)
	}

	// Create paths and store
	paths := team.NewPaths(cfg.TeamStateDir())
	store := team.NewStore(paths)

	// Load manifest
	manifest, err := store.LoadManifest(teamName)
	if err != nil {
		return fmt.Errorf("loading team manifest: %w", err)
	}

	// Load phase state
	phaseState, err := store.LoadPhaseState(teamName)
	if err != nil {
		return fmt.Errorf("loading phase state: %w", err)
	}

	// Create task registry to list tasks
	tasks := team.NewTaskRegistry(store, paths, cfg.TeamClaimLeaseSeconds())
	taskList, err := tasks.ListTasks(teamName)
	if err != nil {
		return fmt.Errorf("listing tasks: %w", err)
	}

	// Build status response
	status := team.TeamStatus{
		TeamName:     teamName,
		BoardIssueID: manifest.Config.BoardIssueID,
		Phase:        phaseState.Phase,
		Workers:      manifest.Workers,
		Tasks:        taskList,
		FixLoopCount: phaseState.FixLoopCount,
	}

	// Marshal and print as JSON
	statusJSON, err := json.MarshalIndent(status, "", "  ")
	if err != nil {
		return fmt.Errorf("marshalling status: %w", err)
	}

	fmt.Println(string(statusJSON))
	return nil
}

// cancelTeam cancels a running team.
func cancelTeam(cfgPath, teamName string) error {
	// Parse config
	cfg, err := config.ParseWorkflow(cfgPath)
	if err != nil {
		return fmt.Errorf("parsing workflow config: %w", err)
	}

	// Create paths and store
	paths := team.NewPaths(cfg.TeamStateDir())
	store := team.NewStore(paths)

	// Create phase machine
	tasks := team.NewTaskRegistry(store, paths, cfg.TeamClaimLeaseSeconds())
	phases := team.NewPhaseMachine(store, tasks, cfg.TeamMaxFixLoops())

	// Cancel the team
	if err := phases.Cancel(teamName, "cancelled by user"); err != nil {
		return fmt.Errorf("cancelling team: %w", err)
	}

	fmt.Printf("Team %q cancelled successfully\n", teamName)
	return nil
}
