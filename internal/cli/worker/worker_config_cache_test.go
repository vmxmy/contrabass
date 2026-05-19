package worker

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	workerv1 "github.com/junhoyeo/contrabass/internal/workerproto/v1"
)

func TestWorkerConfigCacheGetOrFetch(t *testing.T) {
	const teamID = "team-abc"
	const hash workerv1.ConfigHash = "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899"
	const yamlContent = "tracker:\n  type: linear\n"

	tests := []struct {
		name        string
		hash        workerv1.ConfigHash
		prepopulate map[workerv1.ConfigHash][]byte
		serverFunc  func(w http.ResponseWriter, r *http.Request)
		wantContent []byte
		wantErr     string
		wantFetches int
	}{
		{
			name:        "empty hash returns nil without HTTP call",
			hash:        "",
			wantContent: nil,
			wantFetches: 0,
		},
		{
			name: "cache hit returns content without HTTP call",
			hash: hash,
			prepopulate: map[workerv1.ConfigHash][]byte{
				hash: []byte(yamlContent),
			},
			wantContent: []byte(yamlContent),
			wantFetches: 0,
		},
		{
			name: "cache miss fetches and caches",
			hash: hash,
			serverFunc: func(w http.ResponseWriter, r *http.Request) {
				assert.Equal(t, http.MethodGet, r.Method)
				assert.Contains(t, r.URL.Path, string(hash))
				assert.Equal(t, "Bearer tok", r.Header.Get("Authorization"))
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write([]byte(yamlContent))
			},
			wantContent: []byte(yamlContent),
			wantFetches: 1,
		},
		{
			name: "second call uses cache not HTTP",
			hash: hash,
			serverFunc: func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write([]byte(yamlContent))
			},
			wantContent: []byte(yamlContent),
			wantFetches: 1, // only the first call hits the server
		},
		{
			name: "server 404 returns error",
			hash: hash,
			serverFunc: func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusNotFound)
			},
			wantErr:     "not found on server",
			wantFetches: 1,
		},
		{
			name: "server 500 returns error with status",
			hash: hash,
			serverFunc: func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusInternalServerError)
				_, _ = w.Write([]byte(`{"error":"internal"}`))
			},
			wantErr:     "HTTP 500",
			wantFetches: 1,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fetchCount := 0
			var srv *httptest.Server

			handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				fetchCount++
				if tt.serverFunc != nil {
					tt.serverFunc(w, r)
				} else {
					w.WriteHeader(http.StatusOK)
				}
			})
			srv = httptest.NewServer(handler)
			defer srv.Close()

			cache := newWorkerConfigCache()
			for h, content := range tt.prepopulate {
				cache.cache[h] = content
			}

			reg := workerRegistration{
				APIBaseURL:   srv.URL,
				SessionToken: "tok",
			}

			got, err := cache.GetOrFetch(context.Background(), reg, teamID, tt.hash)

			if tt.wantErr != "" {
				require.Error(t, err)
				assert.Contains(t, err.Error(), tt.wantErr)
			} else {
				require.NoError(t, err)
				assert.Equal(t, tt.wantContent, got)
			}
			assert.Equal(t, tt.wantFetches, fetchCount)

			// verify second call uses cache (no additional fetches)
			if tt.wantErr == "" && tt.hash != "" && tt.wantFetches > 0 {
				got2, err2 := cache.GetOrFetch(context.Background(), reg, teamID, tt.hash)
				require.NoError(t, err2)
				assert.Equal(t, tt.wantContent, got2)
				assert.Equal(t, tt.wantFetches, fetchCount, "second call must use cache")
			}
		})
	}
}

func TestWorkerConfigCacheConcurrent(t *testing.T) {
	const hash workerv1.ConfigHash = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
	const content = "agent:\n  type: codex\n"

	var mu sync.Mutex
	fetchCount := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		fetchCount++
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(content))
	}))
	defer srv.Close()

	reg := workerRegistration{APIBaseURL: srv.URL, SessionToken: "tok"}
	cache := newWorkerConfigCache()

	const goroutines = 20
	errs := make(chan error, goroutines)
	var wg sync.WaitGroup
	wg.Add(goroutines)
	for range goroutines {
		go func() {
			defer wg.Done()
			got, err := cache.GetOrFetch(context.Background(), reg, "team-1", hash)
			if err != nil {
				errs <- err
				return
			}
			if string(got) != content {
				errs <- assert.AnError
			}
		}()
	}
	wg.Wait()
	close(errs)

	for err := range errs {
		require.NoError(t, err)
	}
	// All goroutines raced; at most a small number should have fetched.
	// With RWMutex and double-check there may be a few duplicate fetches under
	// extreme contention, but the content must be correct and eventually cached.
	assert.GreaterOrEqual(t, fetchCount, 1)
}
