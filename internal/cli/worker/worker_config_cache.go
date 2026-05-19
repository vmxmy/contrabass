package worker

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sync"

	workerv1 "github.com/junhoyeo/contrabass/internal/workerproto/v1"
)

// workerConfigCache caches workflow YAML by content-addressable ConfigHash.
// Hashes are immutable by design (content-addressable), so cached entries
// are never invalidated — a hash always resolves to the same bytes.
type workerConfigCache struct {
	mu    sync.RWMutex
	cache map[workerv1.ConfigHash][]byte
}

func newWorkerConfigCache() *workerConfigCache {
	return &workerConfigCache{
		cache: make(map[workerv1.ConfigHash][]byte),
	}
}

// GetOrFetch returns the workflow YAML for hash. Returns nil bytes when hash
// is empty (dispatch frames from older server versions may omit configHash).
// On a cache miss the content is fetched from GET /v1/teams/{teamId}/config/{hash}
// and stored for subsequent calls with the same hash.
func (c *workerConfigCache) GetOrFetch(
	ctx context.Context,
	registration workerRegistration,
	teamID string,
	hash workerv1.ConfigHash,
) ([]byte, error) {
	if hash == "" {
		return nil, nil
	}

	c.mu.RLock()
	cached, hit := c.cache[hash]
	c.mu.RUnlock()
	if hit {
		return cached, nil
	}

	content, err := fetchWorkerConfig(ctx, registration, teamID, hash)
	if err != nil {
		return nil, err
	}

	c.mu.Lock()
	c.cache[hash] = content
	c.mu.Unlock()
	return content, nil
}

func fetchWorkerConfig(
	ctx context.Context,
	registration workerRegistration,
	teamID string,
	hash workerv1.ConfigHash,
) ([]byte, error) {
	endpoint, err := workerAPIEndpoint(
		registration.APIBaseURL,
		"/v1/teams/"+url.PathEscape(teamID)+"/config/"+url.PathEscape(string(hash)),
	)
	if err != nil {
		return nil, fmt.Errorf("building config fetch URL for hash %q: %w", hash, err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("creating config fetch request for hash %q: %w", hash, err)
	}
	req.Header.Set("Authorization", "Bearer "+registration.SessionToken)
	req.Header.Set("Accept", "application/yaml, text/yaml, application/json")

	resp, err := workerLoginHTTPClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetching config %q: %w", hash, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		return nil, fmt.Errorf("config hash %q not found on server", hash)
	}
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		if len(body) > 0 {
			return nil, fmt.Errorf("fetching config %q: HTTP %d: %s", hash, resp.StatusCode, string(body))
		}
		return nil, fmt.Errorf("fetching config %q: HTTP %d", hash, resp.StatusCode)
	}

	// 1 MiB guard: workflow YAML should never be this large in practice.
	const maxConfigBytes = 1 << 20
	content, err := io.ReadAll(io.LimitReader(resp.Body, maxConfigBytes))
	if err != nil {
		return nil, fmt.Errorf("reading config %q response: %w", hash, err)
	}
	return content, nil
}
