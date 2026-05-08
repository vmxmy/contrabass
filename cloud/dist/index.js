var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/queues/events-archive.ts
var ARCHIVE_CONTENT_TYPE = "application/x-ndjson; charset=utf-8";
async function archiveEventsBatch(messages, bucket) {
  if (messages.length === 0) {
    return void 0;
  }
  const key = createArchiveObjectKey(messages);
  const body = messages.map((message) => JSON.stringify(toArchiveRecord(message))).join("\n") + "\n";
  await bucket.put(key, body, {
    httpMetadata: {
      contentType: ARCHIVE_CONTENT_TYPE
    },
    customMetadata: {
      messageCount: String(messages.length),
      firstMessageId: messages[0]?.id ?? "",
      lastMessageId: messages[messages.length - 1]?.id ?? ""
    }
  });
  return key;
}
__name(archiveEventsBatch, "archiveEventsBatch");
function createArchiveObjectKey(messages) {
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
    `${batchId}.ndjson`
  ].join("/");
}
__name(createArchiveObjectKey, "createArchiveObjectKey");
function toArchiveRecord(message) {
  return {
    ...message.body,
    queueMessageId: message.id,
    archivedAt: queueMessageDate(message).toISOString()
  };
}
__name(toArchiveRecord, "toArchiveRecord");
function queueMessageDate(message) {
  const timestamp = message.timestamp;
  if (timestamp instanceof Date) {
    return timestamp;
  }
  return new Date(timestamp);
}
__name(queueMessageDate, "queueMessageDate");
function stableBatchId(messages) {
  return messages.map((message) => safeKeyPart(message.id)).join("-").slice(0, 256);
}
__name(stableBatchId, "stableBatchId");
function safeKeyPart(value) {
  return value.replace(/[^A-Za-z0-9._-]/gu, "_");
}
__name(safeKeyPart, "safeKeyPart");
function twoDigit(value) {
  return String(value).padStart(2, "0");
}
__name(twoDigit, "twoDigit");

// src/index.ts
function handleRequest() {
  return Response.json(
    {
      service: "contrabass-cloud",
      status: "not_configured"
    },
    { status: 503 }
  );
}
__name(handleRequest, "handleRequest");
var worker = {
  fetch() {
    return handleRequest();
  },
  async queue(batch, env) {
    await archiveEventsBatch(batch.messages, env.EVENTS_ARCHIVE_BUCKET);
  }
};
var index_default = worker;
export {
  index_default as default,
  handleRequest
};
//# sourceMappingURL=index.js.map
