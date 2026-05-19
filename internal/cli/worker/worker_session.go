package worker

import (
	"context"
	"sync"
	"time"
)

// workerSessionRefreshInterval controls how often the session manager proactively
// refreshes the short-lived session token during a long-running soak. Overridable
// in tests. Set to 45 minutes so a ≤1-hour session token is refreshed before expiry.
var workerSessionRefreshInterval = 45 * time.Minute

// workerSessionManager holds a mutable, refreshable bearer token shared across all
// API call sites (heartbeat, events, ack, dispatch WS/long-poll). Without this,
// the static SessionToken in workerRegistration expires after ≤1 hour and every
// API call returns 401, crashing the worker mid-soak.
//
// All HTTP paths must call workerRegistration.currentToken() instead of reading
// registration.SessionToken directly.
type workerSessionManager struct {
	mu           sync.RWMutex
	sessionToken string
	refreshToken string
	apiBaseURL   string
}

func newWorkerSessionManager(reg workerRegistration) *workerSessionManager {
	return &workerSessionManager{
		sessionToken: reg.SessionToken,
		refreshToken: reg.RefreshToken,
		apiBaseURL:   reg.APIBaseURL,
	}
}

// CurrentToken returns the most recently refreshed session token.
func (m *workerSessionManager) CurrentToken() string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.sessionToken
}

// Refresh exchanges the stored refresh token for a new session token and updates
// the in-memory value. The caller must handle the error (e.g., log and retry).
func (m *workerSessionManager) Refresh(ctx context.Context) error {
	token, err := refreshWorkerSession(ctx, m.apiBaseURL, m.refreshToken)
	if err != nil {
		return err
	}
	m.mu.Lock()
	m.sessionToken = token
	m.mu.Unlock()
	return nil
}

// RunProactiveRefresh refreshes the session token on every interval until ctx is
// cancelled. A failed refresh is silently discarded — the token may still be valid
// until the next interval, after which the cloud returns 401 and the WS/long-poll
// reconnect will attempt another refresh via Refresh.
func (m *workerSessionManager) RunProactiveRefresh(ctx context.Context, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			_ = m.Refresh(ctx)
		}
	}
}
