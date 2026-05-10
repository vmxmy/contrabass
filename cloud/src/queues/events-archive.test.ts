import { describe, expect, it } from "vitest";

import { archiveEventsBatch, createArchiveObjectKey, type EventArchiveMessage } from "./events-archive";

const eventMessage: EventArchiveMessage = {
  protocol_version: "1.0.0",
  teamId: "synthetic-smoke",
  runId: "run-1",
  issueRef: "SMOKE-1",
  workerId: "worker-1",
  receivedAt: Date.parse("2026-05-08T21:54:00.000Z"),
  event: {
    protocol_version: "1.0.0",
    ts: Date.parse("2026-05-08T21:53:59.000Z"),
    kind: "phase",
    payload: {
      phase: "exec",
      label: "editing files",
    },
  },
};

function queueMessage(id: string, body: EventArchiveMessage, timestamp: Date) {
  return { id, body, timestamp };
}

describe("events archive queue consumer", () => {
  it("writes a queue batch to the events archive bucket as NDJSON", async () => {
    const puts: Array<{ key: string; value: string; options: R2PutOptions }> = [];
    const bucket = {
      async put(key: string, value: string, options?: R2PutOptions) {
        puts.push({ key, value, options: options ?? {} });
        return null;
      },
    };

    const key = await archiveEventsBatch(
      [
        queueMessage("msg-1", eventMessage, new Date("2026-05-08T21:54:01.000Z")),
        queueMessage(
          "msg/2",
          { ...eventMessage, runId: "run-2" },
          new Date("2026-05-08T21:54:02.000Z"),
        ),
      ],
      bucket,
    );

    expect(key).toBe("events/2026/05/08/21/msg-1-msg_2.ndjson");
    expect(puts).toHaveLength(1);
    expect(puts[0]?.key).toBe(key);
    expect(puts[0]?.options.httpMetadata).toEqual({
      contentType: "application/x-ndjson; charset=utf-8",
    });
    expect(puts[0]?.options.customMetadata).toEqual({
      messageCount: "2",
      firstMessageId: "msg-1",
      lastMessageId: "msg/2",
    });

    const records = puts[0]?.value.trim().split("\n").map((line) => JSON.parse(line)) ?? [];
    expect(records).toEqual([
      {
        ...eventMessage,
        queueMessageId: "msg-1",
        archivedAt: "2026-05-08T21:54:01.000Z",
      },
      {
        ...eventMessage,
        runId: "run-2",
        queueMessageId: "msg/2",
        archivedAt: "2026-05-08T21:54:02.000Z",
      },
    ]);
  });

  it("skips empty batches", async () => {
    const bucket = {
      async put() {
        throw new Error("put should not be called for an empty batch");
      },
    };

    await expect(archiveEventsBatch([], bucket)).resolves.toBeUndefined();
  });

  it("creates hour-partitioned archive keys from the first queue message", () => {
    expect(
      createArchiveObjectKey([
        queueMessage("message:1", eventMessage, new Date("2026-05-08T03:04:05.000Z")),
      ]),
    ).toBe("events/2026/05/08/03/message_1.ndjson");
  });
});
