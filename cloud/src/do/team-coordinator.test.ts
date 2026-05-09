import { afterEach, describe, expect, it, vi } from "vitest";

import {
  TeamCoordinator,
  type TeamCoordinatorBoard,
  type TeamCoordinatorDispatchFrame,
  type TeamCoordinatorNotification,
  type TeamCoordinatorRecord,
  type TeamCoordinatorStorage,
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

type TeamCoordinatorResponseBody = {
  team?: TeamCoordinatorRecord;
  board?: TeamCoordinatorBoard;
  registry?: TeamCoordinatorWorkerRegistry;
  worker?: TeamCoordinatorWorkerRecord;
  dispatch?: TeamCoordinatorDispatchFrame;
  dispatched?: boolean;
  event?: TeamCoordinatorNotification;
  accepted?: boolean;
  type?: TeamCoordinatorNotification["type"];
  error?: string;
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
        runId: "run-1",
        teamId: "team-1",
        issueRef: "LIN-1",
        status: "succeeded",
        receivedAt: 2_000,
      },
      {
        type: "lease-revoked",
        protocol_version: "1.0.0",
        runId: "run-1",
        workerId: "worker-1",
        reason: "heartbeat_timeout",
        receivedAt: 2_000,
      },
      {
        type: "config-changed",
        protocol_version: "1.0.0",
        teamId: "team-1",
        activeContentHash: "cfg-2",
        receivedAt: 2_000,
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
