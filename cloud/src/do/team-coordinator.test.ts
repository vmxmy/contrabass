import { afterEach, describe, expect, it, vi } from "vitest";

import {
  TeamCoordinator,
  type TeamCoordinatorBoard,
  type TeamCoordinatorDispatchFrame,
  type TeamCoordinatorNotification,
  type TeamCoordinatorRecord,
  type TeamCoordinatorStorage,
  type TeamCoordinatorUsageCaps,
  type TeamCoordinatorWorkerRecord,
  type TeamCoordinatorWorkerRegistry,
} from "./team-coordinator";

class MemoryTeamCoordinatorStorage implements TeamCoordinatorStorage {
  private readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }
}

class FakeWebSocket extends EventTarget {
  readonly sent: string[] = [];
  peer?: FakeWebSocket;
  accepted = false;
  hibernationTags: string[] = [];

  accept(): void {
    this.accepted = true;
  }

  send(message: string): void {
    this.sent.push(message);
    this.peer?.dispatchEvent(new MessageEvent("message", { data: message }));
  }
}

class FakeWebSocketPair {
  readonly 0: FakeWebSocket;
  readonly 1: FakeWebSocket;

  constructor() {
    this[0] = new FakeWebSocket();
    this[1] = new FakeWebSocket();
    this[0].peer = this[1];
    this[1].peer = this[0];
    fakeWebSocketPairs.push(this);
  }
}

const fakeWebSocketPairs: FakeWebSocketPair[] = [];

class FakeIssueRunStub {
  readonly requests: Array<{ input: string | Request; init?: RequestInit }> = [];
  revokeResponse = Response.json({ run: { status: "queued" } });
  dispatchResponse = Response.json({ run: { status: "dispatched" } });
  cancelResponse = Response.json({ run: { status: "cancelled" } });

  async fetch(input: string | Request, init?: RequestInit): Promise<Response> {
    this.requests.push({ input, init });
    const pathname = typeof input === "string" ? new URL(input).pathname : new URL(input.url).pathname;
    if (pathname === "/revoke") {
      return this.revokeResponse;
    }
    if (pathname === "/dispatch") {
      return this.dispatchResponse;
    }
    if (pathname === "/cancel") {
      return this.cancelResponse;
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  }
}

class FakeIssueRunNamespace {
  readonly stub = new FakeIssueRunStub();
  readonly names: string[] = [];

  idFromName(name: string): string {
    this.names.push(name);
    return name;
  }

  get(): FakeIssueRunStub {
    return this.stub;
  }
}

type TeamCoordinatorResponseBody = {
  team?: TeamCoordinatorRecord;
  board?: TeamCoordinatorBoard;
  registry?: TeamCoordinatorWorkerRegistry;
  worker?: TeamCoordinatorWorkerRecord;
  dispatch?: TeamCoordinatorDispatchFrame;
  dispatched?: boolean;
  reassigned?: boolean;
  cancelled?: boolean;
  paused?: boolean;
  event?: TeamCoordinatorNotification;
  accepted?: boolean;
  type?: TeamCoordinatorNotification["type"];
  error?: string;
  max_active_workers?: number;
  max_runs_per_day?: number;
  max_events_per_day?: number;
  protocol_version?: string;
};

describe("TeamCoordinator Durable Object", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    fakeWebSocketPairs.length = 0;
    Reflect.deleteProperty(globalThis, "WebSocketPair");
  });

  it("materializes a team record on first request", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const { coordinator, storage } = createTeamCoordinatorWithStorage();

    const response = await coordinator.fetch(new Request("https://team-coordinator.test/state?teamId=team-1"));
    const body = await readTeamCoordinatorResponse(response);

    expect(response.status).toBe(200);
    expect(body.team).toEqual({
      teamId: "team-1",
      createdAt: 1_000,
      updatedAt: 1_000,
      paused: false,
    });
    await expect(storage.get<TeamCoordinatorRecord>("team-coordinator:record")).resolves.toEqual(body.team);
  });

  it("returns an empty storage-backed board", async () => {
    const { coordinator, storage } = createTeamCoordinatorWithStorage();

    const response = await coordinator.fetch(new Request("https://team-coordinator.test/board"));
    const body = await readTeamCoordinatorResponse(response);

    expect(response.status).toBe(200);
    expect(body.board).toEqual({ open: [], claimed: [], running: [], done: [] });
    await expect(storage.get<TeamCoordinatorBoard>("team-coordinator:board")).resolves.toEqual(body.board);
  });

  it("refreshes and persists board entries by phase", async () => {
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(10_000)
      .mockReturnValueOnce(10_000)
      .mockReturnValueOnce(10_000);
    const { coordinator, storage } = createTeamCoordinatorWithStorage();

    const response = await post(coordinator, "/board/refresh", {
      entries: [
        { issueRef: "LIN-1", phase: "open" },
        { issue_ref: "LIN-2", phase: "dispatched", run_id: "run-2", worker_id: "worker-2" },
        { issueRef: "LIN-3", phase: "running", runId: "run-3", assignedWorkerId: "worker-3" },
        { issueRef: "LIN-4", phase: "succeeded", lastUpdated: 9_000 },
      ],
    });
    const body = await readTeamCoordinatorResponse(response);

    expect(response.status).toBe(200);
    expect(body.board).toEqual({
      open: [{ issueRef: "LIN-1", phase: "open", lastUpdated: 10_000 }],
      claimed: [{ issueRef: "LIN-2", runId: "run-2", assignedWorkerId: "worker-2", phase: "claimed", lastUpdated: 10_000 }],
      running: [{ issueRef: "LIN-3", runId: "run-3", assignedWorkerId: "worker-3", phase: "running", lastUpdated: 10_000 }],
      done: [{ issueRef: "LIN-4", phase: "done", lastUpdated: 9_000 }],
    });
    await expect(storage.get<TeamCoordinatorBoard>("team-coordinator:board")).resolves.toEqual(body.board);
  });


  it("upserts refresh entries without dropping existing board state", async () => {
    vi.spyOn(Date, "now").mockReturnValue(12_000);
    const { coordinator } = createTeamCoordinatorWithStorage();

    await post(coordinator, "/board/refresh", {
      board: {
        open: [{ issueRef: "LIN-1", phase: "open", lastUpdated: 1_000 }],
        claimed: [],
        running: [],
        done: [],
      },
    });

    const response = await post(coordinator, "/board/refresh", {
      issueRef: "LIN-2",
      phase: "running",
      runId: "run-2",
      assignedWorkerId: "worker-2",
    });
    const body = await readTeamCoordinatorResponse(response);

    expect(body.board).toEqual({
      open: [{ issueRef: "LIN-1", phase: "open", lastUpdated: 1_000 }],
      claimed: [],
      running: [{ issueRef: "LIN-2", runId: "run-2", assignedWorkerId: "worker-2", phase: "running", lastUpdated: 12_000 }],
      done: [],
    });
  });

  it("registers workers as idle with zero load in memory and storage", async () => {
    vi.spyOn(Date, "now").mockReturnValue(20_000);
    const { coordinator, storage } = createTeamCoordinatorWithStorage();

    const response = await post(coordinator, "/workers/register", {
      workerId: "worker-1",
      capabilities: ["codex", "tmux"],
      maxConcurrency: 2,
      kind: "local",
      version: "0.2.0",
    }, { "x-contrabass-team-id": "team-1" });
    const body = await readTeamCoordinatorResponse(response);

    expect(response.status).toBe(200);
    expect(body.worker).toEqual({
      workerId: "worker-1",
      capabilities: ["codex", "tmux"],
      maxConcurrency: 2,
      currentLoad: 0,
      lastHeartbeatTs: 20_000,
      kind: "local",
      version: "0.2.0",
      status: "idle",
    });
    expect(body.registry).toEqual({ "worker-1": body.worker });
    await expect(storage.get<TeamCoordinatorWorkerRegistry>("team-coordinator:worker-registry")).resolves.toEqual(body.registry);

    const registryResponse = await coordinator.fetch(new Request("https://team-coordinator.test/workers"));
    await expect(readTeamCoordinatorResponse(registryResponse)).resolves.toMatchObject({
      registry: { "worker-1": body.worker },
    });
  });

  it("rejects new worker registration after the active worker cap is reached", async () => {
    vi.spyOn(Date, "now").mockReturnValue(21_000);
    const { coordinator, storage } = createTeamCoordinatorWithStorage();

    await post(coordinator, "/config-changed", {
      type: "config-changed",
      usageCaps: { max_active_workers: 1 },
    });
    await post(coordinator, "/workers/register", {
      workerId: "worker-1",
      capabilities: ["agent:codex"],
      maxConcurrency: 1,
      kind: "local",
      version: "0.2.0",
    });

    const response = await post(coordinator, "/workers/register", {
      workerId: "worker-2",
      capabilities: ["agent:codex"],
      maxConcurrency: 1,
      kind: "local",
      version: "0.2.0",
    });
    const body = await readTeamCoordinatorResponse(response);

    expect(response.status).toBe(429);
    expect(body).toMatchObject({
      error: "team_worker_cap_exceeded",
      max_active_workers: 1,
      protocol_version: "1.0.0",
    });
    await expect(storage.get<TeamCoordinatorWorkerRegistry>("team-coordinator:worker-registry")).resolves.toEqual({
      "worker-1": expect.objectContaining({ workerId: "worker-1" }),
    });
  });

  it("counts unhealthy registered workers toward the active worker cap", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(21_000);
    const { coordinator, storage } = createTeamCoordinatorWithStorage();

    await post(coordinator, "/config-changed", {
      type: "config-changed",
      usageCaps: { max_active_workers: 1 },
    });
    await post(coordinator, "/workers/register", {
      workerId: "worker-1",
      capabilities: ["agent:codex"],
      maxConcurrency: 1,
      kind: "local",
      version: "0.2.0",
    });

    now.mockReturnValue(112_000);
    await coordinator.fetch(new Request("https://team-coordinator.test/workers"));
    const response = await post(coordinator, "/workers/register", {
      workerId: "worker-2",
      capabilities: ["agent:codex"],
      maxConcurrency: 1,
      kind: "local",
      version: "0.2.0",
    });
    const body = await readTeamCoordinatorResponse(response);

    expect(response.status).toBe(429);
    expect(body).toMatchObject({
      error: "team_worker_cap_exceeded",
      max_active_workers: 1,
      protocol_version: "1.0.0",
    });
    await expect(storage.get<TeamCoordinatorWorkerRegistry>("team-coordinator:worker-registry")).resolves.toMatchObject({
      "worker-1": { status: "unhealthy" },
    });
  });

  it("ignores worker registration body caps when enforcing active worker limits", async () => {
    vi.spyOn(Date, "now").mockReturnValue(21_000);
    const { coordinator, storage } = createTeamCoordinatorWithStorage();

    await post(coordinator, "/config-changed", {
      type: "config-changed",
      usageCaps: { max_active_workers: 1 },
    });
    await post(coordinator, "/workers/register", {
      workerId: "worker-1",
      capabilities: ["agent:codex"],
      maxConcurrency: 1,
      kind: "local",
      version: "0.2.0",
    });

    const response = await post(coordinator, "/workers/register", {
      workerId: "worker-2",
      capabilities: ["agent:codex"],
      maxConcurrency: 1,
      kind: "local",
      version: "0.2.0",
      usageCaps: { max_active_workers: 2 },
    });
    const body = await readTeamCoordinatorResponse(response);

    expect(response.status).toBe(429);
    expect(body).toMatchObject({
      error: "team_worker_cap_exceeded",
      max_active_workers: 1,
    });
    await expect(storage.get<TeamCoordinatorUsageCaps>("team-coordinator:usage-caps")).resolves.toEqual({
      max_active_workers: 1,
    });
  });

  it("updates registry keepalive load and derives busy status", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(30_000);
    const { coordinator, storage } = createTeamCoordinatorWithStorage();

    await post(coordinator, "/workers/register", {
      workerId: "worker-1",
      capabilities: ["codex"],
      maxConcurrency: 2,
      kind: "container",
      version: "0.2.0",
    });

    now.mockReturnValue(31_000);
    const response = await post(coordinator, "/workers/heartbeat", {
      workerId: "worker-1",
      currentLoad: 1,
    });
    const body = await readTeamCoordinatorResponse(response);

    expect(response.status).toBe(200);
    expect(body.worker).toMatchObject({
      workerId: "worker-1",
      currentLoad: 1,
      lastHeartbeatTs: 31_000,
      kind: "container",
      status: "busy",
    });
    await expect(storage.get<TeamCoordinatorWorkerRegistry>("team-coordinator:worker-registry")).resolves.toMatchObject({
      "worker-1": { currentLoad: 1, status: "busy" },
    });
  });

  it("marks workers unhealthy after three missed registry heartbeats", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(40_000);
    const { coordinator, storage } = createTeamCoordinatorWithStorage();

    await post(coordinator, "/workers/register", {
      workerId: "worker-1",
      capabilities: ["codex"],
      maxConcurrency: 1,
      kind: "local",
      version: "0.2.0",
    });

    now.mockReturnValue(130_000);
    const response = await coordinator.fetch(new Request("https://team-coordinator.test/workers"));
    const body = await readTeamCoordinatorResponse(response);

    expect(response.status).toBe(200);
    expect(body.registry?.["worker-1"]).toMatchObject({
      workerId: "worker-1",
      status: "unhealthy",
      currentLoad: 0,
      lastHeartbeatTs: 40_000,
    });
    await expect(storage.get<TeamCoordinatorWorkerRegistry>("team-coordinator:worker-registry")).resolves.toMatchObject({
      "worker-1": { status: "unhealthy" },
    });
  });

  it("dispatches to the only available local worker matching capabilities", async () => {
    vi.spyOn(Date, "now").mockReturnValue(50_000);
    const { coordinator, storage } = createTeamCoordinatorWithStorage();

    await post(coordinator, "/workers/register", {
      workerId: "worker-1",
      capabilities: ["agent:codex", "tmux", "git"],
      maxConcurrency: 1,
      kind: "local",
      version: "0.2.0",
    });

    const response = await post(coordinator, "/dispatch", {
      runId: "run-1",
      issueRef: "LIN-1",
      requiredCapabilities: ["agent:codex", "tmux"],
      branch: "contrabass/LIN-1",
      prompt: "Fix LIN-1",
      configHash: "cfg-1",
      leaseSec: 60,
      artifactUploadURLs: { logs: "https://r2.test/logs" },
    });
    const body = await readTeamCoordinatorResponse(response);

    expect(response.status).toBe(200);
    expect(body.dispatched).toBe(true);
    expect(body.worker).toMatchObject({
      workerId: "worker-1",
      currentLoad: 1,
      status: "busy",
    });
    expect(body.dispatch).toEqual({
      type: "dispatch",
      protocol_version: "1.0.0",
      runId: "run-1",
      issueRef: "LIN-1",
      workerId: "worker-1",
      branch: "contrabass/LIN-1",
      prompt: "Fix LIN-1",
      configHash: "cfg-1",
      leaseSec: 60,
      artifactUploadURLs: { logs: "https://r2.test/logs" },
    });
    expect(body.board?.claimed).toEqual([
      {
        issueRef: "LIN-1",
        runId: "run-1",
        assignedWorkerId: "worker-1",
        phase: "claimed",
        lastUpdated: 50_000,
      },
    ]);
    await expect(storage.get<TeamCoordinatorWorkerRegistry>("team-coordinator:worker-registry")).resolves.toMatchObject({
      "worker-1": { currentLoad: 1, status: "busy" },
    });
  });

  it("rejects dispatch after the daily run cap is reached", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 4, 9, 12));
    const { coordinator, storage } = createTeamCoordinatorWithStorage();

    await post(coordinator, "/config-changed", {
      type: "config-changed",
      usage_caps: { max_runs_per_day: 1 },
    });
    await post(coordinator, "/workers/register", {
      workerId: "worker-1",
      capabilities: ["agent:codex"],
      maxConcurrency: 2,
      kind: "local",
      version: "0.2.0",
    });
    await post(coordinator, "/dispatch", {
      runId: "run-1",
      issueRef: "LIN-1",
      requiredCapabilities: ["agent:codex"],
    });

    const response = await post(coordinator, "/dispatch", {
      runId: "run-2",
      issueRef: "LIN-2",
      requiredCapabilities: ["agent:codex"],
    });
    const body = await readTeamCoordinatorResponse(response);

    expect(response.status).toBe(429);
    expect(body).toMatchObject({
      error: "team_run_cap_exceeded",
      max_runs_per_day: 1,
      protocol_version: "1.0.0",
    });
    await expect(storage.get<TeamCoordinatorBoard>("team-coordinator:board")).resolves.toMatchObject({
      claimed: [{ runId: "run-1" }],
    });
  });

  it("ignores dispatch body caps when enforcing daily run limits", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 4, 9, 12));
    const { coordinator, storage } = createTeamCoordinatorWithStorage();

    await post(coordinator, "/config-changed", {
      type: "config-changed",
      usage_caps: { max_runs_per_day: 1 },
    });
    await post(coordinator, "/workers/register", {
      workerId: "worker-1",
      capabilities: ["agent:codex"],
      maxConcurrency: 2,
      kind: "local",
      version: "0.2.0",
    });
    await post(coordinator, "/dispatch", {
      runId: "run-1",
      issueRef: "LIN-1",
      requiredCapabilities: ["agent:codex"],
    });

    const response = await post(coordinator, "/dispatch", {
      runId: "run-2",
      issueRef: "LIN-2",
      requiredCapabilities: ["agent:codex"],
      usage_caps: { max_runs_per_day: 2 },
    });
    const body = await readTeamCoordinatorResponse(response);

    expect(response.status).toBe(429);
    expect(body).toMatchObject({
      error: "team_run_cap_exceeded",
      max_runs_per_day: 1,
    });
    await expect(storage.get<TeamCoordinatorUsageCaps>("team-coordinator:usage-caps")).resolves.toEqual({
      max_runs_per_day: 1,
    });
  });

  it("rejects paused dispatches after accepted runs reach the daily cap", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 4, 9, 12));
    const { coordinator, storage } = createTeamCoordinatorWithStorage();

    await post(coordinator, "/config-changed", {
      type: "config-changed",
      usage_caps: { max_runs_per_day: 1 },
    });
    await post(coordinator, "/board/pause", {}, { "x-contrabass-team-id": "team-1" });
    const firstResponse = await post(coordinator, "/dispatch", {
      runId: "run-1",
      issueRef: "LIN-1",
      requiredCapabilities: ["agent:codex"],
    });

    const secondResponse = await post(coordinator, "/dispatch", {
      runId: "run-2",
      issueRef: "LIN-2",
      requiredCapabilities: ["agent:codex"],
    });
    const secondBody = await readTeamCoordinatorResponse(secondResponse);

    expect(firstResponse.status).toBe(202);
    expect(secondResponse.status).toBe(429);
    expect(secondBody).toMatchObject({
      error: "team_run_cap_exceeded",
      max_runs_per_day: 1,
      protocol_version: "1.0.0",
    });
    await expect(storage.get<TeamCoordinatorBoard>("team-coordinator:board")).resolves.toMatchObject({
      open: [{ runId: "run-1" }],
    });
  });

  it("counts no-worker queued dispatches against the daily run cap", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 4, 9, 12));
    const { coordinator } = createTeamCoordinatorWithStorage();

    await post(coordinator, "/config-changed", {
      type: "config-changed",
      usage_caps: { max_runs_per_day: 1 },
    });
    const firstResponse = await post(coordinator, "/dispatch", {
      runId: "run-1",
      issueRef: "LIN-1",
      requiredCapabilities: ["agent:omx"],
    });

    const secondResponse = await post(coordinator, "/dispatch", {
      runId: "run-2",
      issueRef: "LIN-2",
      requiredCapabilities: ["agent:omx"],
    });
    const secondBody = await readTeamCoordinatorResponse(secondResponse);

    expect(firstResponse.status).toBe(202);
    expect(secondResponse.status).toBe(429);
    expect(secondBody).toMatchObject({
      error: "team_run_cap_exceeded",
      max_runs_per_day: 1,
      protocol_version: "1.0.0",
    });
  });

  it("rejects invalid dispatch capabilities before paused queuing", async () => {
    const { coordinator, storage } = createTeamCoordinatorWithStorage();

    await post(coordinator, "/board/pause", {}, { "x-contrabass-team-id": "team-1" });
    const response = await post(coordinator, "/dispatch", {
      runId: "run-1",
      issueRef: "LIN-1",
      requiredCapabilities: ["agent:codex", 42],
    });
    const body = await readTeamCoordinatorResponse(response);

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      error: "invalid_request",
      message: "required capabilities must be strings",
    });
    await expect(storage.get<TeamCoordinatorBoard>("team-coordinator:board")).resolves.toBeUndefined();
  });

  it("prefers matching local workers over less-loaded containers", async () => {
    const { coordinator } = createTeamCoordinatorWithStorage();

    await post(coordinator, "/workers/register", {
      workerId: "container-1",
      capabilities: ["agent:codex"],
      maxConcurrency: 3,
      kind: "container",
      version: "0.2.0",
    });
    await post(coordinator, "/workers/heartbeat", {
      workerId: "container-1",
      currentLoad: 0,
    });
    await post(coordinator, "/workers/register", {
      workerId: "local-1",
      capabilities: ["agent:codex"],
      maxConcurrency: 3,
      kind: "local",
      version: "0.2.0",
    });
    await post(coordinator, "/workers/heartbeat", {
      workerId: "local-1",
      currentLoad: 2,
    });

    const response = await post(coordinator, "/dispatch", {
      runId: "run-1",
      issueRef: "LIN-1",
      capabilities: ["agent:codex"],
    });
    const body = await readTeamCoordinatorResponse(response);

    expect(response.status).toBe(200);
    expect(body.worker?.workerId).toBe("local-1");
    expect(body.dispatch?.workerId).toBe("local-1");
  });

  it("selects the least-loaded matching worker when kinds match", async () => {
    const { coordinator } = createTeamCoordinatorWithStorage();

    await post(coordinator, "/workers/register", {
      workerId: "local-busy",
      capabilities: ["agent:codex", "git"],
      maxConcurrency: 3,
      kind: "local",
      version: "0.2.0",
    });
    await post(coordinator, "/workers/heartbeat", {
      workerId: "local-busy",
      currentLoad: 2,
    });
    await post(coordinator, "/workers/register", {
      workerId: "local-less-loaded",
      capabilities: ["agent:codex", "git"],
      maxConcurrency: 3,
      kind: "local",
      version: "0.2.0",
    });
    await post(coordinator, "/workers/heartbeat", {
      workerId: "local-less-loaded",
      currentLoad: 1,
    });

    const response = await post(coordinator, "/dispatch", {
      runId: "run-1",
      issueRef: "LIN-1",
      requirements: { capabilities: ["agent:codex", "git"] },
    });
    const body = await readTeamCoordinatorResponse(response);

    expect(response.status).toBe(200);
    expect(body.worker?.workerId).toBe("local-less-loaded");
  });

  it("leaves runs queued and emits no-worker-available when nothing matches", async () => {
    vi.spyOn(Date, "now").mockReturnValue(60_000);
    const { coordinator, storage } = createTeamCoordinatorWithStorage();

    await post(coordinator, "/workers/register", {
      workerId: "worker-1",
      capabilities: ["agent:codex"],
      maxConcurrency: 1,
      kind: "local",
      version: "0.2.0",
    });

    const response = await post(coordinator, "/dispatch", {
      runId: "run-1",
      issueRef: "LIN-1",
      required_capabilities: ["agent:omx"],
    });
    const body = await readTeamCoordinatorResponse(response);

    expect(response.status).toBe(202);
    expect(body).toMatchObject({
      dispatched: false,
      event: {
        eventId: "1",
        type: "no-worker-available",
        receivedAt: 60_000,
        payload: {
          runId: "run-1",
          issueRef: "LIN-1",
          requiredCapabilities: ["agent:omx"],
        },
      },
    });
    await expect(storage.get<TeamCoordinatorBoard>("team-coordinator:board")).resolves.toBeUndefined();
    await expect(storage.get<TeamCoordinatorNotification[]>("team-coordinator:notifications")).resolves.toMatchObject([
      { type: "no-worker-available" },
    ]);
  });

  it.each([
    ["/run-event", "run-event"],
    ["/run-complete", "run-complete"],
    ["/lease-revoked", "lease-revoked"],
    ["/config-changed", "config-changed"],
  ] satisfies Array<[string, TeamCoordinatorNotification["type"]]>)(
    "accepts IssueRun forwarded %s notifications",
    async (path, type) => {
      vi.spyOn(Date, "now")
        .mockReturnValueOnce(1_000)
        .mockReturnValueOnce(2_000);
      const { coordinator, storage } = createTeamCoordinatorWithStorage();

      const response = await post(coordinator, path, { runId: "run-1" }, { "x-contrabass-team-id": "team-1" });
      const body = await readTeamCoordinatorResponse(response);

      expect(response.status).toBe(200);
      expect(body).toEqual({ accepted: true, type });
      await expect(storage.get<TeamCoordinatorNotification[]>("team-coordinator:notifications")).resolves.toEqual([
        {
          eventId: "1",
          type,
          receivedAt: 2_000,
          payload: { runId: "run-1" },
        },
      ]);
      await expect(storage.get<TeamCoordinatorRecord>("team-coordinator:record")).resolves.toMatchObject({
        teamId: "team-1",
        updatedAt: 2_000,
      });
    },
  );

  it("rejects run events after the daily event cap is reached", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 4, 9, 12));
    const { coordinator, storage } = createTeamCoordinatorWithStorage();

    await post(coordinator, "/config-changed", {
      type: "config-changed",
      config: { max_events_per_day: 1 },
    });
    await post(coordinator, "/run-event", { runId: "run-1", event: { kind: "phase" } });

    const response = await post(coordinator, "/run-event", { runId: "run-1", event: { kind: "log" } });
    const body = await readTeamCoordinatorResponse(response);

    expect(response.status).toBe(429);
    expect(body).toMatchObject({
      error: "team_event_cap_exceeded",
      max_events_per_day: 1,
      protocol_version: "1.0.0",
    });
    await expect(storage.get<TeamCoordinatorNotification[]>("team-coordinator:notifications")).resolves.toHaveLength(2);
  });

  it("ignores run-event body caps when enforcing daily event limits", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 4, 9, 12));
    const { coordinator, storage } = createTeamCoordinatorWithStorage();

    await post(coordinator, "/config-changed", {
      type: "config-changed",
      config: { max_events_per_day: 1 },
    });
    await post(coordinator, "/run-event", { runId: "run-1", event: { kind: "phase" } });

    const response = await post(coordinator, "/run-event", {
      runId: "run-1",
      event: { kind: "log" },
      usageCaps: { max_events_per_day: 2 },
    });
    const body = await readTeamCoordinatorResponse(response);

    expect(response.status).toBe(429);
    expect(body).toMatchObject({
      error: "team_event_cap_exceeded",
      max_events_per_day: 1,
    });
    await expect(storage.get<TeamCoordinatorUsageCaps>("team-coordinator:usage-caps")).resolves.toEqual({
      max_events_per_day: 1,
    });
  });

  it("accepts websocket subscribers and fans out stored notification frames", async () => {
    vi.spyOn(Date, "now").mockReturnValue(2_000);
    Reflect.set(globalThis, "WebSocketPair", FakeWebSocketPair);
    const coordinator = createTeamCoordinator();

    const response = await coordinator.fetch(new Request("https://team-coordinator.test/subscribe", {
      headers: { upgrade: "websocket" },
    }));

    expect([101, 200]).toContain(response.status);
    const server = fakeWebSocketPairs[0]?.[1];
    expect(server?.accepted).toBe(true);
    expect(server?.sent.map((message) => JSON.parse(message))).toEqual([
      {
        type: "board-update",
        protocol_version: "1.0.0",
        board: { open: [], claimed: [], running: [], done: [] },
      },
    ]);

    await post(coordinator, "/run-event", {
      protocol_version: "1.0.0",
      teamId: "team-1",
      runId: "run-1",
      event: { kind: "phase" },
    });
    await post(coordinator, "/run-complete", {
      type: "run-complete",
      protocol_version: "1.0.0",
      runId: "run-1",
      teamId: "team-1",
      issueRef: "LIN-1",
      status: "succeeded",
    });
    await post(coordinator, "/lease-revoked", {
      type: "lease-revoked",
      protocol_version: "1.0.0",
      runId: "run-1",
      workerId: "worker-1",
      reason: "heartbeat_timeout",
    });
    await post(coordinator, "/config-changed", {
      type: "config-changed",
      protocol_version: "1.0.0",
      teamId: "team-1",
      activeContentHash: "cfg-2",
    });

    expect(server?.sent.slice(1).map((message) => JSON.parse(message))).toEqual([
      {
        type: "run-event",
        protocol_version: "1.0.0",
        event_id: "1",
        receivedAt: 2_000,
        payload: {
          protocol_version: "1.0.0",
          teamId: "team-1",
          runId: "run-1",
          event: { kind: "phase" },
        },
      },
      {
        type: "run-complete",
        protocol_version: "1.0.0",
        event_id: "2",
        runId: "run-1",
        teamId: "team-1",
        issueRef: "LIN-1",
        status: "succeeded",
        receivedAt: 2_000,
      },
      {
        type: "lease-revoked",
        protocol_version: "1.0.0",
        event_id: "3",
        runId: "run-1",
        workerId: "worker-1",
        reason: "heartbeat_timeout",
        receivedAt: 2_000,
      },
      {
        type: "config-changed",
        protocol_version: "1.0.0",
        event_id: "4",
        teamId: "team-1",
        activeContentHash: "cfg-2",
        receivedAt: 2_000,
      },
    ]);
  });

  it("replays missed notifications after last_event_id from a 100-event ring buffer", async () => {
    vi.spyOn(Date, "now").mockReturnValue(4_000);
    Reflect.set(globalThis, "WebSocketPair", FakeWebSocketPair);
    const { coordinator, storage } = createTeamCoordinatorWithStorage();

    for (let index = 1; index <= 102; index += 1) {
      await post(coordinator, "/run-event", {
        protocol_version: "1.0.0",
        teamId: "team-1",
        runId: `run-${index}`,
        event: { kind: "phase", index },
      });
    }

    const storedNotifications = await storage.get<TeamCoordinatorNotification[]>("team-coordinator:notifications");
    expect(storedNotifications).toHaveLength(100);
    expect(storedNotifications?.[0]?.eventId).toBe("3");
    expect(storedNotifications?.at(-1)?.eventId).toBe("102");

    const response = await coordinator.fetch(new Request("https://team-coordinator.test/subscribe?last_event_id=100", {
      headers: { upgrade: "websocket" },
    }));

    expect([101, 200]).toContain(response.status);
    const server = fakeWebSocketPairs[0]?.[1];
    expect(server?.sent.slice(1).map((message) => JSON.parse(message))).toEqual([
      {
        type: "run-event",
        protocol_version: "1.0.0",
        event_id: "101",
        receivedAt: 4_000,
        payload: {
          protocol_version: "1.0.0",
          teamId: "team-1",
          runId: "run-101",
          event: { kind: "phase", index: 101 },
        },
      },
      {
        type: "run-event",
        protocol_version: "1.0.0",
        event_id: "102",
        receivedAt: 4_000,
        payload: {
          protocol_version: "1.0.0",
          teamId: "team-1",
          runId: "run-102",
          event: { kind: "phase", index: 102 },
        },
      },
    ]);
  });

  it("uses WebSocket Hibernation for dashboard subscribers", async () => {
    vi.spyOn(Date, "now").mockReturnValue(3_000);
    Reflect.set(globalThis, "WebSocketPair", FakeWebSocketPair);
    const storage = new MemoryTeamCoordinatorStorage();
    const hibernationSockets: FakeWebSocket[] = [];
    const hibernationState = {
      storage,
      acceptWebSocket(socket: WebSocket, tags?: string[]): void {
        const fakeSocket = socket as unknown as FakeWebSocket;
        fakeSocket.hibernationTags = tags ?? [];
        hibernationSockets.push(fakeSocket);
      },
      getWebSockets(tag?: string): WebSocket[] {
        return hibernationSockets
          .filter((socket) => tag === undefined || socket.hibernationTags.includes(tag))
          .map((socket) => socket as unknown as WebSocket);
      },
    };
    const coordinator = new TeamCoordinator(hibernationState);

    const response = await coordinator.fetch(new Request("https://team-coordinator.test/subscribe", {
      headers: { upgrade: "websocket" },
    }));

    expect([101, 200]).toContain(response.status);
    const server = fakeWebSocketPairs[0]?.[1];
    expect(server?.accepted).toBe(false);
    expect(server?.hibernationTags).toEqual(["dashboard"]);
    expect(server?.sent.map((message) => JSON.parse(message))).toEqual([
      {
        type: "board-update",
        protocol_version: "1.0.0",
        board: { open: [], claimed: [], running: [], done: [] },
      },
    ]);

    const resumedCoordinator = new TeamCoordinator(hibernationState);
    await post(resumedCoordinator, "/config-changed", {
      type: "config-changed",
      protocol_version: "1.0.0",
      teamId: "team-1",
      activeContentHash: "cfg-3",
    });

    expect(server?.sent.slice(1).map((message) => JSON.parse(message))).toEqual([
      {
        type: "config-changed",
        protocol_version: "1.0.0",
        event_id: "1",
        teamId: "team-1",
        activeContentHash: "cfg-3",
        receivedAt: 3_000,
      },
    ]);
  });

  it("routes dispatch frames only to the selected worker subscriber", async () => {
    vi.spyOn(Date, "now").mockReturnValue(50_000);
    Reflect.set(globalThis, "WebSocketPair", FakeWebSocketPair);
    const coordinator = createTeamCoordinator();

    await coordinator.fetch(new Request("https://team-coordinator.test/subscribe", {
      headers: { upgrade: "websocket" },
    }));
    await coordinator.fetch(new Request("https://team-coordinator.test/subscribe?workerId=worker-1", {
      headers: { upgrade: "websocket" },
    }));
    await coordinator.fetch(new Request("https://team-coordinator.test/subscribe?workerId=worker-2", {
      headers: { upgrade: "websocket" },
    }));

    await post(coordinator, "/workers/register", {
      workerId: "worker-1",
      capabilities: ["agent:codex"],
      maxConcurrency: 1,
      kind: "local",
      version: "0.2.0",
    });
    await post(coordinator, "/workers/register", {
      workerId: "worker-2",
      capabilities: ["agent:codex"],
      maxConcurrency: 1,
      kind: "local",
      version: "0.2.0",
    });

    const response = await post(coordinator, "/dispatch", {
      runId: "run-1",
      issueRef: "LIN-1",
      requiredCapabilities: ["agent:codex"],
      prompt: "Fix LIN-1",
      leaseSec: 60,
      artifactUploadURLs: { logs: "https://r2.test/logs" },
    });
    const body = await readTeamCoordinatorResponse(response);

    expect(response.status).toBe(200);
    expect(body.dispatch?.workerId).toBe("worker-1");
    const dashboardServer = fakeWebSocketPairs[0]?.[1];
    const selectedWorkerServer = fakeWebSocketPairs[1]?.[1];
    const otherWorkerServer = fakeWebSocketPairs[2]?.[1];

    expect(dashboardServer?.sent.map((message) => JSON.parse(message))).toEqual([
      {
        type: "board-update",
        protocol_version: "1.0.0",
        board: { open: [], claimed: [], running: [], done: [] },
      },
      {
        type: "worker-status",
        protocol_version: "1.0.0",
        worker: expect.objectContaining({ workerId: "worker-1" }),
      },
      {
        type: "worker-status",
        protocol_version: "1.0.0",
        worker: expect.objectContaining({ workerId: "worker-2" }),
      },
      {
        type: "worker-status",
        protocol_version: "1.0.0",
        worker: expect.objectContaining({ workerId: "worker-1", currentLoad: 1, status: "busy" }),
      },
      {
        type: "board-update",
        protocol_version: "1.0.0",
        board: expect.objectContaining({
          claimed: [expect.objectContaining({
            issueRef: "LIN-1",
            runId: "run-1",
            assignedWorkerId: "worker-1",
          })],
        }),
      },
    ]);
    expect(selectedWorkerServer?.sent.map((message) => JSON.parse(message))).toEqual([
      {
        type: "dispatch",
        protocol_version: "1.0.0",
        runId: "run-1",
        issueRef: "LIN-1",
        workerId: "worker-1",
        prompt: "Fix LIN-1",
        leaseSec: 60,
        artifactUploadURLs: { logs: "https://r2.test/logs" },
      },
    ]);
    expect(otherWorkerServer?.sent).toEqual([]);
  });

  it("pauses and resumes dispatch without dropping queued arrivals", async () => {
    vi.spyOn(Date, "now").mockReturnValue(70_000);
    const { coordinator, storage } = createTeamCoordinatorWithStorage();

    const pauseResponse = await post(coordinator, "/board/pause", {}, { "x-contrabass-team-id": "team-1" });
    const pauseBody = await readTeamCoordinatorResponse(pauseResponse);
    expect(pauseResponse.status).toBe(200);
    expect(pauseBody.team).toMatchObject({ teamId: "team-1", paused: true, updatedAt: 70_000 });

    await post(coordinator, "/workers/register", {
      workerId: "worker-1",
      capabilities: ["agent:codex"],
      maxConcurrency: 1,
      kind: "local",
      version: "0.2.0",
    });
    const dispatchResponse = await post(coordinator, "/dispatch", {
      runId: "run-1",
      issueRef: "LIN-1",
      requiredCapabilities: ["agent:codex"],
    }, { "x-contrabass-team-id": "team-1" });
    const dispatchBody = await readTeamCoordinatorResponse(dispatchResponse);

    expect(dispatchResponse.status).toBe(202);
    expect(dispatchBody).toMatchObject({
      dispatched: false,
      paused: true,
      board: { open: [{ issueRef: "LIN-1", runId: "run-1", phase: "open", lastUpdated: 70_000 }] },
    });
    await expect(storage.get<TeamCoordinatorWorkerRegistry>("team-coordinator:worker-registry")).resolves.toMatchObject({
      "worker-1": { currentLoad: 0, status: "idle" },
    });

    const resumeResponse = await post(coordinator, "/board/resume", {}, { "x-contrabass-team-id": "team-1" });
    await expect(readTeamCoordinatorResponse(resumeResponse)).resolves.toMatchObject({
      team: { teamId: "team-1", paused: false, updatedAt: 70_000 },
    });
  });

  it("reassigns a run through IssueRun and dispatches to the target worker", async () => {
    vi.spyOn(Date, "now").mockReturnValue(80_000);
    Reflect.set(globalThis, "WebSocketPair", FakeWebSocketPair);
    const { coordinator, issueRun } = createTeamCoordinatorWithIssueRun();

    await coordinator.fetch(new Request("https://team-coordinator.test/subscribe?workerId=worker-old", {
      headers: { upgrade: "websocket" },
    }));
    await coordinator.fetch(new Request("https://team-coordinator.test/subscribe?workerId=worker-new", {
      headers: { upgrade: "websocket" },
    }));
    await post(coordinator, "/workers/register", {
      workerId: "worker-old",
      capabilities: ["agent:codex"],
      maxConcurrency: 2,
      kind: "local",
      version: "0.2.0",
    });
    await post(coordinator, "/workers/heartbeat", { workerId: "worker-old", currentLoad: 1 });
    await post(coordinator, "/workers/register", {
      workerId: "worker-new",
      capabilities: ["agent:codex"],
      maxConcurrency: 2,
      kind: "local",
      version: "0.2.0",
    });
    await post(coordinator, "/board/refresh", {
      issueRef: "LIN-1",
      runId: "run-1",
      assignedWorkerId: "worker-old",
      phase: "running",
    });

    const response = await post(coordinator, "/board/reassign-run", {
      runId: "run-1",
      targetWorkerId: "worker-new",
      prompt: "Continue LIN-1",
      configHash: "cfg-1",
    }, { "x-contrabass-team-id": "team-1" });
    const body = await readTeamCoordinatorResponse(response);

    expect(response.status).toBe(200);
    expect(issueRun.names).toEqual(["team-1:LIN-1"]);
    expect(issueRun.stub.requests.map((request) => typeof request.input === "string" ? new URL(request.input).pathname : "")).toEqual([
      "/revoke",
      "/dispatch",
    ]);
    expect(JSON.parse(String(issueRun.stub.requests[0]?.init?.body))).toEqual({ reason: "manual_reassign" });
    expect(JSON.parse(String(issueRun.stub.requests[1]?.init?.body))).toMatchObject({
      type: "dispatch",
      runId: "run-1",
      issueRef: "LIN-1",
      workerId: "worker-new",
      prompt: "Continue LIN-1",
      configHash: "cfg-1",
    });
    expect(body).toMatchObject({
      reassigned: true,
      dispatch: { runId: "run-1", workerId: "worker-new" },
      registry: {
        "worker-old": { currentLoad: 0, status: "idle" },
        "worker-new": { currentLoad: 1, status: "busy" },
      },
      board: {
        claimed: [{ issueRef: "LIN-1", runId: "run-1", assignedWorkerId: "worker-new" }],
        running: [],
      },
    });
    expect(fakeWebSocketPairs[1]?.[1].sent.map((message) => JSON.parse(message))).toEqual([
      expect.objectContaining({ type: "dispatch", runId: "run-1", workerId: "worker-new" }),
    ]);
  });

  it("cancels a run through IssueRun and marks the board entry done", async () => {
    vi.spyOn(Date, "now").mockReturnValue(90_000);
    const { coordinator, issueRun } = createTeamCoordinatorWithIssueRun();

    await post(coordinator, "/workers/register", {
      workerId: "worker-1",
      capabilities: ["agent:codex"],
      maxConcurrency: 2,
      kind: "local",
      version: "0.2.0",
    });
    await post(coordinator, "/workers/heartbeat", { workerId: "worker-1", currentLoad: 1 });
    await post(coordinator, "/board/refresh", {
      issueRef: "LIN-1",
      runId: "run-1",
      assignedWorkerId: "worker-1",
      phase: "running",
    });

    const response = await post(coordinator, "/board/cancel-run", {
      runId: "run-1",
      finalConfigHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    }, { "x-contrabass-team-id": "team-1" });
    const body = await readTeamCoordinatorResponse(response);

    expect(response.status).toBe(200);
    expect(issueRun.names).toEqual(["team-1:LIN-1"]);
    expect(issueRun.stub.requests.map((request) => typeof request.input === "string" ? new URL(request.input).pathname : "")).toEqual(["/cancel"]);
    expect(JSON.parse(String(issueRun.stub.requests[0]?.init?.body))).toMatchObject({
      runId: "run-1",
      finalConfigHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    });
    expect(body).toMatchObject({
      cancelled: true,
      registry: { "worker-1": { currentLoad: 0, status: "idle" } },
      board: {
        running: [],
        done: [{ issueRef: "LIN-1", runId: "run-1", assignedWorkerId: "worker-1", phase: "done", lastUpdated: 90_000 }],
      },
    });
  });

  it("forwards lease-revoked notifications to the affected worker subscriber", async () => {
    vi.spyOn(Date, "now").mockReturnValue(95_000);
    Reflect.set(globalThis, "WebSocketPair", FakeWebSocketPair);
    const coordinator = createTeamCoordinator();

    await coordinator.fetch(new Request("https://team-coordinator.test/subscribe", {
      headers: { upgrade: "websocket" },
    }));
    await coordinator.fetch(new Request("https://team-coordinator.test/subscribe?workerId=worker-1", {
      headers: { upgrade: "websocket" },
    }));

    await post(coordinator, "/lease-revoked", {
      type: "lease-revoked",
      protocol_version: "1.0.0",
      runId: "run-1",
      workerId: "worker-1",
      reason: "manual_reassign",
    });

    expect(fakeWebSocketPairs[1]?.[1].sent.map((message) => JSON.parse(message))).toEqual([
      {
        type: "lease-revoked",
        protocol_version: "1.0.0",
        event_id: "1",
        runId: "run-1",
        workerId: "worker-1",
        reason: "manual_reassign",
        receivedAt: 95_000,
      },
    ]);
  });

  it("rejects non-websocket subscribe requests", async () => {
    const coordinator = createTeamCoordinator();

    const response = await coordinator.fetch(new Request("https://team-coordinator.test/subscribe"));

    expect(response.status).toBe(426);
    await expect(readTeamCoordinatorResponse(response)).resolves.toMatchObject({
      error: "websocket_required",
    });
  });
});

function createTeamCoordinator(): TeamCoordinator {
  return createTeamCoordinatorWithStorage().coordinator;
}

function createTeamCoordinatorWithStorage(): {
  coordinator: TeamCoordinator;
  storage: MemoryTeamCoordinatorStorage;
} {
  const storage = new MemoryTeamCoordinatorStorage();
  return {
    coordinator: new TeamCoordinator({ storage }),
    storage,
  };
}

function createTeamCoordinatorWithIssueRun(): {
  coordinator: TeamCoordinator;
  storage: MemoryTeamCoordinatorStorage;
  issueRun: FakeIssueRunNamespace;
} {
  const storage = new MemoryTeamCoordinatorStorage();
  const issueRun = new FakeIssueRunNamespace();
  return {
    coordinator: new TeamCoordinator({ storage }, { ISSUE_RUN: issueRun }),
    storage,
    issueRun,
  };
}

function post(
  coordinator: TeamCoordinator,
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Response> {
  return coordinator.fetch(new Request(`https://team-coordinator.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  }));
}

async function readTeamCoordinatorResponse(response: Response): Promise<TeamCoordinatorResponseBody> {
  return await response.json() as TeamCoordinatorResponseBody;
}
