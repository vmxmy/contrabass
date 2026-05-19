package worker

import (
	"context"
	"net/http"
)

// This file is the exported boundary of the worker package. Everything else in
// the package stays unexported; only the symbols the CLI wiring layer and the
// (untouched) tui command consume are re-exported here.

// DefaultAPIBaseURL is the default Contrabass cloud API base URL used by the
// worker and tui commands when --api-url is not supplied.
const DefaultAPIBaseURL = defaultWorkerAPIBaseURL

// ErrEnrollmentNotFound is returned by an EnrollmentStore when no enrollment is
// stored for the requested team.
var ErrEnrollmentNotFound = errWorkerEnrollmentNotFound

// Enrollment is a stored worker enrollment (team, worker id, refresh token).
type Enrollment = workerEnrollment

// EnrollmentStore reads and writes worker enrollments in an OS credential store.
type EnrollmentStore = workerEnrollmentStore

// NewLoginStore opens the OS-native credential store used to persist worker
// enrollments.
func NewLoginStore() (EnrollmentStore, error) {
	return newWorkerLoginStore()
}

// RefreshSession exchanges a refresh token for a short-lived session token.
func RefreshSession(ctx context.Context, apiBaseURL, refreshToken string) (string, error) {
	return refreshWorkerSession(ctx, apiBaseURL, refreshToken)
}

// APIEndpoint joins the cloud API base URL with a path, validating the base URL.
func APIEndpoint(apiBaseURL, path string) (string, error) {
	return workerAPIEndpoint(apiBaseURL, path)
}

// Registration is the resolved worker registration handed to the dispatch
// consumer. Exported so CLI-level integration tests can assert on the values
// the wiring layer produces.
type Registration = workerRegistration

// DispatchHandler handles a single dispatched run frame.
type DispatchHandler = workerDispatchHandler

// LeaseRevokedHandler is invoked when the cloud revokes a run's lease.
type LeaseRevokedHandler = workerLeaseRevokedHandler

// DispatchConsumerFunc is the dispatch-consumer seam signature.
type DispatchConsumerFunc func(context.Context, Registration, DispatchHandler, LeaseRevokedHandler) error

// StubLoginDependencies overrides the HTTP client and credential store used by
// the worker runtime, returning a restore func. For test wiring only.
func StubLoginDependencies(client *http.Client, store EnrollmentStore) func() {
	oldClient := workerLoginHTTPClient
	oldStore := newWorkerLoginStore
	workerLoginHTTPClient = client
	newWorkerLoginStore = func() (workerEnrollmentStore, error) { return store, nil }
	return func() {
		workerLoginHTTPClient = oldClient
		newWorkerLoginStore = oldStore
	}
}

// StubLookupPath overrides PATH lookup used by capability detection, returning a
// restore func. For test wiring only.
func StubLookupPath(lookup func(string) (string, error)) func() {
	old := workerLookupPath
	workerLookupPath = lookup
	return func() { workerLookupPath = old }
}

// StubDispatchConsumer overrides the dispatch consumer, returning a restore
// func. For test wiring only.
func StubDispatchConsumer(consumer DispatchConsumerFunc) func() {
	old := workerDispatchConsumer
	workerDispatchConsumer = consumer
	return func() { workerDispatchConsumer = old }
}
