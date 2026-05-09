package workspace

import (
	"context"
	"errors"

	"github.com/junhoyeo/contrabass/internal/types"
)

// Provision creates or reuses the git worktree for a dispatched run.
func Provision(ctx context.Context, manager *Manager, issue types.Issue) (string, error) {
	if manager == nil {
		return "", errors.New("workspace manager is nil")
	}
	return manager.Create(ctx, issue)
}
