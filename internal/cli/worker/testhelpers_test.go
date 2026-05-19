package worker

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
)

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

func stubWorkerLookupPath(lookup func(string) (string, error)) func() {
	oldLookup := workerLookupPath
	workerLookupPath = lookup
	return func() {
		workerLookupPath = oldLookup
	}
}

func stubWorkerDispatchConsumer(consumer func(context.Context, workerRegistration, workerDispatchHandler, workerLeaseRevokedHandler) error) func() {
	oldConsumer := workerDispatchConsumer
	workerDispatchConsumer = consumer
	return func() {
		workerDispatchConsumer = oldConsumer
	}
}

func missingWorkerLookupPath(string) (string, error) {
	return "", errors.New("not found")
}

func filterWorkerCapabilitiesForTest(raw any, excludedPrefixes ...string) []any {
	values, ok := raw.([]any)
	if !ok {
		return nil
	}
	filtered := make([]any, 0, len(values))
	for _, value := range values {
		text, ok := value.(string)
		if !ok {
			continue
		}
		excluded := false
		for _, prefix := range excludedPrefixes {
			if strings.HasPrefix(text, prefix) {
				excluded = true
				break
			}
		}
		if !excluded {
			filtered = append(filtered, text)
		}
	}
	return filtered
}
