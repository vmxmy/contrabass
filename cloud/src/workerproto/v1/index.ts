export type { WorkerAckRequest, Accept, Reject } from "./ack";
export type {
  WorkerCompleteRequest,
  SucceededCompletion,
  FailedCompletion,
  CancelledCompletion,
  ArtifactKeysFull,
  ArtifactKeysPartial,
  R2ObjectKey,
} from "./complete";
export type { WorkerDispatchFrame } from "./dispatch";
export type {
  WorkerEventLine,
  StartEvent,
  LogEvent,
  ToolCallEvent,
  DiffEvent,
  ErrorEvent,
  PhaseEvent,
} from "./event-line";
export type {
  WorkerEventsRequest,
  WorkerEventsErrorResponse,
  EventsTooLargeError,
  EventsTooManyError,
  InvalidNdjsonError,
} from "./events-request";
export type {
  WorkerHeartbeatRequest,
  WorkerHeartbeatErrorResponse,
  LeaseRevokedError as HeartbeatLeaseRevokedError,
  LeaseHolderMismatchError,
  RunUnknownError as HeartbeatRunUnknownError,
  RunTerminalError,
} from "./heartbeat";
export type { LeaseRevokedFrame } from "./lease-revoked";
export type { WorkerRefreshRequest } from "./refresh-request";
export type {
  WorkerRefreshResponse,
  WorkerRefreshErrorResponse,
  RefreshRevokedError,
  RefreshExpiredError,
  RefreshInvalidError,
} from "./refresh-response";
export type { WorkerRegisterRequest } from "./register-request";
export type {
  WorkerRegisterResponse,
  WorkerRegisterErrorResponse,
  ProtocolVersionUnsupportedError,
  TeamForbiddenError,
  TeamWorkerCapExceededError,
  AuthInvalidError,
} from "./register-response";

export const PROTOCOL_VERSION_CURRENT = "1.0.0" as const;
export type ProtocolVersion = typeof PROTOCOL_VERSION_CURRENT;
