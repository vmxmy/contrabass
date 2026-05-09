import { afterEach, describe, expect, it, vi } from "vitest";

import {
  TeamCoordinator,
  type TeamCoordinatorBoard,
  type TeamCoordinatorNotification,
  type TeamCoordinatorRecord,
  type TeamCoordinatorStorage,
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

  it.each([
    ["/run-event", "run-event"],
    ["/run-complete", "run-complete"],
    ["/lease-revoked", "lease-revoked"],
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

    expect(response.status).toBe(200);
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
