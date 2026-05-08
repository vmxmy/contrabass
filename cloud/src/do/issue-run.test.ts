import { afterEach, describe, expect, it, vi } from "vitest";

import {
  IssueRun,
  type IssueRunEnv,
  IssueRunTransitionError,
  type IssueRunRecord,
  type IssueRunStatus,
  type IssueRunStoredEvent,
  type IssueRunStorage,
  transitionIssueRunStatus,
} from "./issue-run";

class MemoryIssueRunStorage implements IssueRunStorage {
  private readonly values = new Map<string, unknown>();
  private transactionLock: Promise<void> = Promise.resolve();
  private alarm: number | null = null;

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }

  async transaction<T>(closure: (txn: MemoryIssueRunStorage) => Promise<T> | T): Promise<T> {
    const previous = this.transactionLock;
    let release = () => {};
    this.transactionLock = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await closure(this);
    } finally {
      release();
    }
  }

  async setAlarm(scheduledTime: number | Date): Promise<void> {
    this.alarm = typeof scheduledTime === "number" ? scheduledTime : scheduledTime.getTime();
  }

  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }

  async deleteAlarm(): Promise<void> {
    this.alarm = null;
  }
}

class MemoryQueue<T> {
  readonly messages: T[] = [];

  async send(message: T): Promise<void> {
    this.messages.push(message);
  }
}

class MemoryTeamCoordinator {
  readonly requests: Array<{ input: string | Request; init?: RequestInit }> = [];

  async fetch(input: string | Request, init?: RequestInit): Promise<Response> {
    this.requests.push({ input, init });
    return Response.json({ ok: true });
  }
}

class MemoryTeamCoordinatorNamespace {
  readonly names: string[] = [];
  readonly coordinator = new MemoryTeamCoordinator();

  idFromName(name: string): unknown {
    this.names.push(name);
    return name;
  }

  get(): MemoryTeamCoordinator {
    return this.coordinator;
  }
}

type IssueRunResponseBody = {
  run?: IssueRunRecord;
  leaseExpiresAt?: number;
  accepted?: number;
  transition?: {
    previous: IssueRunStatus;
    current: IssueRunStatus;
    changed: boolean;
  };
  error?: string;
  protocol_version?: string;
};

describe("IssueRun state machine", () => {
  it.each([
    ["queued", "dispatched"],
    ["dispatched", "running"],
    ["dispatched", "queued"],
    ["running", "succeeded"],
    ["running", "failed"],
    ["running", "cancelled"],
    ["running", "queued"],
  ] satisfies Array<[IssueRunStatus, IssueRunStatus]>)
    ("allows %s -> %s", (from, to) => {
      expect(transitionIssueRunStatus(from, to)).toEqual({
        previous: from,
        current: to,
        changed: true,
      });
    });

  it.each([
    ["queued", "running"],
    ["queued", "succeeded"],
    ["dispatched", "succeeded"],
    ["succeeded", "queued"],
    ["failed", "running"],
    ["cancelled", "dispatched"],
  ] satisfies Array<[IssueRunStatus, IssueRunStatus]>)
    ("rejects %s -> %s", (from, to) => {
      expect(() => transitionIssueRunStatus(from, to)).toThrow(IssueRunTransitionError);
    });
});

describe("IssueRun Durable Object", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("materializes a new run in queued state", async () => {
    const issueRun = createIssueRun();

    const response = await issueRun.fetch(new Request("https://issue-run.test/state"));
    const body = await readIssueRunResponse(response);

    expect(response.status).toBe(200);
    expect(body.run?.status).toBe("queued");
  });

  it("persists queued to dispatched to running to succeeded", async () => {
    const issueRun = createIssueRun();

    const dispatched = await post(issueRun, "/dispatch", {
      runId: "run-1",
      teamId: "team-1",
      issueRef: "LIN-123",
    });
    expect(dispatched.status).toBe(200);
    await expect(readIssueRunResponse(dispatched)).resolves.toMatchObject({
      run: { runId: "run-1", teamId: "team-1", issueRef: "LIN-123", status: "dispatched" },
      transition: { previous: "queued", current: "dispatched", changed: true },
    });

    const running = await post(issueRun, "/ack", { accept: true });
    expect(running.status).toBe(200);
    await expect(readIssueRunResponse(running)).resolves.toMatchObject({
      run: { status: "running" },
      transition: { previous: "dispatched", current: "running", changed: true },
    });

    const succeeded = await post(issueRun, "/complete", { status: "succeeded" });
    expect(succeeded.status).toBe(200);
    await expect(readIssueRunResponse(succeeded)).resolves.toMatchObject({
      run: { status: "succeeded" },
      transition: { previous: "running", current: "succeeded", changed: true },
    });
  });

  it("stores lease holder and starts an alarm when dispatch is accepted", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const { issueRun, storage } = createIssueRunWithStorage();

    await post(issueRun, "/dispatch", {
      runId: "run-1",
      workerId: "worker-1",
      leaseSec: 45,
    });
    const response = await post(issueRun, "/ack", { accept: true, workerId: "worker-1" });

    expect(response.status).toBe(200);
    expect(await storage.getAlarm()).toBe(46_000);
    await expect(readIssueRunResponse(response)).resolves.toMatchObject({
      run: {
        status: "running",
        leaseHolder: "worker-1",
        leaseExpiresAt: 46_000,
        leaseSec: 45,
      },
    });
  });

  it("allows only one concurrent dispatch lease acquisition", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const issueRun = createIssueRun();

    const [first, second] = await Promise.all([
      post(issueRun, "/dispatch", {
        runId: "run-1",
        teamId: "team-1",
        issueRef: "LIN-123",
        workerId: "worker-1",
        leaseSec: 45,
      }),
      post(issueRun, "/dispatch", {
        runId: "run-1",
        teamId: "team-1",
        issueRef: "LIN-123",
        workerId: "worker-2",
        leaseSec: 45,
      }),
    ]);

    const responses = [
      { status: first.status, body: await readIssueRunResponse(first) },
      { status: second.status, body: await readIssueRunResponse(second) },
    ];

    const acquired = responses.filter((response) => response.status === 200);
    const rejected = responses.filter((response) => response.status === 409);
    const acquiredHolder = acquired[0]?.body.run?.leaseHolder;

    expect(acquired).toHaveLength(1);
    expect(["worker-1", "worker-2"]).toContain(acquiredHolder);
    expect(acquired[0]?.body).toMatchObject({
      run: {
        status: "dispatched",
        leaseHolder: acquiredHolder,
        leaseSec: 45,
      },
      transition: { previous: "queued", current: "dispatched", changed: true },
    });
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.body).toMatchObject({
      error: "lease_already_held",
      run: {
        status: "dispatched",
        leaseHolder: acquiredHolder,
      },
    });
  });

  it("rejects a second dispatch while a lease is already held", async () => {
    const issueRun = createIssueRun();

    const first = await post(issueRun, "/dispatch", {
      runId: "run-1",
      workerId: "worker-1",
      leaseSec: 45,
    });
    const second = await post(issueRun, "/dispatch", {
      runId: "run-1",
      workerId: "worker-2",
      leaseSec: 45,
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    await expect(readIssueRunResponse(second)).resolves.toMatchObject({
      error: "lease_already_held",
      run: {
        status: "dispatched",
        leaseHolder: "worker-1",
      },
    });
  });

  it("rejects an accepted ack from a non-holder", async () => {
    const issueRun = createIssueRun();

    await post(issueRun, "/dispatch", {
      runId: "run-1",
      workerId: "worker-1",
      leaseSec: 45,
    });
    const response = await post(issueRun, "/ack", { accept: true, workerId: "worker-2" });

    expect(response.status).toBe(409);
    await expect(readIssueRunResponse(response)).resolves.toMatchObject({
      error: "lease_holder_mismatch",
    });
  });

  it("requeues and clears the lease when the alarm fires after expiry", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const { issueRun, storage } = createIssueRunWithStorage();

    await post(issueRun, "/dispatch", {
      runId: "run-1",
      workerId: "worker-1",
      leaseSec: 2,
    });
    await post(issueRun, "/ack", { accept: true, workerId: "worker-1" });

    now.mockReturnValue(3_001);
    await issueRun.alarm();

    expect(await storage.getAlarm()).toBeNull();
    const state = await readIssueRunResponse(await issueRun.fetch(new Request("https://issue-run.test/state")));
    expect(state.run).toMatchObject({ status: "queued" });
    expect(state.run?.leaseHolder).toBeUndefined();
    expect(state.run?.leaseExpiresAt).toBeUndefined();
    expect(state.run?.leaseSec).toBeUndefined();
  });

  it("keeps the run and resets the alarm when an early alarm fires", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const { issueRun, storage } = createIssueRunWithStorage();

    await post(issueRun, "/dispatch", {
      runId: "run-1",
      workerId: "worker-1",
      leaseSec: 5,
    });
    await post(issueRun, "/ack", { accept: true, workerId: "worker-1" });

    now.mockReturnValue(2_000);
    await issueRun.alarm();

    expect(await storage.getAlarm()).toBe(6_000);
    const state = await readIssueRunResponse(await issueRun.fetch(new Request("https://issue-run.test/state")));
    expect(state.run).toMatchObject({
      status: "running",
      leaseHolder: "worker-1",
      leaseExpiresAt: 6_000,
      leaseSec: 5,
    });
  });

  it("extends the lease and resets the alarm on heartbeat from holder", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const { issueRun, storage } = createIssueRunWithStorage();

    await post(issueRun, "/dispatch", {
      runId: "run-1",
      workerId: "worker-1",
      leaseSec: 5,
    });
    await post(issueRun, "/ack", { accept: true, workerId: "worker-1" });

    now.mockReturnValue(3_000);
    const response = await post(issueRun, "/heartbeat", {
      protocol_version: "1.0.0",
      lastEventTs: 2_500,
    }, { "x-contrabass-worker-id": "worker-1" });

    expect(response.status).toBe(200);
    expect(await storage.getAlarm()).toBe(8_000);
    await expect(readIssueRunResponse(response)).resolves.toMatchObject({
      leaseExpiresAt: 8_000,
      run: {
        status: "running",
        leaseHolder: "worker-1",
        leaseExpiresAt: 8_000,
        leaseSec: 5,
      },
    });
  });

  it("rejects heartbeat from a non-holder without extending the lease", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const { issueRun, storage } = createIssueRunWithStorage();

    await post(issueRun, "/dispatch", {
      runId: "run-1",
      workerId: "worker-1",
      leaseSec: 5,
    });
    await post(issueRun, "/ack", { accept: true, workerId: "worker-1" });

    now.mockReturnValue(3_000);
    const response = await post(issueRun, "/heartbeat", {
      protocol_version: "1.0.0",
      lastEventTs: 2_500,
    }, { "x-contrabass-worker-id": "worker-2" });

    expect(response.status).toBe(409);
    expect(await storage.getAlarm()).toBe(6_000);
    await expect(readIssueRunResponse(response)).resolves.toMatchObject({
      protocol_version: "1.0.0",
      error: "lease_holder_mismatch",
    });

    const state = await readIssueRunResponse(await issueRun.fetch(new Request("https://issue-run.test/state")));
    expect(state.run).toMatchObject({
      status: "running",
      leaseHolder: "worker-1",
      leaseExpiresAt: 6_000,
      leaseSec: 5,
    });
  });

  it("rejects heartbeat after lease expiry without resetting the alarm", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const { issueRun, storage } = createIssueRunWithStorage();

    await post(issueRun, "/dispatch", {
      runId: "run-1",
      workerId: "worker-1",
      leaseSec: 5,
    });
    await post(issueRun, "/ack", { accept: true, workerId: "worker-1" });

    now.mockReturnValue(6_001);
    const response = await post(issueRun, "/heartbeat", {
      protocol_version: "1.0.0",
      lastEventTs: 5_500,
    }, { "x-contrabass-worker-id": "worker-1" });

    expect(response.status).toBe(409);
    expect(await storage.getAlarm()).toBe(6_000);
    await expect(readIssueRunResponse(response)).resolves.toMatchObject({
      protocol_version: "1.0.0",
      error: "lease_revoked",
    });
  });

  it("requeues rejected dispatch acknowledgements", async () => {
    const issueRun = createIssueRun();

    await post(issueRun, "/dispatch", { runId: "run-1" });
    const response = await post(issueRun, "/ack", { accept: false });

    expect(response.status).toBe(200);
    await expect(readIssueRunResponse(response)).resolves.toMatchObject({
      run: { status: "queued" },
      transition: { previous: "dispatched", current: "queued", changed: true },
    });
  });

  it("returns 409 for invalid transitions", async () => {
    const issueRun = createIssueRun();

    const response = await post(issueRun, "/complete", { status: "failed" });

    expect(response.status).toBe(409);
    await expect(readIssueRunResponse(response)).resolves.toMatchObject({
      error: "invalid_state_transition",
    });
  });

  it("appends running events, forwards them, and enqueues them for archival", async () => {
    vi.spyOn(Date, "now").mockReturnValue(10_000);
    const { issueRun, storage, queue, teamCoordinator } = createIssueRunWithBindings();

    await post(issueRun, "/dispatch", {
      runId: "run-1",
      teamId: "team-1",
      issueRef: "LIN-123",
      workerId: "worker-1",
      leaseSec: 30,
    });
    await post(issueRun, "/ack", { accept: true, workerId: "worker-1" });

    const event = {
      protocol_version: "1.0.0",
      ts: 9_500,
      kind: "phase",
      payload: {
        phase: "exec",
        label: "editing files",
      },
    };
    const response = await postNdjson(issueRun, "/events", `${JSON.stringify(event)}\n`, {
      "x-contrabass-worker-id": "worker-1",
    });

    expect(response.status).toBe(200);
    await expect(readIssueRunResponse(response)).resolves.toMatchObject({
      protocol_version: "1.0.0",
      accepted: 1,
    });

    const storedEvents = await storage.get<IssueRunStoredEvent[]>("issue-run:events");
    expect(storedEvents).toEqual([
      {
        protocol_version: "1.0.0",
        teamId: "team-1",
        runId: "run-1",
        issueRef: "LIN-123",
        workerId: "worker-1",
        receivedAt: 10_000,
        event,
      },
    ]);
    expect(queue.messages).toEqual(storedEvents);
    expect(teamCoordinator.names).toEqual(["team-1"]);
    expect(teamCoordinator.coordinator.requests).toHaveLength(1);
    const forwarded = teamCoordinator.coordinator.requests[0];
    expect(forwarded?.input).toBe("https://team-coordinator.internal/run-event");
    expect(JSON.parse(String(forwarded?.init?.body))).toEqual(storedEvents?.[0]);
  });

  it("rejects event batches for non-running runs without side effects", async () => {
    const { issueRun, storage, queue, teamCoordinator } = createIssueRunWithBindings();

    await post(issueRun, "/dispatch", {
      runId: "run-1",
      teamId: "team-1",
      issueRef: "LIN-123",
      workerId: "worker-1",
      leaseSec: 30,
    });
    const response = await postNdjson(issueRun, "/events", `${JSON.stringify({
      protocol_version: "1.0.0",
      ts: 9_500,
      kind: "phase",
      payload: { phase: "exec" },
    })}\n`, {
      "x-contrabass-worker-id": "worker-1",
    });

    expect(response.status).toBe(409);
    await expect(readIssueRunResponse(response)).resolves.toMatchObject({
      protocol_version: "1.0.0",
      error: "run_not_running",
    });
    await expect(storage.get<IssueRunStoredEvent[]>("issue-run:events")).resolves.toBeUndefined();
    expect(queue.messages).toEqual([]);
    expect(teamCoordinator.coordinator.requests).toEqual([]);
  });

  it("rejects event batches over the per-request event count limit", async () => {
    const { issueRun, queue, teamCoordinator } = createIssueRunWithBindings();

    await post(issueRun, "/dispatch", {
      runId: "run-1",
      teamId: "team-1",
      workerId: "worker-1",
      leaseSec: 30,
    });
    await post(issueRun, "/ack", { accept: true, workerId: "worker-1" });

    const line = JSON.stringify({
      protocol_version: "1.0.0",
      ts: 9_500,
      kind: "log",
      payload: { level: "info", message: "hello" },
    });
    const response = await postNdjson(issueRun, "/events", `${Array.from({ length: 201 }, () => line).join("\n")}\n`, {
      "x-contrabass-worker-id": "worker-1",
    });

    expect(response.status).toBe(413);
    await expect(readIssueRunResponse(response)).resolves.toMatchObject({
      error: "events_too_large",
      max_events: 200,
      max_bytes: 524288,
    });
    expect(queue.messages).toEqual([]);
    expect(teamCoordinator.coordinator.requests).toEqual([]);
  });
});

function createIssueRun(): IssueRun {
  return createIssueRunWithStorage().issueRun;
}

function createIssueRunWithStorage(): { issueRun: IssueRun; storage: MemoryIssueRunStorage } {
  const storage = new MemoryIssueRunStorage();
  return { issueRun: new IssueRun({ storage }, {}), storage };
}

function createIssueRunWithBindings(): {
  issueRun: IssueRun;
  storage: MemoryIssueRunStorage;
  queue: MemoryQueue<IssueRunStoredEvent>;
  teamCoordinator: MemoryTeamCoordinatorNamespace;
} {
  const storage = new MemoryIssueRunStorage();
  const queue = new MemoryQueue<IssueRunStoredEvent>();
  const teamCoordinator = new MemoryTeamCoordinatorNamespace();
  const env: IssueRunEnv = {
    EVENTS_ARCHIVE_QUEUE: queue,
    TEAM_COORDINATOR: teamCoordinator,
  };
  return { issueRun: new IssueRun({ storage }, env), storage, queue, teamCoordinator };
}

function post(
  issueRun: IssueRun,
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Response> {
  return issueRun.fetch(
    new Request(`https://issue-run.test${path}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", ...headers },
    }),
  );
}

function postNdjson(
  issueRun: IssueRun,
  path: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return issueRun.fetch(
    new Request(`https://issue-run.test${path}`, {
      method: "POST",
      body,
      headers: { "content-type": "application/x-ndjson", ...headers },
    }),
  );
}

async function readIssueRunResponse(response: Response): Promise<IssueRunResponseBody> {
  return (await response.json()) as IssueRunResponseBody;
}
