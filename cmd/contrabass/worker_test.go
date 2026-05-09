package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestWorkerCommandIsRegistered(t *testing.T) {
	cmd := newRootCmd()

	worker, _, err := cmd.Find([]string{"worker"})
	require.NoError(t, err)
	require.NotNil(t, worker)
	assert.Equal(t, "worker", worker.Name())
}

func TestWorkerCommandValidation(t *testing.T) {
	tests := []struct {
		name        string
		args        []string
		store       *fakeWorkerEnrollmentStore
		wantErr     string
		wantNoError bool
	}{
		{
			name:    "requires team flag",
			args:    []string{"worker"},
			wantErr: `required flag(s) "team" not set`,
		},
		{
			name:    "without enrollment instructs login",
			args:    []string{"worker", "--team", "my-team"},
			store:   &fakeWorkerEnrollmentStore{},
			wantErr: `run "contrabass worker login" first`,
		},
		{
			name: "with enrollment loads credential before registration",
			args: []string{"worker", "--team", "my-team"},
			store: &fakeWorkerEnrollmentStore{byTeam: map[string]workerEnrollment{
				"my-team": {
					TeamID:       "my-team",
					WorkerID:     "worker-1",
					RefreshToken: "refresh-token-123",
				},
			}},
			wantErr: `registration flow is not implemented yet`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.store != nil {
				restore := stubWorkerLoginDependencies(t, http.DefaultClient, tt.store)
				defer restore()
			}

			cmd := newRootCmd()
			buf := new(bytes.Buffer)
			cmd.SetOut(buf)
			cmd.SetErr(buf)
			cmd.SetArgs(tt.args)

			err := cmd.Execute()
			if tt.wantNoError {
				require.NoError(t, err)
				return
			}

			require.Error(t, err)
			assert.Contains(t, err.Error(), tt.wantErr)
		})
	}
}

func TestWorkerCommandHelpDocumentsEnrollment(t *testing.T) {
	cmd := newRootCmd()
	buf := new(bytes.Buffer)
	cmd.SetOut(buf)
	cmd.SetErr(buf)
	cmd.SetArgs([]string{"worker", "--help"})

	require.NoError(t, cmd.Execute())
	output := buf.String()
	assert.Contains(t, output, "--team")
	assert.Contains(t, output, `contrabass worker login`)
}

func TestWorkerLoginCommandEnrollsWithOneTimeCode(t *testing.T) {
	defer resetWorkerLoginFlagState()

	var requestBody map[string]string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, http.MethodPost, r.Method)
		assert.Equal(t, "/v1/workers/enroll", r.URL.Path)
		require.NoError(t, json.NewDecoder(r.Body).Decode(&requestBody))

		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"teamId": "team-1",
			"workerId": "worker-1",
			"refreshToken": "refresh-token-123",
			"protocol_version": "1.0.0"
		}`))
	}))
	defer server.Close()

	store := &fakeWorkerEnrollmentStore{}
	restore := stubWorkerLoginDependencies(t, server.Client(), store)
	defer restore()

	cmd := newRootCmd()
	buf := new(bytes.Buffer)
	cmd.SetOut(buf)
	cmd.SetErr(buf)
	cmd.SetArgs([]string{
		"worker", "login",
		"--code", "ABC-123",
		"--api-url", server.URL,
		"--worker-id", "worker-1",
	})

	require.NoError(t, cmd.Execute())
	assert.Equal(t, map[string]string{
		"code":             "ABC-123",
		"workerId":         "worker-1",
		"protocol_version": "1.0.0",
	}, requestBody)
	require.Len(t, store.enrollments, 1)
	assert.Equal(t, workerEnrollment{
		TeamID:       "team-1",
		WorkerID:     "worker-1",
		RefreshToken: "refresh-token-123",
	}, store.enrollments[0])
	assert.Contains(t, buf.String(), `Enrolled worker "worker-1" for team "team-1"`)
	assert.NotContains(t, buf.String(), "refresh-token-123")
}

func TestWorkerLoginCommandRejectsBadCode(t *testing.T) {
	defer resetWorkerLoginFlagState()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":"enrollment_invalid","protocol_version":"1.0.0"}`))
	}))
	defer server.Close()

	store := &fakeWorkerEnrollmentStore{}
	restore := stubWorkerLoginDependencies(t, server.Client(), store)
	defer restore()

	cmd := newRootCmd()
	buf := new(bytes.Buffer)
	cmd.SetOut(buf)
	cmd.SetErr(buf)
	cmd.SetArgs([]string{"worker", "login", "--code", "BAD-123", "--api-url", server.URL})

	err := cmd.Execute()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "enrollment code is invalid or expired")
	assert.Contains(t, err.Error(), "generate a fresh code")
	assert.Empty(t, store.enrollments)
}

func TestWorkerLoginCommandRequiresCode(t *testing.T) {
	resetWorkerLoginFlagState()
	defer resetWorkerLoginFlagState()

	cmd := newRootCmd()
	buf := new(bytes.Buffer)
	cmd.SetOut(buf)
	cmd.SetErr(buf)
	cmd.SetArgs([]string{"worker", "login"})

	err := cmd.Execute()
	require.Error(t, err)
	assert.Contains(t, err.Error(), `required flag(s) "code" not set`)
}

type fakeWorkerEnrollmentStore struct {
	enrollments []workerEnrollment
	byTeam      map[string]workerEnrollment
}

func (s *fakeWorkerEnrollmentStore) StoreWorkerEnrollment(_ context.Context, enrollment workerEnrollment) error {
	s.enrollments = append(s.enrollments, enrollment)
	if s.byTeam == nil {
		s.byTeam = make(map[string]workerEnrollment)
	}
	s.byTeam[enrollment.TeamID] = enrollment
	return nil
}

func (s *fakeWorkerEnrollmentStore) LoadWorkerEnrollment(_ context.Context, teamID string) (workerEnrollment, error) {
	enrollment, ok := s.byTeam[teamID]
	if !ok {
		return workerEnrollment{}, errWorkerEnrollmentNotFound
	}
	return enrollment, nil
}

func stubWorkerLoginDependencies(t *testing.T, client *http.Client, store workerEnrollmentStore) func() {
	t.Helper()

	oldClient := workerLoginHTTPClient
	oldStore := newWorkerLoginStore
	workerLoginHTTPClient = client
	newWorkerLoginStore = func() (workerEnrollmentStore, error) {
		return store, nil
	}

	return func() {
		workerLoginHTTPClient = oldClient
		newWorkerLoginStore = oldStore
	}
}

func resetWorkerLoginFlagState() {
	for _, name := range []string{"code", "api-url", "worker-id"} {
		flag := workerLoginCmd.Flags().Lookup(name)
		if flag == nil {
			continue
		}
		_ = flag.Value.Set(flag.DefValue)
		flag.Changed = false
	}
}
