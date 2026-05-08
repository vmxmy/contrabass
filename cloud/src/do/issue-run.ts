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
};

export type IssueRunTransitionResult = {
  previous: IssueRunStatus;
  current: IssueRunStatus;
  changed: boolean;
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
};
type IssueRunDurableState = {
  storage: IssueRunStorage;
};

const RECORD_KEY = "issue-run:record";
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
      return this.transition(record, "dispatched");
    }

    if (request.method === "POST" && url.pathname === "/ack") {
      const body = await readObjectBody(request);
      const accept = getBooleanField(body, "accept");
      if (accept === undefined) {
        return jsonResponse({ error: "invalid_request", message: "accept must be a boolean" }, 400);
      }

      const record = await this.ensureRecord();
      return this.transition(record, accept ? "running" : "queued");
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
      return this.transition(record, status);
    }

    return jsonResponse({ error: "not_found" }, 404);
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

  private async transition(record: IssueRunRecord, next: IssueRunStatus): Promise<Response> {
    try {
      const result = transitionIssueRunStatus(record.status, next);
      const now = Date.now();
      const updated: IssueRunRecord = {
        ...record,
        status: result.current,
        updatedAt: now,
        startedAt: result.current === "running" && record.startedAt === undefined ? now : record.startedAt,
        endedAt: isTerminalIssueRunStatus(result.current) && record.endedAt === undefined ? now : record.endedAt,
      };

      if (result.changed) {
        await this.state.storage.put(RECORD_KEY, updated);
      }

      return jsonResponse({ run: updated, transition: result });
    } catch (error) {
      if (error instanceof IssueRunTransitionError) {
        return jsonResponse({ error: error.code, from: error.from, to: error.to }, 409);
      }
      throw error;
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

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}
