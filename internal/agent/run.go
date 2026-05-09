package agent

import (
	"context"
	"errors"
	"fmt"

	"github.com/junhoyeo/contrabass/internal/types"
	"golang.org/x/sync/errgroup"
)

// Run starts an agent runner for one issue and waits until the process exits.
func Run(ctx context.Context, runner AgentRunner, issue types.Issue, workspace string, prompt string) error {
	if runner == nil {
		return errors.New("agent runner is nil")
	}

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	proc, err := runner.Start(ctx, issue, workspace, prompt)
	if err != nil {
		return fmt.Errorf("start agent process: %w", err)
	}
	if proc == nil {
		return errors.New("agent runner returned nil process")
	}

	g, gCtx := errgroup.WithContext(ctx)
	g.Go(func() error {
		for {
			select {
			case <-gCtx.Done():
				return nil
			case _, ok := <-proc.Events:
				if !ok {
					return nil
				}
			}
		}
	})
	g.Go(func() error {
		select {
		case <-gCtx.Done():
			return gCtx.Err()
		case err, ok := <-proc.Done:
			cancel()
			if !ok {
				return nil
			}
			return err
		}
	})

	return g.Wait()
}
