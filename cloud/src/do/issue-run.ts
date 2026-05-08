import type { EventArchiveMessage } from "../queues/events-archive";
import type { WorkerCompleteRequest, WorkerEventLine } from "../workerproto/v1";

export const ISSUE_RUN_STATES = [
  "queued",
  "dispatched",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const;

export type IssueRunStatus = (typeof ISSUE_RUN_STATES)[number];

export type IssueRunRecord = {
  runId?: string;
  teamId?: string;
  issueRef?: string;
  status: IssueRunStatus;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  endedAt?: number;
  leaseHolder?: string;
  leaseExpiresAt?: number;
  leaseSec?: number;
  workerKind?: string;
};

export type IssueRunTransitionResult = {
  previous: IssueRunStatus;
  current: IssueRunStatus;
  changed: boolean;
};

export type IssueRunHeartbeatResult = {
  run: IssueRunRecord;
  leaseExpiresAt: number;
};

export type IssueRunStoredEvent = EventArchiveMessage;

type IssueRunQueue<T> = {
  send(message: T): Promise<void>;
};

type IssueRunD1Statement = {
  bind(...values: readonly unknown[]): IssueRunD1Statement;
  run(): Promise<unknown>;
};

type IssueRunD1Database = {
  prepare(query: string): IssueRunD1Statement;
};

type TeamCoordinatorStub = {
  fetch(input: string | Request, init?: RequestInit): Promise<Response>;
};

type TeamCoordinatorNamespace = {
  idFromName(name: string): unknown;
  get(id: unknown): TeamCoordinatorStub;
};

export type IssueRunEnv = {
  CONTROL_PLANE_DB?: IssueRunD1Database;
  EVENTS_ARCHIVE_QUEUE?: IssueRunQueue<EventArchiveMessage>;
  TEAM_COORDINATOR?: TeamCoordinatorNamespace;
};

export class IssueRunTransitionError extends Error {
  readonly code = "invalid_state_transition";

  constructor(
    readonly from: IssueRunStatus,
    readonly to: IssueRunStatus,
  ) {
    super(`invalid IssueRun transition: ${from} -> ${to}`);
    this.name = "IssueRunTransitionError";
  }
}

export type IssueRunStorage = {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  transaction<T>(closure: (txn: IssueRunStorageTransaction) => Promise<T> | T): Promise<T>;
  setAlarm(scheduledTime: number | Date): Promise<void>;
  getAlarm(): Promise<number | null>;
  deleteAlarm(): Promise<void>;
};
export type IssueRunStorageTransaction = {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
};
type IssueRunDurableState = {
  storage: IssueRunStorage;
};

type IssueRunTransitionOptions = {
  leaseHolder?: string;
  leaseSec?: number;
  leaseExpiresAt?: number;
  workerKind?: string;
  clearLease?: boolean;
};

type IssueRunCompletionRecord = {
  runId: string;
  teamId: string;
  issueRef: string;
  workerId: string;
  kind: string;
  startedAt: number;
  endedAt: number;
  status: "succeeded" | "failed" | "cancelled";
  summary: string;
  artifactKeys: Record<string, unknown>;
  finalConfigHash: string;
  errorClass?: string;
};

const RECORD_KEY = "issue-run:record";
const EVENT_LOG_KEY = "issue-run:events";
const DEFAULT_LEASE_SEC = 60;
const MAX_EVENTS_PER_REQUEST = 200;
const MAX_EVENTS_BYTES = 512 * 1024;
const TERMINAL_STATES = new Set<IssueRunStatus>(["succeeded", "failed", "cancelled"]);
const ALLOWED_TRANSITIONS: Record<IssueRunStatus, readonly IssueRunStatus[]> = {
  queued: ["dispatched"],
  dispatched: ["running", "queued"],
  running: ["succeeded", "failed", "cancelled", "queued"],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export function isIssueRunStatus(value: unknown): value is IssueRunStatus {
  return typeof value === "string" && ISSUE_RUN_STATES.includes(value as IssueRunStatus);
}

export function isTerminalIssueRunStatus(status: IssueRunStatus): boolean {
  return TERMINAL_STATES.has(status);
}

export function canTransitionIssueRunStatus(from: IssueRunStatus, to: IssueRunStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function transitionIssueRunStatus(
  from: IssueRunStatus,
  to: IssueRunStatus,
): IssueRunTransitionResult {
  if (!canTransitionIssueRunStatus(from, to)) {
    throw new IssueRunTransitionError(from, to);
  }

  return {
    previous: from,
    current: to,
    changed: from !== to,
  };
}

export class IssueRun {
  constructor(
    private readonly state: IssueRunDurableState,
    private readonly env: IssueRunEnv = {},
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/state")) {
      const record = await this.ensureRecord();
      return jsonResponse({ run: record });
    }

    if (request.method === "POST" && url.pathname === "/dispatch") {
      const body = await readObjectBody(request);
      return this.acquireDispatch(body, {
        leaseHolder: getStringField(body, "workerId"),
        leaseSec: getLeaseSecField(body, "leaseSec"),
        workerKind: getWorkerKindField(body),
      });
    }

    if (request.method === "POST" && url.pathname === "/ack") {
      const body = await readObjectBody(request);
      const accept = getBooleanField(body, "accept");
      if (accept === undefined) {
        return jsonResponse({ error: "invalid_request", message: "accept must be a boolean" }, 400);
      }

      const record = await this.ensureRecord();
      const workerId = getStringField(body, "workerId");
      if (accept && record.leaseHolder !== undefined && workerId !== undefined && workerId !== record.leaseHolder) {
        return jsonResponse({ error: "lease_holder_mismatch" }, 409);
      }

      const leaseSec = record.leaseSec ?? DEFAULT_LEASE_SEC;
      return this.transition(record, accept ? "running" : "queued", accept ? {
        leaseExpiresAt: Date.now() + leaseSec * 1000,
        leaseSec,
      } : { clearLease: true });
    }

    if (request.method === "POST" && url.pathname === "/heartbeat") {
      const body = await readObjectBody(request);
      return this.handleHeartbeat(request, body);
    }

    if (request.method === "POST" && url.pathname === "/events") {
      return this.handleEvents(request);
    }

    if (request.method === "POST" && url.pathname === "/complete") {
      const body = await readObjectBody(request);
      if (!isWorkerCompleteRequest(body)) {
        return jsonResponse(
          { error: "invalid_request", message: "complete body must match worker protocol v1" },
          400,
        );
      }

      return this.handleComplete(request, body);
    }

    return jsonResponse({ error: "not_found" }, 404);
  }

  async alarm(): Promise<void> {
    const record = await this.state.storage.get<IssueRunRecord>(RECORD_KEY);
    if (record === undefined || record.status !== "running" || record.leaseExpiresAt === undefined) {
      await this.state.storage.deleteAlarm();
      return;
    }

    const now = Date.now();
    if (record.leaseExpiresAt > now) {
      await this.state.storage.setAlarm(record.leaseExpiresAt);
      return;
    }

    await this.transitionRecord(record, "queued", now, { clearLease: true });
    await this.state.storage.deleteAlarm();
  }

  private async ensureRecord(metadata: Record<string, unknown> = {}): Promise<IssueRunRecord> {
    const existing = await this.state.storage.get<IssueRunRecord>(RECORD_KEY);
    if (existing !== undefined) {
      return existing;
    }

    const now = Date.now();
    const record: IssueRunRecord = {
      runId: getStringField(metadata, "runId"),
      teamId: getStringField(metadata, "teamId"),
      issueRef: getStringField(metadata, "issueRef"),
      status: "queued",
      createdAt: now,
      updatedAt: now,
    };

    await this.state.storage.put(RECORD_KEY, record);
    return record;
  }

  private async transition(
    record: IssueRunRecord,
    next: IssueRunStatus,
    options: IssueRunTransitionOptions = {},
  ): Promise<Response> {
    try {
      const now = Date.now();
      const { updated, result } = await this.transitionRecord(record, next, now, options);
      return jsonResponse({ run: updated, transition: result });
    } catch (error) {
      if (error instanceof IssueRunTransitionError) {
        return jsonResponse({ error: error.code, from: error.from, to: error.to }, 409);
      }
      throw error;
    }
  }

  private async acquireDispatch(
    metadata: Record<string, unknown>,
    options: IssueRunTransitionOptions = {},
  ): Promise<Response> {
    const now = Date.now();
    const acquisition = await this.state.storage.transaction(async (txn) => {
      const record = await this.getDispatchCandidate(txn, metadata, now);
      if (record.status !== "queued" || record.leaseHolder !== undefined) {
        return { acquired: false, record };
      }

      const result = transitionIssueRunStatus(record.status, "dispatched");
      const updated: IssueRunRecord = {
        ...record,
        status: result.current,
        updatedAt: now,
        leaseHolder: options.leaseHolder ?? record.leaseHolder,
        leaseSec: options.leaseSec ?? record.leaseSec,
        workerKind: options.workerKind ?? record.workerKind,
      };

      await txn.put(RECORD_KEY, updated);
      return { acquired: true, record: updated, result };
    });

    if (!acquisition.acquired) {
      return jsonResponse({ error: "lease_already_held", run: acquisition.record }, 409);
    }

    return jsonResponse({ run: acquisition.record, transition: acquisition.result });
  }

  private async getDispatchCandidate(
    txn: IssueRunStorageTransaction,
    metadata: Record<string, unknown>,
    now: number,
  ): Promise<IssueRunRecord> {
    const existing = await txn.get<IssueRunRecord>(RECORD_KEY);
    if (existing !== undefined) {
      return existing;
    }

    return {
      runId: getStringField(metadata, "runId"),
      teamId: getStringField(metadata, "teamId"),
      issueRef: getStringField(metadata, "issueRef"),
      status: "queued",
      createdAt: now,
      updatedAt: now,
    };
  }

  private async transitionRecord(
    record: IssueRunRecord,
    next: IssueRunStatus,
    now: number,
    options: IssueRunTransitionOptions = {},
  ): Promise<{ updated: IssueRunRecord; result: IssueRunTransitionResult }> {
    const result = transitionIssueRunStatus(record.status, next);
    const updated: IssueRunRecord = {
      ...record,
      status: result.current,
      updatedAt: now,
      startedAt: result.current === "running" && record.startedAt === undefined ? now : record.startedAt,
      endedAt: isTerminalIssueRunStatus(result.current) && record.endedAt === undefined ? now : record.endedAt,
      leaseHolder: options.leaseHolder ?? record.leaseHolder,
      leaseExpiresAt: options.leaseExpiresAt ?? record.leaseExpiresAt,
      leaseSec: options.leaseSec ?? record.leaseSec,
      workerKind: options.workerKind ?? record.workerKind,
    };

    if (options.clearLease) {
      delete updated.leaseHolder;
      delete updated.leaseExpiresAt;
      delete updated.leaseSec;
    }

    if (result.changed || leaseFieldsChanged(record, updated)) {
      await this.state.storage.put(RECORD_KEY, updated);
    }

    if (updated.status === "running" && updated.leaseExpiresAt !== undefined) {
      await this.state.storage.setAlarm(updated.leaseExpiresAt);
    } else if (record.leaseExpiresAt !== undefined || options.clearLease) {
      await this.state.storage.deleteAlarm();
    }

    return { updated, result };
  }

  private async handleHeartbeat(
    request: Request,
    body: Record<string, unknown>,
  ): Promise<Response> {
    const record = await this.state.storage.get<IssueRunRecord>(RECORD_KEY);
    if (record === undefined) {
      return heartbeatError("run_unknown", "run was not found", 404);
    }
    if (isTerminalIssueRunStatus(record.status)) {
      return heartbeatError("run_terminal", "run is already terminal", 409);
    }
    if (record.status !== "running" || record.leaseExpiresAt === undefined || record.leaseSec === undefined) {
      return heartbeatError("lease_revoked", "run lease has been revoked", 409);
    }

    const workerId = getRequestWorkerId(request, body);
    if (record.leaseHolder !== undefined && workerId !== record.leaseHolder) {
      return heartbeatError(
        "lease_holder_mismatch",
        "heartbeat came from a worker that does not hold the lease",
        409,
      );
    }

    const now = Date.now();
    if (record.leaseExpiresAt <= now) {
      return heartbeatError("lease_revoked", "run lease has been revoked", 409);
    }

    const leaseExpiresAt = now + record.leaseSec * 1000;
    const updated: IssueRunRecord = {
      ...record,
      updatedAt: now,
      leaseExpiresAt,
    };

    await this.state.storage.put(RECORD_KEY, updated);
    await this.state.storage.setAlarm(leaseExpiresAt);

    return jsonResponse({ run: updated, leaseExpiresAt });
  }

  private async handleEvents(request: Request): Promise<Response> {
    const record = await this.state.storage.get<IssueRunRecord>(RECORD_KEY);
    if (record === undefined) {
      return eventError("run_unknown", "run was not found", 404);
    }
    if (isTerminalIssueRunStatus(record.status)) {
      return eventError("run_terminal", "run is already terminal", 409);
    }
    if (record.status !== "running") {
      return eventError("run_not_running", "events are only accepted for running runs", 409);
    }
    if (record.teamId === undefined || record.runId === undefined) {
      return eventError("run_metadata_missing", "running run is missing teamId or runId", 409);
    }
    const { teamId, runId } = record;

    const workerId = getRequestWorkerId(request, {});
    if (record.leaseHolder !== undefined && workerId !== undefined && workerId !== record.leaseHolder) {
      return eventError(
        "lease_holder_mismatch",
        "event batch came from a worker that does not hold the lease",
        409,
      );
    }

    const body = await request.text();
    if (new TextEncoder().encode(body).byteLength > MAX_EVENTS_BYTES) {
      return eventsTooLargeResponse();
    }

    const parsed = parseEventLines(body);
    if ("error" in parsed) {
      return eventError(parsed.error, parsed.message, parsed.status);
    }
    if (parsed.events.length > MAX_EVENTS_PER_REQUEST) {
      return eventsTooLargeResponse();
    }

    const receivedAt = Date.now();
    const messages = parsed.events.map((event): EventArchiveMessage => ({
      protocol_version: "1.0.0",
      teamId,
      runId,
      issueRef: record.issueRef,
      workerId: workerId ?? record.leaseHolder,
      receivedAt,
      event,
    }));

    const existing = await this.state.storage.get<IssueRunStoredEvent[]>(EVENT_LOG_KEY);
    await this.state.storage.put(EVENT_LOG_KEY, [...(existing ?? []), ...messages]);
    await this.forwardEventsToTeamCoordinator(record, messages);
    await this.enqueueEvents(messages);

    return jsonResponse({ protocol_version: "1.0.0", accepted: messages.length });
  }

  private async handleComplete(
    request: Request,
    body: WorkerCompleteRequest,
  ): Promise<Response> {
    const record = await this.state.storage.get<IssueRunRecord>(RECORD_KEY);
    if (record === undefined) {
      return completionError("run_unknown", "run was not found", 404);
    }
    if (isTerminalIssueRunStatus(record.status)) {
      return completionError("run_terminal", "run is already terminal", 409);
    }
    if (record.status !== "running" || record.leaseExpiresAt === undefined) {
      return completionError("lease_revoked", "run lease has been revoked", 409);
    }

    const workerId = getRequestWorkerId(request, {});
    if (record.leaseHolder !== undefined && workerId !== record.leaseHolder) {
      return completionError(
        "lease_holder_mismatch",
        "completion came from a worker that does not hold the lease",
        409,
      );
    }

    const now = Date.now();
    if (record.leaseExpiresAt <= now) {
      return completionError("lease_revoked", "run lease has been revoked", 409);
    }

    const completion = buildCompletionRecord(record, body, now);
    if (completion === undefined) {
      return completionError("run_metadata_missing", "run is missing completion metadata", 409);
    }

    await this.persistCompletion(completion);
    await this.broadcastRunComplete(completion);

    const terminal = await this.transitionRecord(record, body.status, now, { clearLease: true });
    return jsonResponse({ run: terminal.updated, transition: terminal.result });
  }

  private async persistCompletion(completion: IssueRunCompletionRecord): Promise<void> {
    if (this.env.CONTROL_PLANE_DB === undefined) {
      return;
    }

    await this.env.CONTROL_PLANE_DB.prepare(`
      INSERT INTO runs (
        run_id,
        team_id,
        issue_ref,
        worker_id,
        kind,
        started_at,
        ended_at,
        status,
        summary,
        artifact_keys,
        final_config_hash,
        error_class
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        team_id = excluded.team_id,
        issue_ref = excluded.issue_ref,
        worker_id = excluded.worker_id,
        kind = excluded.kind,
        started_at = excluded.started_at,
        ended_at = excluded.ended_at,
        status = excluded.status,
        summary = excluded.summary,
        artifact_keys = excluded.artifact_keys,
        final_config_hash = excluded.final_config_hash,
        error_class = excluded.error_class
    `).bind(
      completion.runId,
      completion.teamId,
      completion.issueRef,
      completion.workerId,
      completion.kind,
      toIsoString(completion.startedAt),
      toIsoString(completion.endedAt),
      completion.status,
      completion.summary,
      JSON.stringify(completion.artifactKeys),
      completion.finalConfigHash,
      completion.errorClass ?? null,
    ).run();
  }

  private async broadcastRunComplete(completion: IssueRunCompletionRecord): Promise<void> {
    if (this.env.TEAM_COORDINATOR === undefined) {
      return;
    }

    const id = this.env.TEAM_COORDINATOR.idFromName(completion.teamId);
    const teamCoordinator = this.env.TEAM_COORDINATOR.get(id);
    const response = await teamCoordinator.fetch("https://team-coordinator.internal/run-complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "run-complete",
        protocol_version: "1.0.0",
        ...completion,
      }),
    });
    if (!response.ok) {
      throw new Error(`run-complete broadcast failed with status ${response.status}`);
    }
  }

  private async forwardEventsToTeamCoordinator(
    record: IssueRunRecord,
    messages: readonly EventArchiveMessage[],
  ): Promise<void> {
    if (this.env.TEAM_COORDINATOR === undefined || record.teamId === undefined) {
      return;
    }

    const id = this.env.TEAM_COORDINATOR.idFromName(record.teamId);
    const teamCoordinator = this.env.TEAM_COORDINATOR.get(id);

    for (const message of messages) {
      await teamCoordinator.fetch("https://team-coordinator.internal/run-event", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(message),
      });
    }
  }

  private async enqueueEvents(messages: readonly EventArchiveMessage[]): Promise<void> {
    if (this.env.EVENTS_ARCHIVE_QUEUE === undefined) {
      return;
    }

    for (const message of messages) {
      await this.env.EVENTS_ARCHIVE_QUEUE.send(message);
    }
  }
}

async function readObjectBody(request: Request): Promise<Record<string, unknown>> {
  if (request.body === null) {
    return {};
  }

  const body = await request.json();
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new Response(JSON.stringify({ error: "invalid_json" }), { status: 400 });
  }

  return body as Record<string, unknown>;
}

function getStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function getBooleanField(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function getLeaseSecField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return undefined;
  }
  return value;
}

function getWorkerKindField(record: Record<string, unknown>): string | undefined {
  const value = getStringField(record, "workerKind") ?? getStringField(record, "kind");
  return value === "local" || value === "container" ? value : undefined;
}

function getRequestWorkerId(request: Request, body: Record<string, unknown>): string | undefined {
  return request.headers.get("x-contrabass-worker-id") ?? getStringField(body, "workerId");
}

function isWorkerCompleteRequest(value: unknown): value is WorkerCompleteRequest {
  if (!isRecord(value)) {
    return false;
  }

  if (value.protocol_version !== "1.0.0") {
    return false;
  }

  const status = value.status;
  if (status !== "succeeded" && status !== "failed" && status !== "cancelled") {
    return false;
  }

  if (typeof value.summary !== "string" || !isConfigHash(value.finalConfigHash) || !isArtifactKeys(value.artifactKeys)) {
    return false;
  }

  return status !== "failed" || typeof value.errorClass === "string";
}

function isConfigHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function isArtifactKeys(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }

  return isOptionalString(value.logs)
    && isOptionalString(value.diff)
    && isOptionalString(value.summary)
    && isOptionalStringArray(value.screenshots);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isOptionalStringArray(value: unknown): boolean {
  return value === undefined
    || (Array.isArray(value) && value.every((item) => typeof item === "string"));
}

function buildCompletionRecord(
  active: IssueRunRecord,
  body: WorkerCompleteRequest,
  endedAt: number,
): IssueRunCompletionRecord | undefined {
  const workerId = active.leaseHolder;
  const kind = active.workerKind;
  if (
    active.runId === undefined
    || active.teamId === undefined
    || active.issueRef === undefined
    || workerId === undefined
    || kind === undefined
  ) {
    return undefined;
  }

  return {
    runId: active.runId,
    teamId: active.teamId,
    issueRef: active.issueRef,
    workerId,
    kind,
    startedAt: active.startedAt ?? active.createdAt,
    endedAt,
    status: body.status,
    summary: body.summary,
    artifactKeys: artifactKeysToRecord(body.artifactKeys),
    finalConfigHash: body.finalConfigHash,
    errorClass: body.status === "failed" ? body.errorClass : undefined,
  };
}

function artifactKeysToRecord(value: WorkerCompleteRequest["artifactKeys"]): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  if (value.logs !== undefined) {
    record.logs = value.logs;
  }
  if (value.diff !== undefined) {
    record.diff = value.diff;
  }
  if (value.summary !== undefined) {
    record.summary = value.summary;
  }
  if (value.screenshots !== undefined) {
    record.screenshots = value.screenshots;
  }
  return record;
}

function toIsoString(epochMillis: number): string {
  return new Date(epochMillis).toISOString();
}

type EventParseResult = {
  events: WorkerEventLine[];
} | {
  error: string;
  message: string;
  status: number;
};

function parseEventLines(body: string): EventParseResult {
  const lines = body.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  const events: WorkerEventLine[] = [];

  for (const line of lines) {
    let decoded: unknown;
    try {
      decoded = JSON.parse(line);
    } catch {
      return { error: "invalid_ndjson", message: "event batch contains invalid JSON", status: 400 };
    }

    if (!isWorkerEventLine(decoded)) {
      return { error: "invalid_event", message: "event line does not match worker protocol v1", status: 400 };
    }
    events.push(decoded);
  }

  return { events };
}

function isWorkerEventLine(value: unknown): value is WorkerEventLine {
  if (!isRecord(value)) {
    return false;
  }

  return value.protocol_version === "1.0.0"
    && typeof value.ts === "number"
    && Number.isFinite(value.ts)
    && isWorkerEventKind(value.kind)
    && isRecord(value.payload)
    && (value.seq === undefined || (typeof value.seq === "number" && Number.isFinite(value.seq)));
}

function isWorkerEventKind(value: unknown): value is WorkerEventLine["kind"] {
  return value === "start"
    || value === "log"
    || value === "tool_call"
    || value === "diff"
    || value === "error"
    || value === "phase";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function leaseFieldsChanged(previous: IssueRunRecord, next: IssueRunRecord): boolean {
  return previous.leaseHolder !== next.leaseHolder
    || previous.leaseExpiresAt !== next.leaseExpiresAt
    || previous.leaseSec !== next.leaseSec;
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function heartbeatError(error: string, message: string, status: number): Response {
  return jsonResponse({ protocol_version: "1.0.0", error, message }, status);
}

function completionError(error: string, message: string, status: number): Response {
  return jsonResponse({ protocol_version: "1.0.0", error, message }, status);
}

function eventError(error: string, message: string, status: number): Response {
  return jsonResponse({ protocol_version: "1.0.0", error, message }, status);
}

function eventsTooLargeResponse(): Response {
  return jsonResponse({
    error: "events_too_large",
    max_events: MAX_EVENTS_PER_REQUEST,
    max_bytes: MAX_EVENTS_BYTES,
  }, 413);
}
