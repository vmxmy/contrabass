import acceptAckFixture from "../../../../testdata/workerproto/v1/ack.accept.json";
import rejectAckFixture from "../../../../testdata/workerproto/v1/ack.reject.json";
import cancelledCompletionFixture from "../../../../testdata/workerproto/v1/complete.cancelled.json";
import completeErrorLeaseRevokedFixture from "../../../../testdata/workerproto/v1/complete-error.lease-revoked.json";
import failedCompletionFixture from "../../../../testdata/workerproto/v1/complete.failed.json";
import succeededCompletionFixture from "../../../../testdata/workerproto/v1/complete.succeeded.json";
import dispatchFixture from "../../../../testdata/workerproto/v1/dispatch.json";
import diffEventFixture from "../../../../testdata/workerproto/v1/event-line.diff.json";
import errorEventFixture from "../../../../testdata/workerproto/v1/event-line.error.json";
import logEventFixture from "../../../../testdata/workerproto/v1/event-line.log.json";
import phaseEventFixture from "../../../../testdata/workerproto/v1/event-line.phase.json";
import startEventFixture from "../../../../testdata/workerproto/v1/event-line.start.json";
import toolCallEventFixture from "../../../../testdata/workerproto/v1/event-line.tool-call.json";
import eventsErrorInvalidNdjsonFixture from "../../../../testdata/workerproto/v1/events-error.invalid-ndjson.json";
import eventsErrorTooLargeFixture from "../../../../testdata/workerproto/v1/events-error.too-large.json";
import eventsErrorTooManyFixture from "../../../../testdata/workerproto/v1/events-error.too-many.json";
import eventsRequestFixture from "../../../../testdata/workerproto/v1/events-request.json";
import heartbeatErrorLeaseHolderMismatchFixture from "../../../../testdata/workerproto/v1/heartbeat-error.lease-holder-mismatch.json";
import heartbeatErrorLeaseRevokedFixture from "../../../../testdata/workerproto/v1/heartbeat-error.lease-revoked.json";
import heartbeatErrorRunTerminalFixture from "../../../../testdata/workerproto/v1/heartbeat-error.run-terminal.json";
import heartbeatErrorRunUnknownFixture from "../../../../testdata/workerproto/v1/heartbeat-error.run-unknown.json";
import heartbeatFixture from "../../../../testdata/workerproto/v1/heartbeat.json";
import leaseRevokedFixture from "../../../../testdata/workerproto/v1/lease-revoked.heartbeat-timeout.json";
import refreshErrorExpiredFixture from "../../../../testdata/workerproto/v1/refresh-error.expired.json";
import refreshErrorInvalidFixture from "../../../../testdata/workerproto/v1/refresh-error.invalid.json";
import refreshErrorRevokedFixture from "../../../../testdata/workerproto/v1/refresh-error.revoked.json";
import refreshRequestFixture from "../../../../testdata/workerproto/v1/refresh-request.json";
import refreshResponseFixture from "../../../../testdata/workerproto/v1/refresh-response.success.json";
import registerErrorAuthInvalidFixture from "../../../../testdata/workerproto/v1/register-error.auth-invalid.json";
import registerErrorProtocolFixture from "../../../../testdata/workerproto/v1/register-error.protocol-version-unsupported.json";
import registerErrorTeamForbiddenFixture from "../../../../testdata/workerproto/v1/register-error.team-forbidden.json";
import registerErrorTeamWorkerCapExceededFixture from "../../../../testdata/workerproto/v1/register-error.team-worker-cap-exceeded.json";
import registerRequestFixture from "../../../../testdata/workerproto/v1/register-request.local.json";
import registerResponseFixture from "../../../../testdata/workerproto/v1/register-response.success.json";
import type {
  AuthInvalidError,
  EventsTooManyError,
  HeartbeatLeaseRevokedError,
  HeartbeatRunUnknownError,
  InvalidNdjsonError,
  LeaseHolderMismatchError,
  LeaseRevokedFrame,
  ProtocolVersionUnsupportedError,
  RefreshExpiredError,
  RefreshInvalidError,
  RefreshRevokedError,
  RunTerminalError,
  TeamForbiddenError,
  TeamWorkerCapExceededError,
  WorkerAckRequest,
  WorkerCompleteRequest,
  WorkerDispatchFrame,
  WorkerEventLine,
  WorkerEventsErrorResponse,
  WorkerEventsRequest,
  WorkerHeartbeatRequest,
  WorkerRefreshRequest,
  WorkerRefreshResponse,
  WorkerRegisterRequest,
  WorkerRegisterResponse,
} from "./index";

assertWorkerRegisterRequest(registerRequestFixture);
assertWorkerRegisterResponse(registerResponseFixture);
assertProtocolVersionUnsupportedError(registerErrorProtocolFixture);
assertTeamForbiddenError(registerErrorTeamForbiddenFixture);
assertTeamWorkerCapExceededError(registerErrorTeamWorkerCapExceededFixture);
assertAuthInvalidError(registerErrorAuthInvalidFixture);
assertWorkerDispatchFrame(dispatchFixture);
assertWorkerAckRequest(acceptAckFixture);
assertWorkerAckRequest(rejectAckFixture);
assertWorkerHeartbeatRequest(heartbeatFixture);
assertLeaseRevokedError(heartbeatErrorLeaseRevokedFixture);
assertLeaseHolderMismatchError(heartbeatErrorLeaseHolderMismatchFixture);
assertRunUnknownError(heartbeatErrorRunUnknownFixture);
assertRunTerminalError(heartbeatErrorRunTerminalFixture);
assertWorkerEventLine(startEventFixture);
assertWorkerEventLine(logEventFixture);
assertWorkerEventLine(toolCallEventFixture);
assertWorkerEventLine(diffEventFixture);
assertWorkerEventLine(errorEventFixture);
assertWorkerEventLine(phaseEventFixture);
assertWorkerEventsRequest(eventsRequestFixture);
assertWorkerEventsErrorResponse(eventsErrorTooLargeFixture);
assertEventsTooManyError(eventsErrorTooManyFixture);
assertInvalidNdjsonError(eventsErrorInvalidNdjsonFixture);
assertWorkerCompleteRequest(succeededCompletionFixture);
assertWorkerCompleteRequest(failedCompletionFixture);
assertWorkerCompleteRequest(cancelledCompletionFixture);
assertLeaseRevokedError(completeErrorLeaseRevokedFixture);
assertLeaseRevokedFrame(leaseRevokedFixture);
assertWorkerRefreshRequest(refreshRequestFixture);
assertWorkerRefreshResponse(refreshResponseFixture);
assertRefreshRevokedError(refreshErrorRevokedFixture);
assertRefreshExpiredError(refreshErrorExpiredFixture);
assertRefreshInvalidError(refreshErrorInvalidFixture);

const registerRequest: WorkerRegisterRequest = registerRequestFixture;
const registerResponse: WorkerRegisterResponse = registerResponseFixture;
const registerError: ProtocolVersionUnsupportedError = registerErrorProtocolFixture;
const registerTeamForbiddenError: TeamForbiddenError = registerErrorTeamForbiddenFixture;
const registerTeamWorkerCapExceededError: TeamWorkerCapExceededError = registerErrorTeamWorkerCapExceededFixture;
const registerAuthInvalidError: AuthInvalidError = registerErrorAuthInvalidFixture;
const dispatch: WorkerDispatchFrame = dispatchFixture;
const acceptAck: WorkerAckRequest = acceptAckFixture;
const rejectAck: WorkerAckRequest = rejectAckFixture;
const heartbeat: WorkerHeartbeatRequest = heartbeatFixture;
const heartbeatError: HeartbeatLeaseRevokedError = heartbeatErrorLeaseRevokedFixture;
const heartbeatLeaseHolderMismatchError: LeaseHolderMismatchError = heartbeatErrorLeaseHolderMismatchFixture;
const heartbeatRunUnknownError: HeartbeatRunUnknownError = heartbeatErrorRunUnknownFixture;
const heartbeatRunTerminalError: RunTerminalError = heartbeatErrorRunTerminalFixture;
const startEvent: WorkerEventLine = startEventFixture;
const logEvent: WorkerEventLine = logEventFixture;
const toolCallEvent: WorkerEventLine = toolCallEventFixture;
const diffEvent: WorkerEventLine = diffEventFixture;
const errorEvent: WorkerEventLine = errorEventFixture;
const phaseEvent: WorkerEventLine = phaseEventFixture;
const eventsRequest: WorkerEventsRequest = eventsRequestFixture;
const eventsError: WorkerEventsErrorResponse = eventsErrorTooLargeFixture;
const eventsTooManyError: EventsTooManyError = eventsErrorTooManyFixture;
const eventsInvalidNdjsonError: InvalidNdjsonError = eventsErrorInvalidNdjsonFixture;
const succeededCompletion: WorkerCompleteRequest = succeededCompletionFixture;
const failedCompletion: WorkerCompleteRequest = failedCompletionFixture;
const cancelledCompletion: WorkerCompleteRequest = cancelledCompletionFixture;
const completeError: HeartbeatLeaseRevokedError = completeErrorLeaseRevokedFixture;
const leaseRevoked: LeaseRevokedFrame = leaseRevokedFixture;
const refreshRequest: WorkerRefreshRequest = refreshRequestFixture;
const refreshResponse: WorkerRefreshResponse = refreshResponseFixture;
const refreshError: RefreshRevokedError = refreshErrorRevokedFixture;
const refreshExpiredError: RefreshExpiredError = refreshErrorExpiredFixture;
const refreshInvalidError: RefreshInvalidError = refreshErrorInvalidFixture;

void registerRequest;
void registerResponse;
void registerError;
void registerTeamForbiddenError;
void registerTeamWorkerCapExceededError;
void registerAuthInvalidError;
void dispatch;
void acceptAck;
void rejectAck;
void heartbeat;
void heartbeatError;
void heartbeatLeaseHolderMismatchError;
void heartbeatRunUnknownError;
void heartbeatRunTerminalError;
void startEvent;
void logEvent;
void toolCallEvent;
void diffEvent;
void errorEvent;
void phaseEvent;
void eventsRequest;
void eventsError;
void eventsTooManyError;
void eventsInvalidNdjsonError;
void succeededCompletion;
void failedCompletion;
void cancelledCompletion;
void completeError;
void leaseRevoked;
void refreshRequest;
void refreshResponse;
void refreshError;
void refreshExpiredError;
void refreshInvalidError;

function assertWorkerRegisterRequest(value: unknown): asserts value is WorkerRegisterRequest {
  const fixture = fixtureRecord(value);
  assertProtocolVersion(fixture);
  assertString(fixture.teamId);
  assertString(fixture.workerId);
  assertNonEmptyStringArray(fixture.capabilities);
  assertNumber(fixture.maxConcurrency);
  assertString(fixture.version);
  assertNonEmptyStringArray(fixture.supported_protocol_versions);
  if (fixture.kind !== undefined && fixture.kind !== "local" && fixture.kind !== "container") {
    throw new Error("invalid worker kind");
  }
}

function assertWorkerRegisterResponse(value: unknown): asserts value is WorkerRegisterResponse {
  const fixture = fixtureRecord(value);
  assertProtocolVersion(fixture);
  assertString(fixture.sessionToken);
  assertNumber(fixture.sessionTokenExpiresAt);
  assertString(fixture.refreshToken);
  const dispatchChannel = fixtureRecord(fixture.dispatchChannel);
  assertString(dispatchChannel.wsUrl);
  assertString(dispatchChannel.longPollUrl);
  assertNumber(fixture.heartbeatIntervalSec);
  assertNumber(fixture.leaseSec);
}

function assertProtocolVersionUnsupportedError(value: unknown): asserts value is ProtocolVersionUnsupportedError {
  const fixture = fixtureRecord(value);
  assertProtocolVersion(fixture);
  assertEquals(fixture.error, "protocol_version_unsupported");
  assertNonEmptyProtocolVersionArray(fixture.supported);
}

function assertTeamForbiddenError(value: unknown): asserts value is TeamForbiddenError {
  const fixture = fixtureRecord(value);
  assertProtocolVersion(fixture);
  assertEquals(fixture.error, "team_forbidden");
  if (fixture.message !== undefined) {
    assertString(fixture.message);
  }
}

function assertTeamWorkerCapExceededError(value: unknown): asserts value is TeamWorkerCapExceededError {
  const fixture = fixtureRecord(value);
  assertProtocolVersion(fixture);
  assertEquals(fixture.error, "team_worker_cap_exceeded");
  assertNumber(fixture.max_active_workers);
  if (fixture.message !== undefined) {
    assertString(fixture.message);
  }
}

function assertAuthInvalidError(value: unknown): asserts value is AuthInvalidError {
  const fixture = fixtureRecord(value);
  assertProtocolVersion(fixture);
  assertEquals(fixture.error, "auth_invalid");
  if (fixture.message !== undefined) {
    assertString(fixture.message);
  }
}

function assertWorkerDispatchFrame(value: unknown): asserts value is WorkerDispatchFrame {
  const fixture = fixtureRecord(value);
  assertProtocolVersion(fixture);
  assertEquals(fixture.type, "dispatch");
  assertString(fixture.runId);
  assertString(fixture.issueRef);
  assertString(fixture.branch);
  assertString(fixture.prompt);
  assertString(fixture.configHash);
  assertNumber(fixture.leaseSec);
  const urls = fixtureRecord(fixture.artifactUploadURLs);
  assertString(urls.logs);
  assertString(urls.diff);
  assertString(urls.summary);
  if (urls.screenshots !== undefined) {
    assertStringArray(urls.screenshots);
  }
}

function assertWorkerAckRequest(value: unknown): asserts value is WorkerAckRequest {
  const fixture = fixtureRecord(value);
  assertProtocolVersion(fixture);
  if (fixture.accept === true) {
    return;
  }
  assertEquals(fixture.accept, false);
  assertOneOf(fixture.reason, ["at_capacity", "missing_capability", "config_hash_unknown", "worker_shutting_down", "other"]);
}

function assertWorkerHeartbeatRequest(value: unknown): asserts value is WorkerHeartbeatRequest {
  const fixture = fixtureRecord(value);
  assertProtocolVersion(fixture);
  assertNumber(fixture.lastEventTs);
  if (fixture.progress !== undefined) {
    assertString(fixture.progress);
  }
}

function assertLeaseRevokedError(value: unknown): asserts value is HeartbeatLeaseRevokedError {
  const fixture = fixtureRecord(value);
  assertProtocolVersion(fixture);
  assertEquals(fixture.error, "lease_revoked");
}

function assertLeaseHolderMismatchError(value: unknown): asserts value is LeaseHolderMismatchError {
  const fixture = fixtureRecord(value);
  assertProtocolVersion(fixture);
  assertEquals(fixture.error, "lease_holder_mismatch");
  if (fixture.message !== undefined) {
    assertString(fixture.message);
  }
}

function assertRunUnknownError(value: unknown): asserts value is HeartbeatRunUnknownError {
  const fixture = fixtureRecord(value);
  assertProtocolVersion(fixture);
  assertEquals(fixture.error, "run_unknown");
  if (fixture.message !== undefined) {
    assertString(fixture.message);
  }
}

function assertRunTerminalError(value: unknown): asserts value is RunTerminalError {
  const fixture = fixtureRecord(value);
  assertProtocolVersion(fixture);
  assertEquals(fixture.error, "run_terminal");
  if (fixture.message !== undefined) {
    assertString(fixture.message);
  }
}

function assertWorkerEventLine(value: unknown): asserts value is WorkerEventLine {
  const fixture = fixtureRecord(value);
  assertProtocolVersion(fixture);
  assertNumber(fixture.ts);
  assertOneOf(fixture.kind, ["start", "log", "tool_call", "diff", "error", "phase"]);
  fixtureRecord(fixture.payload);
}

function assertWorkerEventsRequest(value: unknown): asserts value is WorkerEventsRequest {
  if (!Array.isArray(value) || value.length < 1) {
    throw new Error("events fixture must contain at least one event");
  }
  for (const event of value) {
    assertWorkerEventLine(event);
  }
}

function assertWorkerEventsErrorResponse(value: unknown): asserts value is WorkerEventsErrorResponse {
  const fixture = fixtureRecord(value);
  assertProtocolVersion(fixture);
  assertEquals(fixture.error, "events_too_large");
  assertNumber(fixture.max_events);
  assertNumber(fixture.max_bytes);
}

function assertEventsTooManyError(value: unknown): asserts value is EventsTooManyError {
  const fixture = fixtureRecord(value);
  assertProtocolVersion(fixture);
  assertEquals(fixture.error, "events_too_many");
  assertNumber(fixture.max_events);
  if (fixture.message !== undefined) {
    assertString(fixture.message);
  }
}

function assertInvalidNdjsonError(value: unknown): asserts value is InvalidNdjsonError {
  const fixture = fixtureRecord(value);
  assertProtocolVersion(fixture);
  assertEquals(fixture.error, "invalid_ndjson");
  assertNumber(fixture.lineNumber);
  if (fixture.message !== undefined) {
    assertString(fixture.message);
  }
}

function assertWorkerCompleteRequest(value: unknown): asserts value is WorkerCompleteRequest {
  const fixture = fixtureRecord(value);
  assertProtocolVersion(fixture);
  assertOneOf(fixture.status, ["succeeded", "failed", "cancelled"]);
  assertString(fixture.summary);
  fixtureRecord(fixture.artifactKeys);
  assertString(fixture.finalConfigHash);
  if (fixture.status === "failed") {
    assertString(fixture.errorClass);
  }
}

function assertLeaseRevokedFrame(value: unknown): asserts value is LeaseRevokedFrame {
  const fixture = fixtureRecord(value);
  assertProtocolVersion(fixture);
  assertEquals(fixture.type, "lease-revoked");
  assertString(fixture.runId);
  assertOneOf(fixture.reason, [
    "heartbeat_timeout",
    "ack_timeout",
    "manual_reassign",
    "cancelled",
    "team_paused",
    "config_invalidated",
    "server_shutdown",
    "worker_evicted_by_admin",
    "session_expired",
    "protocol_version_renegotiation",
  ]);
}

function assertWorkerRefreshRequest(value: unknown): asserts value is WorkerRefreshRequest {
  const fixture = fixtureRecord(value);
  assertProtocolVersion(fixture);
  assertString(fixture.refreshToken);
}

function assertWorkerRefreshResponse(value: unknown): asserts value is WorkerRefreshResponse {
  const fixture = fixtureRecord(value);
  assertProtocolVersion(fixture);
  assertString(fixture.sessionToken);
  assertNumber(fixture.expiresAt);
}

function assertRefreshRevokedError(value: unknown): asserts value is RefreshRevokedError {
  const fixture = fixtureRecord(value);
  assertProtocolVersion(fixture);
  assertEquals(fixture.error, "refresh_revoked");
}

function assertRefreshExpiredError(value: unknown): asserts value is RefreshExpiredError {
  const fixture = fixtureRecord(value);
  assertProtocolVersion(fixture);
  assertEquals(fixture.error, "refresh_expired");
  if (fixture.message !== undefined) {
    assertString(fixture.message);
  }
}

function assertRefreshInvalidError(value: unknown): asserts value is RefreshInvalidError {
  const fixture = fixtureRecord(value);
  assertProtocolVersion(fixture);
  assertEquals(fixture.error, "refresh_invalid");
  if (fixture.message !== undefined) {
    assertString(fixture.message);
  }
}

function assertProtocolVersion(value: Record<string, unknown>): asserts value is Record<string, unknown> & { protocol_version: "1.0.0" } {
  assertEquals(value.protocol_version, "1.0.0");
}

function fixtureRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("fixture must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function assertString(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("fixture value must be a non-empty string");
  }
}

function assertNumber(value: unknown): asserts value is number {
  if (typeof value !== "number") {
    throw new Error("fixture value must be a number");
  }
}

function assertStringArray(value: unknown): asserts value is string[] {
  if (!Array.isArray(value)) {
    throw new Error("fixture value must be an array");
  }
  for (const item of value) {
    assertString(item);
  }
}

function assertNonEmptyStringArray(value: unknown): asserts value is [string, ...string[]] {
  assertStringArray(value);
  if (value.length < 1) {
    throw new Error("fixture array must not be empty");
  }
}

function assertNonEmptyProtocolVersionArray(value: unknown): asserts value is ["1.0.0", ..."1.0.0"[]] {
  if (!Array.isArray(value) || value.length < 1) {
    throw new Error("supported protocol versions must not be empty");
  }
  for (const item of value) {
    assertEquals(item, "1.0.0");
  }
}

function assertEquals<const Expected extends string | number | boolean>(
  value: unknown,
  expected: Expected,
): asserts value is Expected {
  if (value !== expected) {
    throw new Error(`expected ${String(expected)}`);
  }
}

function assertOneOf<const Expected extends string>(
  value: unknown,
  expected: readonly Expected[],
): asserts value is Expected {
  if (typeof value !== "string" || !expected.includes(value as Expected)) {
    throw new Error(`expected one of ${expected.join(", ")}`);
  }
}
