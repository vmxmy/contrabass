import { describe, expect, it } from "vitest";

import { IssueRun, type IssueRunStorage, type IssueRunStorageTransaction } from "../do/issue-run";
import { TeamCoordinator, type TeamCoordinatorStorage } from "../do/team-coordinator";
import { handleWorkerRequest, type Env } from "./index";

const TEAM_ID = "synthetic-smoke";
const WORKER_ID = "mock-worker-1";
const ISSUE_REF = "SMOKE-1";
const RUN_ID = "run-SMOKE-1-smoke";
const SMOKE_TOKEN = "smoke-token";
const FAKE_CONFIG_HASH = "a".repeat(64);

class MemCoordStorage implements TeamCoordinatorStorage {
  private readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }
}

class MemRunStorage implements IssueRunStorage {
  private readonly values = new Map<string, unknown>();
  private txLock: Promise<void> = Promise.resolve();
  private alarm: number | null = null;

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }

  async transaction<T>(closure: (txn: IssueRunStorageTransaction) => Promise<T> | T): Promise<T> {
    const previous = this.txLock;
    let release = () => {};
    this.txLock = new Promise<void>((resolve) => {
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

function makeTestEnv() {
  const coordStorage = new MemCoordStorage();
  const runInstances = new Map<string, IssueRun>();
  let coord: TeamCoordinator;

  const coordStub = {
    fetch(input: string | Request, init?: RequestInit): Promise<Response> {
      const req = typeof input === "string" ? new Request(input, init) : input;
      return coord.fetch(req);
    },
  };

  const coordNamespace = {
    idFromName: (_name: string) => _name,
    get: (_id: unknown) => coordStub,
  };

  const runNamespace = {
    idFromName: (name: string) => name,
    get: (id: unknown) => {
      const key = id as string;
      if (!runInstances.has(key)) {
        runInstances.set(
          key,
          new IssueRun(
            { storage: new MemRunStorage() },
            { TEAM_COORDINATOR: coordNamespace },
          ),
        );
      }
      const run = runInstances.get(key)!;
      return {
        fetch(input: string | Request, init?: RequestInit): Promise<Response> {
          const req = typeof input === "string" ? new Request(input, init) : input;
          return run.fetch(req);
        },
      };
    },
  };

  coord = new TeamCoordinator(
    { storage: coordStorage },
    { ISSUE_RUN: runNamespace },
  );

  const env = {
    TEAM_COORDINATOR: coordNamespace,
    ISSUE_RUN: runNamespace,
    CONTRABASS_WORKER_SESSION_TOKENS: SMOKE_TOKEN,
    CONTRABASS_WORKER_TOKEN_SECRET: "smoke-secret",
    EVENTS_ARCHIVE_BUCKET: {},
    EVENTS_ARCHIVE_QUEUE: { send: async () => {} },
  } as unknown as Env;

  return { coord, runNamespace, env };
}

describe("smoke: end-to-end worker lifecycle", () => {
  it("register → issue inject → dispatch → ack → events → complete → board updates", async () => {
    const { coord, runNamespace, env } = makeTestEnv();
    const auth = { authorization: `Bearer ${SMOKE_TOKEN}` };
    const team = { "x-contrabass-team-id": TEAM_ID };
    const json = { "content-type": "application/json" };

    // Step 1: Register mock worker
    const regRes = await handleWorkerRequest(
      new Request("https://api.test/v1/workers/register", {
        method: "POST",
        headers: { ...auth, ...json },
        body: JSON.stringify({
          teamId: TEAM_ID,
          workerId: WORKER_ID,
          capabilities: ["agent:mock"],
          maxConcurrency: 1,
          version: "0.1.0",
          supported_protocol_versions: ["1.0.0"],
          protocol_version: "1.0.0",
        }),
      }),
      env,
    );
    expect(regRes.status, "register").toBe(200);
    const regBody = await regRes.json() as Record<string, unknown>;
    expect(typeof regBody.sessionToken, "register sessionToken").toBe("string");

    // Step 2: Tracker poller injects a fake issue onto the open board
    const injectRes = await coord.fetch(
      new Request("https://team-coordinator.internal/board/refresh", {
        method: "POST",
        headers: { ...json, ...team },
        body: JSON.stringify({
          entries: [{ issueRef: ISSUE_REF, phase: "open" }],
        }),
      }),
    );
    expect(injectRes.status, "inject issue").toBe(200);
    const { board: board1 } = await injectRes.json() as { board: Record<string, unknown[]> };
    expect(board1.open, "issue injected to open").toHaveLength(1);

    // Step 3: Dispatch the issue — coordinator picks the worker and queues a dispatch frame
    const dispatchRes = await coord.fetch(
      new Request("https://team-coordinator.internal/dispatch", {
        method: "POST",
        headers: { ...json, ...team },
        body: JSON.stringify({
          runId: RUN_ID,
          issueRef: ISSUE_REF,
          teamId: TEAM_ID,
          prompt: "Fix SMOKE-1",
        }),
      }),
    );
    expect(dispatchRes.status, "dispatch run").toBe(200);
    const { dispatched } = await dispatchRes.json() as { dispatched: boolean };
    expect(dispatched, "dispatched flag").toBe(true);

    // Step 4: Pre-seed IssueRun metadata.
    // TeamCoordinator.dispatchRun does not call IssueRun /dispatch, so the IssueRun has no
    // teamId/runId/issueRef/workerKind yet. This replicates what reassignRun does internally.
    const runKey = `${TEAM_ID}:${ISSUE_REF}`;
    const runPreSeedRes = await runNamespace.get(runKey).fetch(
      new Request("https://issue-run.internal/dispatch", {
        method: "POST",
        headers: { ...json },
        body: JSON.stringify({
          runId: RUN_ID,
          issueRef: ISSUE_REF,
          teamId: TEAM_ID,
          workerId: WORKER_ID,
          leaseSec: 60,
          kind: "local",
        }),
      }),
    );
    expect(runPreSeedRes.status, "pre-seed IssueRun").toBe(200);

    // Step 5: Worker long-polls for dispatch frame (queued by dispatchRun in step 3)
    const pollRes = await handleWorkerRequest(
      new Request(`https://api.test/v1/workers/${WORKER_ID}/dispatch?wait=0s`, {
        headers: { ...auth, ...team },
      }),
      env,
    );
    expect(pollRes.status, "long-poll dispatch").toBe(200);
    const frame = await pollRes.json() as Record<string, unknown>;
    expect(frame.type, "dispatch frame type").toBe("dispatch");
    expect(frame.runId, "dispatch frame runId").toBe(RUN_ID);
    expect(frame.issueRef, "dispatch frame issueRef").toBe(ISSUE_REF);

    // Step 6: Worker acks the dispatch — IssueRun transitions dispatched → running
    const ackRes = await handleWorkerRequest(
      new Request(`https://api.test/v1/runs/${RUN_ID}/ack`, {
        method: "POST",
        headers: { ...auth, ...json, ...team },
        body: JSON.stringify({ accept: true, workerId: WORKER_ID }),
      }),
      env,
    );
    expect(ackRes.status, "ack").toBe(200);
    const { run: runAfterAck } = await ackRes.json() as { run: Record<string, unknown> };
    expect(runAfterAck.status, "run status after ack").toBe("running");

    // Step 7: Worker streams NDJSON events
    const ndjson = [
      JSON.stringify({ ts: Date.now(), protocol_version: "1.0.0", kind: "log", payload: { level: "info", message: "starting" } }),
      JSON.stringify({ ts: Date.now(), protocol_version: "1.0.0", kind: "log", payload: { level: "info", message: "done" } }),
    ].join("\n");
    const eventsRes = await handleWorkerRequest(
      new Request(`https://api.test/v1/runs/${RUN_ID}/events`, {
        method: "POST",
        headers: {
          ...auth,
          ...team,
          "content-type": "application/x-ndjson",
          "x-contrabass-worker-id": WORKER_ID,
        },
        body: ndjson,
      }),
      env,
    );
    expect(eventsRes.status, "events").toBe(200);
    const { accepted } = await eventsRes.json() as { accepted: number };
    expect(accepted, "accepted event count").toBe(2);

    // Step 8: Worker reports completion — IssueRun transitions running → succeeded
    const completeRes = await handleWorkerRequest(
      new Request(`https://api.test/v1/runs/${RUN_ID}/complete`, {
        method: "POST",
        headers: {
          ...auth,
          ...json,
          ...team,
          "x-contrabass-worker-id": WORKER_ID,
        },
        body: JSON.stringify({
          status: "succeeded",
          summary: "Fixed SMOKE-1 successfully",
          finalConfigHash: FAKE_CONFIG_HASH,
          artifactKeys: {
            logs: "smoke/logs",
            diff: "smoke/diff",
            summary: "smoke/summary",
          },
          protocol_version: "1.0.0",
        }),
      }),
      env,
    );
    expect(completeRes.status, "complete").toBe(200);
    const { run: runAfterComplete } = await completeRes.json() as { run: Record<string, unknown> };
    expect(runAfterComplete.status, "run status after complete").toBe("succeeded");

    // Step 9: Tracker poller signals completion — full board replacement moves run to done.
    // TeamCoordinator.acceptInternalNotification for run-complete only buffers the notification;
    // the board phase is updated here by the poller doing a full board refresh.
    const boardDoneRes = await coord.fetch(
      new Request("https://team-coordinator.internal/board/refresh", {
        method: "POST",
        headers: { ...json, ...team },
        body: JSON.stringify({
          board: {
            open: [],
            claimed: [],
            running: [],
            done: [{ issueRef: ISSUE_REF, phase: "done", runId: RUN_ID }],
          },
        }),
      }),
    );
    expect(boardDoneRes.status, "board to done").toBe(200);

    // Step 10: Verify the final board state through the API Worker
    const boardRes = await handleWorkerRequest(
      new Request(`https://api.test/v1/teams/${TEAM_ID}/board`, {
        headers: { ...auth },
      }),
      env,
    );
    expect(boardRes.status, "board read").toBe(200);
    const { board: finalBoard } = await boardRes.json() as { board: Record<string, unknown[]> };
    expect(finalBoard.open, "final open").toHaveLength(0);
    expect(finalBoard.claimed, "final claimed").toHaveLength(0);
    expect(finalBoard.running, "final running").toHaveLength(0);
    expect(finalBoard.done, "final done").toHaveLength(1);
    expect((finalBoard.done[0] as Record<string, unknown>).issueRef, "done issueRef").toBe(ISSUE_REF);
  });
});
