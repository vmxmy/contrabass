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
  setAlarm(scheduledTime: number | Date): Promise<void>;
  getAlarm(): Promise<number | null>;
  deleteAlarm(): Promise<void>;
};
type IssueRunDurableState = {
  storage: IssueRunStorage;
};

type IssueRunTransitionOptions = {
  leaseHolder?: string;
  leaseSec?: number;
  leaseExpiresAt?: number;
  clearLease?: boolean;
};

const RECORD_KEY = "issue-run:record";
const DEFAULT_LEASE_SEC = 60;
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
    private readonly env: unknown,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/state")) {
      const record = await this.ensureRecord();
      return jsonResponse({ run: record });
    }

    if (request.method === "POST" && url.pathname === "/dispatch") {
      const body = await readObjectBody(request);
      const record = await this.ensureRecord(body);
      return this.transition(record, "dispatched", {
        leaseHolder: getStringField(body, "workerId"),
        leaseSec: getLeaseSecField(body, "leaseSec"),
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

    if (request.method === "POST" && url.pathname === "/complete") {
      const body = await readObjectBody(request);
      const status = getStringField(body, "status");
      if (!isIssueRunStatus(status) || !isTerminalIssueRunStatus(status)) {
        return jsonResponse(
          { error: "invalid_request", message: "status must be succeeded, failed, or cancelled" },
          400,
        );
      }

      const record = await this.ensureRecord();
      return this.transition(record, status, { clearLease: true });
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

function getRequestWorkerId(request: Request, body: Record<string, unknown>): string | undefined {
  return request.headers.get("x-contrabass-worker-id") ?? getStringField(body, "workerId");
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
