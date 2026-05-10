import type { WorkerEventLine } from "../workerproto/v1";

const ARCHIVE_CONTENT_TYPE = "application/x-ndjson; charset=utf-8";

export type EventArchiveMessage = {
  protocol_version: "1.0.0";
  teamId: string;
  runId: string;
  issueRef?: string;
  workerId?: string;
  receivedAt: number;
  event: WorkerEventLine;
};

type QueueArchiveMessage = Pick<Message<EventArchiveMessage>, "body" | "id" | "timestamp">;
type EventsArchiveBucket = {
  put(key: string, value: string, options?: R2PutOptions): Promise<unknown>;
};

export async function archiveEventsBatch(
  messages: readonly QueueArchiveMessage[],
  bucket: EventsArchiveBucket,
): Promise<string | undefined> {
  if (messages.length === 0) {
    return undefined;
  }

  const key = createArchiveObjectKey(messages);
  const body = messages.map((message) => JSON.stringify(toArchiveRecord(message))).join("\n") + "\n";

  await bucket.put(key, body, {
    httpMetadata: {
      contentType: ARCHIVE_CONTENT_TYPE,
    },
    customMetadata: {
      messageCount: String(messages.length),
      firstMessageId: messages[0]?.id ?? "",
      lastMessageId: messages[messages.length - 1]?.id ?? "",
    },
  });

  return key;
}

export function createArchiveObjectKey(messages: readonly QueueArchiveMessage[]): string {
  if (messages.length === 0) {
    throw new Error("cannot create archive key for an empty queue batch");
  }

  const firstTimestamp = queueMessageDate(messages[0]);
  const batchId = stableBatchId(messages);

  return [
    "events",
    String(firstTimestamp.getUTCFullYear()),
    twoDigit(firstTimestamp.getUTCMonth() + 1),
    twoDigit(firstTimestamp.getUTCDate()),
    twoDigit(firstTimestamp.getUTCHours()),
    `${batchId}.ndjson`,
  ].join("/");
}

function toArchiveRecord(message: QueueArchiveMessage): EventArchiveMessage & {
  queueMessageId: string;
  archivedAt: string;
} {
  return {
    ...message.body,
    queueMessageId: message.id,
    archivedAt: queueMessageDate(message).toISOString(),
  };
}

function queueMessageDate(message: QueueArchiveMessage): Date {
  const timestamp = message.timestamp;
  if (timestamp instanceof Date) {
    return timestamp;
  }
  return new Date(timestamp);
}

function stableBatchId(messages: readonly QueueArchiveMessage[]): string {
  return messages.map((message) => safeKeyPart(message.id)).join("-").slice(0, 256);
}

function safeKeyPart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/gu, "_");
}

function twoDigit(value: number): string {
  return String(value).padStart(2, "0");
}
