import type {
  LeaseRevokedFrame,
  HeartbeatLeaseRevokedError,
  HeartbeatRunUnknownError,
  RefreshRevokedError,
  WorkerAckRequest,
  WorkerCompleteRequest,
  WorkerDispatchFrame,
  WorkerEventLine,
  WorkerEventsErrorResponse,
  WorkerHeartbeatErrorResponse,
  WorkerRegisterRequest,
  WorkerRegisterErrorResponse,
  WorkerRefreshErrorResponse,
} from "./index";

const protocol_version = "1.0.0";

const registerRequest: WorkerRegisterRequest = {
  teamId: "team-1",
  workerId: "worker-1",
  capabilities: ["agent:codex", "git"],
  maxConcurrency: 2,
  version: "dev",
  supported_protocol_versions: [protocol_version],
  protocol_version,
};

const dispatchFrame: WorkerDispatchFrame = {
  type: "dispatch",
  protocol_version,
  runId: "run-1",
  issueRef: "LIN-123",
  branch: "feature/lin-123",
  prompt: "fix the issue",
  configHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  leaseSec: 60,
  artifactUploadURLs: {
    logs: "https://example.test/logs",
    diff: "https://example.test/diff",
    summary: "https://example.test/summary",
  },
};

const acceptedAck: WorkerAckRequest = { accept: true, protocol_version };
const rejectedAck: WorkerAckRequest = {
  accept: false,
  reason: "at_capacity",
  protocol_version,
};

const eventLine: WorkerEventLine = {
  ts: 1,
  kind: "phase",
  protocol_version,
  payload: { phase: "verify" },
};

const registerError: WorkerRegisterErrorResponse = {
  error: "protocol_version_unsupported",
  supported: [protocol_version],
  protocol_version,
};

const eventsError: WorkerEventsErrorResponse = {
  error: "events_too_large",
  max_events: 200,
  max_bytes: 524288,
  protocol_version,
};

const refreshError: WorkerRefreshErrorResponse = {
  error: "refresh_revoked",
  protocol_version,
};

const heartbeatError: WorkerHeartbeatErrorResponse = {
  error: "lease_revoked",
  protocol_version,
};

const namedRefreshError: RefreshRevokedError = refreshError;
const namedHeartbeatError: HeartbeatLeaseRevokedError = heartbeatError;
const runUnknown: HeartbeatRunUnknownError = {
  error: "run_unknown",
  protocol_version,
};

const completion: WorkerCompleteRequest = {
  status: "cancelled",
  summary: "stopped by operator",
  artifactKeys: {},
  finalConfigHash: dispatchFrame.configHash,
  protocol_version,
};

const revoked: LeaseRevokedFrame = {
  type: "lease-revoked",
  protocol_version,
  runId: dispatchFrame.runId,
  reason: "manual_reassign",
};

void registerRequest;
void acceptedAck;
void rejectedAck;
void eventLine;
void registerError;
void eventsError;
void refreshError;
void heartbeatError;
void namedRefreshError;
void namedHeartbeatError;
void runUnknown;
void completion;
void revoked;
