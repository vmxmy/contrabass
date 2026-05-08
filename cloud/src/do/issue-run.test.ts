import { describe, expect, it } from "vitest";

import {
  IssueRun,
  IssueRunTransitionError,
  type IssueRunRecord,
  type IssueRunStatus,
  type IssueRunStorage,
  transitionIssueRunStatus,
} from "./issue-run";

class MemoryIssueRunStorage implements IssueRunStorage {
  private readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }
}

type IssueRunResponseBody = {
  run?: IssueRunRecord;
  transition?: {
    previous: IssueRunStatus;
    current: IssueRunStatus;
    changed: boolean;
  };
  error?: string;
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
});

function createIssueRun(): IssueRun {
  return new IssueRun({ storage: new MemoryIssueRunStorage() }, {});
}

function post(issueRun: IssueRun, path: string, body: Record<string, unknown>): Promise<Response> {
  return issueRun.fetch(
    new Request(`https://issue-run.test${path}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
  );
}

async function readIssueRunResponse(response: Response): Promise<IssueRunResponseBody> {
  return (await response.json()) as IssueRunResponseBody;
}
