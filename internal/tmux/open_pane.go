package tmux

import "context"

// OpenPane ensures a tmux session exists, opens a run pane, and changes to workdir.
func OpenPane(ctx context.Context, session *Session, title string, workdir string) (string, error) {
	if err := session.CreateIfNotExists(ctx); err != nil {
		return "", err
	}
	paneID, err := session.NewWindow(ctx, title)
	if err != nil {
		return "", err
	}
	if err := session.SendKeys(ctx, paneID, "cd "+shellQuote(workdir), "C-m"); err != nil {
		return "", err
	}
	return paneID, nil
}
