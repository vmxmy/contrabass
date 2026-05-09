var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/do/issue-run.ts
var IssueRunTransitionError = class extends Error {
  constructor(from, to) {
    super(`invalid IssueRun transition: ${from} -> ${to}`);
    this.from = from;
    this.to = to;
    this.name = "IssueRunTransitionError";
  }
  static {
    __name(this, "IssueRunTransitionError");
  }
  code = "invalid_state_transition";
};
var RECORD_KEY = "issue-run:record";
var EVENT_LOG_KEY = "issue-run:events";
var DEFAULT_LEASE_SEC = 60;
var MAX_EVENTS_PER_REQUEST = 200;
var MAX_EVENTS_BYTES = 512 * 1024;
var TERMINAL_RETENTION_MS = 24 * 60 * 60 * 1e3;
var TERMINAL_STATES = /* @__PURE__ */ new Set(["succeeded", "failed", "cancelled"]);
var ALLOWED_TRANSITIONS = {
  queued: ["dispatched"],
  dispatched: ["running", "queued"],
  running: ["succeeded", "failed", "cancelled", "queued"],
  succeeded: [],
  failed: [],
  cancelled: []
};
function isTerminalIssueRunStatus(status) {
  return TERMINAL_STATES.has(status);
}
__name(isTerminalIssueRunStatus, "isTerminalIssueRunStatus");
function canTransitionIssueRunStatus(from, to) {
  return ALLOWED_TRANSITIONS[from].includes(to);
}
__name(canTransitionIssueRunStatus, "canTransitionIssueRunStatus");
function transitionIssueRunStatus(from, to) {
  if (!canTransitionIssueRunStatus(from, to)) {
    throw new IssueRunTransitionError(from, to);
  }
  return {
    previous: from,
    current: to,
    changed: from !== to
  };
}
__name(transitionIssueRunStatus, "transitionIssueRunStatus");
var IssueRun = class {
  constructor(state, env = {}) {
    this.state = state;
    this.env = env;
  }
  static {
    __name(this, "IssueRun");
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/state")) {
      const record = await this.ensureRecord();
      return jsonResponse({ run: record });
    }
    if (request.method === "POST" && url.pathname === "/dispatch") {
      const body = await readObjectBody(request);
      return this.acquireDispatch(body, {
        leaseHolder: getStringField(body, "workerId"),
        leaseSec: getLeaseSecField(body, "leaseSec"),
        workerKind: getWorkerKindField(body),
        configHash: getConfigHashField(body)
      });
    }
    if (request.method === "POST" && url.pathname === "/ack") {
      const body = await readObjectBody(request);
      const accept = getBooleanField(body, "accept");
      if (accept === void 0) {
        return jsonResponse({ error: "invalid_request", message: "accept must be a boolean" }, 400);
      }
      const record = await this.ensureRecord();
      const workerId = getStringField(body, "workerId");
      if (accept && record.leaseHolder !== void 0 && workerId !== void 0 && workerId !== record.leaseHolder) {
        return jsonResponse({ error: "lease_holder_mismatch" }, 409);
      }
      const leaseSec = record.leaseSec ?? DEFAULT_LEASE_SEC;
      return this.transition(record, accept ? "running" : "queued", accept ? {
        leaseExpiresAt: Date.now() + leaseSec * 1e3,
        leaseSec
      } : { clearLease: true });
    }
    if (request.method === "POST" && url.pathname === "/heartbeat") {
      const body = await readObjectBody(request);
      return this.handleHeartbeat(request, body);
    }
    if (request.method === "POST" && url.pathname === "/events") {
      return this.handleEvents(request);
    }
    if (request.method === "POST" && url.pathname === "/complete") {
      const body = await readObjectBody(request);
      if (!isWorkerCompleteRequest(body)) {
        return jsonResponse(
          { error: "invalid_request", message: "complete body must match worker protocol v1" },
          400
        );
      }
      return this.handleComplete(request, body);
    }
    if (request.method === "POST" && url.pathname === "/cancel") {
      const body = await readObjectBody(request);
      return this.handleCancel(body);
    }
    return jsonResponse({ error: "not_found" }, 404);
  }
  async alarm() {
    const record = await this.state.storage.get(RECORD_KEY);
    if (record === void 0) {
      await this.state.storage.deleteAlarm();
      return;
    }
    const now = Date.now();
    if (isTerminalIssueRunStatus(record.status)) {
      if (record.terminalRetentionExpiresAt !== void 0 && record.terminalRetentionExpiresAt > now) {
        await this.state.storage.setAlarm(record.terminalRetentionExpiresAt);
        return;
      }
      await this.pruneTerminalRetention();
      return;
    }
    if (record.status !== "running" || record.leaseExpiresAt === void 0) {
      await this.state.storage.deleteAlarm();
      return;
    }
    if (record.leaseExpiresAt > now) {
      await this.state.storage.setAlarm(record.leaseExpiresAt);
      return;
    }
    await this.sendLeaseRevoked(record, "heartbeat_timeout");
    await this.transitionRecord(record, "queued", now, { clearLease: true });
    await this.state.storage.deleteAlarm();
  }
  async ensureRecord(metadata = {}) {
    const existing = await this.state.storage.get(RECORD_KEY);
    if (existing !== void 0) {
      return existing;
    }
    const now = Date.now();
    const record = {
      runId: getStringField(metadata, "runId"),
      teamId: getStringField(metadata, "teamId"),
      issueRef: getStringField(metadata, "issueRef"),
      status: "queued",
      createdAt: now,
      updatedAt: now
    };
    await this.state.storage.put(RECORD_KEY, record);
    return record;
  }
  async transition(record, next, options = {}) {
    try {
      const now = Date.now();
      const { updated, result } = await this.transitionRecord(record, next, now, options);
      return jsonResponse({ run: updated, transition: result });
    } catch (error) {
      if (error instanceof IssueRunTransitionError) {
        return jsonResponse({ error: error.code, from: error.from, to: error.to }, 409);
      }
      throw error;
    }
  }
  async acquireDispatch(metadata, options = {}) {
    const now = Date.now();
    const acquisition = await this.state.storage.transaction(async (txn) => {
      const record = await this.getDispatchCandidate(txn, metadata, now);
      if (record.status !== "queued" || record.leaseHolder !== void 0) {
        return { acquired: false, record };
      }
      const result = transitionIssueRunStatus(record.status, "dispatched");
      const updated = {
        ...record,
        status: result.current,
        updatedAt: now,
        leaseHolder: options.leaseHolder ?? record.leaseHolder,
        leaseSec: options.leaseSec ?? record.leaseSec,
        workerKind: options.workerKind ?? record.workerKind,
        configHash: options.configHash ?? record.configHash
      };
      await txn.put(RECORD_KEY, updated);
      return { acquired: true, record: updated, result };
    });
    if (!acquisition.acquired) {
      return jsonResponse({ error: "lease_already_held", run: acquisition.record }, 409);
    }
    return jsonResponse({ run: acquisition.record, transition: acquisition.result });
  }
  async getDispatchCandidate(txn, metadata, now) {
    const existing = await txn.get(RECORD_KEY);
    if (existing !== void 0) {
      return existing;
    }
    return {
      runId: getStringField(metadata, "runId"),
      teamId: getStringField(metadata, "teamId"),
      issueRef: getStringField(metadata, "issueRef"),
      status: "queued",
      createdAt: now,
      updatedAt: now
    };
  }
  async transitionRecord(record, next, now, options = {}) {
    const result = transitionIssueRunStatus(record.status, next);
    const updated = {
      ...record,
      status: result.current,
      updatedAt: now,
      startedAt: result.current === "running" && record.startedAt === void 0 ? now : record.startedAt,
      endedAt: isTerminalIssueRunStatus(result.current) && record.endedAt === void 0 ? now : record.endedAt,
      terminalRetentionExpiresAt: isTerminalIssueRunStatus(result.current) ? record.terminalRetentionExpiresAt ?? now + TERMINAL_RETENTION_MS : void 0,
      leaseHolder: options.leaseHolder ?? record.leaseHolder,
      leaseExpiresAt: options.leaseExpiresAt ?? record.leaseExpiresAt,
      leaseSec: options.leaseSec ?? record.leaseSec,
      workerKind: options.workerKind ?? record.workerKind,
      configHash: options.configHash ?? record.configHash
    };
    if (options.clearLease) {
      delete updated.leaseHolder;
      delete updated.leaseExpiresAt;
      delete updated.leaseSec;
    }
    if (result.changed || leaseFieldsChanged(record, updated)) {
      await this.state.storage.put(RECORD_KEY, updated);
    }
    if (updated.status === "running" && updated.leaseExpiresAt !== void 0) {
      await this.state.storage.setAlarm(updated.leaseExpiresAt);
    } else if (isTerminalIssueRunStatus(updated.status) && updated.terminalRetentionExpiresAt !== void 0) {
      await this.state.storage.delete(EVENT_LOG_KEY);
      await this.state.storage.setAlarm(updated.terminalRetentionExpiresAt);
    } else if (record.leaseExpiresAt !== void 0 || options.clearLease) {
      await this.state.storage.deleteAlarm();
    }
    return { updated, result };
  }
  async handleHeartbeat(request, body) {
    const record = await this.state.storage.get(RECORD_KEY);
    if (record === void 0) {
      return heartbeatError("run_unknown", "run was not found", 404);
    }
    if (isTerminalIssueRunStatus(record.status)) {
      return heartbeatError("run_terminal", "run is already terminal", 409);
    }
    if (record.status !== "running" || record.leaseExpiresAt === void 0 || record.leaseSec === void 0) {
      return heartbeatError("lease_revoked", "run lease has been revoked", 409);
    }
    const workerId = getRequestWorkerId(request, body);
    if (record.leaseHolder !== void 0 && workerId !== record.leaseHolder) {
      return heartbeatError(
        "lease_holder_mismatch",
        "heartbeat came from a worker that does not hold the lease",
        409
      );
    }
    const now = Date.now();
    if (record.leaseExpiresAt <= now) {
      return heartbeatError("lease_revoked", "run lease has been revoked", 409);
    }
    const leaseExpiresAt = now + record.leaseSec * 1e3;
    const updated = {
      ...record,
      updatedAt: now,
      leaseExpiresAt
    };
    await this.state.storage.put(RECORD_KEY, updated);
    await this.state.storage.setAlarm(leaseExpiresAt);
    return jsonResponse({ run: updated, leaseExpiresAt });
  }
  async handleEvents(request) {
    const record = await this.state.storage.get(RECORD_KEY);
    if (record === void 0) {
      return eventError("run_unknown", "run was not found", 404);
    }
    if (isTerminalIssueRunStatus(record.status)) {
      const retentionExpiresAt = record.terminalRetentionExpiresAt ?? (record.endedAt === void 0 ? void 0 : record.endedAt + TERMINAL_RETENTION_MS);
      if (retentionExpiresAt !== void 0 && Date.now() >= retentionExpiresAt) {
        await this.pruneTerminalRetention();
        return eventError("run_unknown", "run was not found", 404);
      }
      await this.recordLateEvent(record);
      return eventError("run_terminal", "run is already terminal", 409);
    }
    if (record.status !== "running") {
      return eventError("run_not_running", "events are only accepted for running runs", 409);
    }
    if (record.teamId === void 0 || record.runId === void 0) {
      return eventError("run_metadata_missing", "running run is missing teamId or runId", 409);
    }
    const { teamId, runId } = record;
    const workerId = getRequestWorkerId(request, {});
    if (record.leaseHolder !== void 0 && workerId !== void 0 && workerId !== record.leaseHolder) {
      return eventError(
        "lease_holder_mismatch",
        "event batch came from a worker that does not hold the lease",
        409
      );
    }
    const body = await request.text();
    if (new TextEncoder().encode(body).byteLength > MAX_EVENTS_BYTES) {
      return eventsTooLargeResponse();
    }
    const parsed = parseEventLines(body);
    if ("error" in parsed) {
      return eventError(parsed.error, parsed.message, parsed.status);
    }
    if (parsed.events.length > MAX_EVENTS_PER_REQUEST) {
      return eventsTooLargeResponse();
    }
    const receivedAt = Date.now();
    const messages = parsed.events.map((event) => ({
      protocol_version: "1.0.0",
      teamId,
      runId,
      issueRef: record.issueRef,
      workerId: workerId ?? record.leaseHolder,
      receivedAt,
      event
    }));
    const existing = await this.state.storage.get(EVENT_LOG_KEY);
    await this.state.storage.put(EVENT_LOG_KEY, [...existing ?? [], ...messages]);
    await this.forwardEventsToTeamCoordinator(record, messages);
    await this.enqueueEvents(messages);
    return jsonResponse({ protocol_version: "1.0.0", accepted: messages.length });
  }
  async handleComplete(request, body) {
    const record = await this.state.storage.get(RECORD_KEY);
    if (record === void 0) {
      return completionError("run_unknown", "run was not found", 404);
    }
    if (isTerminalIssueRunStatus(record.status)) {
      return completionError("run_terminal", "run is already terminal", 409);
    }
    if (record.status !== "running" || record.leaseExpiresAt === void 0) {
      return completionError("lease_revoked", "run lease has been revoked", 409);
    }
    const workerId = getRequestWorkerId(request, {});
    if (record.leaseHolder !== void 0 && workerId !== record.leaseHolder) {
      return completionError(
        "lease_holder_mismatch",
        "completion came from a worker that does not hold the lease",
        409
      );
    }
    const now = Date.now();
    if (record.leaseExpiresAt <= now) {
      return completionError("lease_revoked", "run lease has been revoked", 409);
    }
    const completion = buildCompletionRecord(record, body, now);
    if (completion === void 0) {
      return completionError("run_metadata_missing", "run is missing completion metadata", 409);
    }
    await this.persistCompletion(completion);
    await this.broadcastRunComplete(completion);
    const terminal = await this.transitionRecord(record, body.status, now, { clearLease: true });
    return jsonResponse({ run: terminal.updated, transition: terminal.result });
  }
  async handleCancel(body) {
    const record = await this.state.storage.get(RECORD_KEY);
    if (record === void 0) {
      return cancelError("run_unknown", "run was not found", 404);
    }
    if (isTerminalIssueRunStatus(record.status)) {
      return cancelError("run_terminal", "run is already terminal", 409);
    }
    if (record.status !== "running") {
      return cancelError("run_not_running", "only running runs can be cancelled", 409);
    }
    const cancelBody = buildCancelCompletionBody(body, record);
    if (cancelBody === void 0) {
      return cancelError("invalid_request", "cancel requires finalConfigHash or dispatch configHash", 400);
    }
    const now = Date.now();
    const completion = buildCompletionRecord(record, cancelBody, now);
    if (completion === void 0) {
      return cancelError("run_metadata_missing", "run is missing completion metadata", 409);
    }
    await this.sendLeaseRevoked(record, "cancelled");
    await this.persistCompletion(completion);
    await this.broadcastRunComplete(completion);
    const terminal = await this.transitionRecord(record, "cancelled", now, { clearLease: true });
    return jsonResponse({ run: terminal.updated, transition: terminal.result });
  }
  async persistCompletion(completion) {
    if (this.env.CONTROL_PLANE_DB === void 0) {
      return;
    }
    await this.env.CONTROL_PLANE_DB.prepare(`
      INSERT INTO runs (
        run_id,
        team_id,
        issue_ref,
        worker_id,
        kind,
        started_at,
        ended_at,
        status,
        summary,
        artifact_keys,
        final_config_hash,
        error_class
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        team_id = excluded.team_id,
        issue_ref = excluded.issue_ref,
        worker_id = excluded.worker_id,
        kind = excluded.kind,
        started_at = excluded.started_at,
        ended_at = excluded.ended_at,
        status = excluded.status,
        summary = excluded.summary,
        artifact_keys = excluded.artifact_keys,
        final_config_hash = excluded.final_config_hash,
        error_class = excluded.error_class
    `).bind(
      completion.runId,
      completion.teamId,
      completion.issueRef,
      completion.workerId,
      completion.kind,
      toIsoString(completion.startedAt),
      toIsoString(completion.endedAt),
      completion.status,
      completion.summary,
      JSON.stringify(completion.artifactKeys),
      completion.finalConfigHash,
      completion.errorClass ?? null
    ).run();
  }
  async broadcastRunComplete(completion) {
    if (this.env.TEAM_COORDINATOR === void 0) {
      return;
    }
    const id = this.env.TEAM_COORDINATOR.idFromName(completion.teamId);
    const teamCoordinator = this.env.TEAM_COORDINATOR.get(id);
    const response = await teamCoordinator.fetch("https://team-coordinator.internal/run-complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "run-complete",
        protocol_version: "1.0.0",
        ...completion
      })
    });
    if (!response.ok) {
      throw new Error(`run-complete broadcast failed with status ${response.status}`);
    }
  }
  async sendLeaseRevoked(record, reason) {
    if (this.env.TEAM_COORDINATOR === void 0 || record.teamId === void 0 || record.runId === void 0 || record.leaseHolder === void 0) {
      return;
    }
    const id = this.env.TEAM_COORDINATOR.idFromName(record.teamId);
    const teamCoordinator = this.env.TEAM_COORDINATOR.get(id);
    const response = await teamCoordinator.fetch("https://team-coordinator.internal/lease-revoked", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "lease-revoked",
        protocol_version: "1.0.0",
        runId: record.runId,
        workerId: record.leaseHolder,
        reason
      })
    });
    if (!response.ok) {
      throw new Error(`lease-revoked delivery failed with status ${response.status}`);
    }
  }
  async forwardEventsToTeamCoordinator(record, messages) {
    if (this.env.TEAM_COORDINATOR === void 0 || record.teamId === void 0) {
      return;
    }
    const id = this.env.TEAM_COORDINATOR.idFromName(record.teamId);
    const teamCoordinator = this.env.TEAM_COORDINATOR.get(id);
    for (const message of messages) {
      await teamCoordinator.fetch("https://team-coordinator.internal/run-event", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(message)
      });
    }
  }
  async enqueueEvents(messages) {
    if (this.env.EVENTS_ARCHIVE_QUEUE === void 0) {
      return;
    }
    for (const message of messages) {
      await this.env.EVENTS_ARCHIVE_QUEUE.send(message);
    }
  }
  async recordLateEvent(record) {
    await this.state.storage.put(RECORD_KEY, {
      ...record,
      lateEvents: (record.lateEvents ?? 0) + 1,
      updatedAt: Date.now()
    });
  }
  async pruneTerminalRetention() {
    await this.state.storage.delete(EVENT_LOG_KEY);
    await this.state.storage.delete(RECORD_KEY);
    await this.state.storage.deleteAlarm();
  }
};
async function readObjectBody(request) {
  if (request.body === null) {
    return {};
  }
  const body = await request.json();
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new Response(JSON.stringify({ error: "invalid_json" }), { status: 400 });
  }
  return body;
}
__name(readObjectBody, "readObjectBody");
function getStringField(record, key) {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : void 0;
}
__name(getStringField, "getStringField");
function getBooleanField(record, key) {
  const value = record[key];
  return typeof value === "boolean" ? value : void 0;
}
__name(getBooleanField, "getBooleanField");
function getLeaseSecField(record, key) {
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return void 0;
  }
  return value;
}
__name(getLeaseSecField, "getLeaseSecField");
function getWorkerKindField(record) {
  const value = getStringField(record, "workerKind") ?? getStringField(record, "kind");
  return value === "local" || value === "container" ? value : void 0;
}
__name(getWorkerKindField, "getWorkerKindField");
function getConfigHashField(record) {
  const value = getStringField(record, "configHash") ?? getStringField(record, "finalConfigHash");
  return isConfigHash(value) ? value : void 0;
}
__name(getConfigHashField, "getConfigHashField");
function getRequestWorkerId(request, body) {
  return request.headers.get("x-contrabass-worker-id") ?? getStringField(body, "workerId");
}
__name(getRequestWorkerId, "getRequestWorkerId");
function isWorkerCompleteRequest(value) {
  if (!isRecord(value)) {
    return false;
  }
  if (value.protocol_version !== "1.0.0") {
    return false;
  }
  const status = value.status;
  if (status !== "succeeded" && status !== "failed" && status !== "cancelled") {
    return false;
  }
  if (typeof value.summary !== "string" || !isConfigHash(value.finalConfigHash) || !isArtifactKeys(value.artifactKeys)) {
    return false;
  }
  return status !== "failed" || typeof value.errorClass === "string";
}
__name(isWorkerCompleteRequest, "isWorkerCompleteRequest");
function buildCancelCompletionBody(body, record) {
  const finalConfigHash = getConfigHashField(body) ?? record.configHash;
  if (!isConfigHash(finalConfigHash)) {
    return void 0;
  }
  const artifactKeys = body.artifactKeys === void 0 ? {} : body.artifactKeys;
  if (!isArtifactKeys(artifactKeys)) {
    return void 0;
  }
  return {
    protocol_version: "1.0.0",
    status: "cancelled",
    summary: getStringField(body, "summary") ?? "cancelled by operator",
    artifactKeys,
    finalConfigHash
  };
}
__name(buildCancelCompletionBody, "buildCancelCompletionBody");
function isConfigHash(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}
__name(isConfigHash, "isConfigHash");
function isArtifactKeys(value) {
  if (!isRecord(value)) {
    return false;
  }
  return isOptionalString(value.logs) && isOptionalString(value.diff) && isOptionalString(value.summary) && isOptionalStringArray(value.screenshots);
}
__name(isArtifactKeys, "isArtifactKeys");
function isOptionalString(value) {
  return value === void 0 || typeof value === "string";
}
__name(isOptionalString, "isOptionalString");
function isOptionalStringArray(value) {
  return value === void 0 || Array.isArray(value) && value.every((item) => typeof item === "string");
}
__name(isOptionalStringArray, "isOptionalStringArray");
function buildCompletionRecord(active, body, endedAt) {
  const workerId = active.leaseHolder;
  const kind = active.workerKind;
  if (active.runId === void 0 || active.teamId === void 0 || active.issueRef === void 0 || workerId === void 0 || kind === void 0) {
    return void 0;
  }
  return {
    runId: active.runId,
    teamId: active.teamId,
    issueRef: active.issueRef,
    workerId,
    kind,
    startedAt: active.startedAt ?? active.createdAt,
    endedAt,
    status: body.status,
    summary: body.summary,
    artifactKeys: artifactKeysToRecord(body.artifactKeys),
    finalConfigHash: body.finalConfigHash,
    errorClass: body.status === "failed" ? body.errorClass : void 0
  };
}
__name(buildCompletionRecord, "buildCompletionRecord");
function artifactKeysToRecord(value) {
  const record = {};
  if (value.logs !== void 0) {
    record.logs = value.logs;
  }
  if (value.diff !== void 0) {
    record.diff = value.diff;
  }
  if (value.summary !== void 0) {
    record.summary = value.summary;
  }
  if (value.screenshots !== void 0) {
    record.screenshots = value.screenshots;
  }
  return record;
}
__name(artifactKeysToRecord, "artifactKeysToRecord");
function toIsoString(epochMillis) {
  return new Date(epochMillis).toISOString();
}
__name(toIsoString, "toIsoString");
function parseEventLines(body) {
  const lines = body.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  const events = [];
  for (const line of lines) {
    let decoded;
    try {
      decoded = JSON.parse(line);
    } catch {
      return { error: "invalid_ndjson", message: "event batch contains invalid JSON", status: 400 };
    }
    if (!isWorkerEventLine(decoded)) {
      return { error: "invalid_event", message: "event line does not match worker protocol v1", status: 400 };
    }
    events.push(decoded);
  }
  return { events };
}
__name(parseEventLines, "parseEventLines");
function isWorkerEventLine(value) {
  if (!isRecord(value)) {
    return false;
  }
  return value.protocol_version === "1.0.0" && typeof value.ts === "number" && Number.isFinite(value.ts) && isWorkerEventKind(value.kind) && isRecord(value.payload) && (value.seq === void 0 || typeof value.seq === "number" && Number.isFinite(value.seq));
}
__name(isWorkerEventLine, "isWorkerEventLine");
function isWorkerEventKind(value) {
  return value === "start" || value === "log" || value === "tool_call" || value === "diff" || value === "error" || value === "phase";
}
__name(isWorkerEventKind, "isWorkerEventKind");
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
__name(isRecord, "isRecord");
function leaseFieldsChanged(previous, next) {
  return previous.leaseHolder !== next.leaseHolder || previous.leaseExpiresAt !== next.leaseExpiresAt || previous.leaseSec !== next.leaseSec;
}
__name(leaseFieldsChanged, "leaseFieldsChanged");
function jsonResponse(body, status = 200) {
  return Response.json(body, { status });
}
__name(jsonResponse, "jsonResponse");
function heartbeatError(error, message, status) {
  return jsonResponse({ protocol_version: "1.0.0", error, message }, status);
}
__name(heartbeatError, "heartbeatError");
function completionError(error, message, status) {
  return jsonResponse({ protocol_version: "1.0.0", error, message }, status);
}
__name(completionError, "completionError");
function cancelError(error, message, status) {
  return jsonResponse({ protocol_version: "1.0.0", error, message }, status);
}
__name(cancelError, "cancelError");
function eventError(error, message, status) {
  return jsonResponse({ protocol_version: "1.0.0", error, message }, status);
}
__name(eventError, "eventError");
function eventsTooLargeResponse() {
  return jsonResponse({
    error: "events_too_large",
    max_events: MAX_EVENTS_PER_REQUEST,
    max_bytes: MAX_EVENTS_BYTES
  }, 413);
}
__name(eventsTooLargeResponse, "eventsTooLargeResponse");

// src/do/team-coordinator.ts
var TEAM_RECORD_KEY = "team-coordinator:record";
var BOARD_KEY = "team-coordinator:board";
var NOTIFICATIONS_KEY = "team-coordinator:notifications";
var INTERNAL_NOTIFICATION_PATHS = /* @__PURE__ */ new Set(["/run-event", "/run-complete", "/lease-revoked"]);
var BOARD_PHASES = ["open", "claimed", "running", "done"];
var PROTOCOL_VERSION = "1.0.0";
var TeamCoordinator = class {
  constructor(state) {
    this.state = state;
  }
  static {
    __name(this, "TeamCoordinator");
  }
  subscribers = /* @__PURE__ */ new Set();
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/state")) {
      const record = await this.ensureRecord(request);
      return jsonResponse2({ team: record });
    }
    if (request.method === "GET" && url.pathname === "/board") {
      return jsonResponse2({ board: await this.ensureBoard() });
    }
    if (request.method === "POST" && url.pathname === "/board/refresh") {
      return this.refreshBoard(request);
    }
    if (request.method === "GET" && url.pathname === "/subscribe") {
      return this.subscribe(request);
    }
    if (request.method === "POST" && INTERNAL_NOTIFICATION_PATHS.has(url.pathname)) {
      return this.acceptInternalNotification(request, url.pathname);
    }
    return jsonResponse2({ error: "not_found" }, 404);
  }
  async ensureRecord(request) {
    const existing = await this.state.storage.get(TEAM_RECORD_KEY);
    if (existing !== void 0) {
      return existing;
    }
    const now = Date.now();
    const teamId = getTeamId(request);
    const record = {
      ...teamId === void 0 ? {} : { teamId },
      createdAt: now,
      updatedAt: now,
      paused: false
    };
    await this.state.storage.put(TEAM_RECORD_KEY, record);
    return record;
  }
  async ensureBoard() {
    const existing = await this.state.storage.get(BOARD_KEY);
    if (existing !== void 0) {
      return normalizeBoard(existing);
    }
    const board = emptyBoard();
    await this.state.storage.put(BOARD_KEY, board);
    return board;
  }
  async refreshBoard(request) {
    const body = await readObjectBody2(request);
    if (body === void 0) {
      return jsonResponse2({ error: "invalid_request", message: "body must be a JSON object" }, 400);
    }
    const now = Date.now();
    const refreshedBoard = boardFromRefreshBody(body, now);
    if (refreshedBoard === void 0) {
      return jsonResponse2({ error: "invalid_request", message: "body must include a valid board or entries" }, 400);
    }
    const board = isFullBoardRefreshBody(body) ? refreshedBoard : mergeBoard(await this.ensureBoard(), refreshedBoard);
    await this.state.storage.put(BOARD_KEY, board);
    await this.touchRecord(request);
    this.broadcast(boardUpdateFrame(board));
    return jsonResponse2({ board });
  }
  async subscribe(request) {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return jsonResponse2({ error: "websocket_required" }, 426);
    }
    const pair = createWebSocketPair();
    if (pair === void 0) {
      return jsonResponse2({ error: "websocket_unavailable" }, 501);
    }
    const [client, server] = pair;
    server.accept();
    this.subscribers.add(server);
    const removeSubscriber = /* @__PURE__ */ __name(() => {
      this.subscribers.delete(server);
    }, "removeSubscriber");
    server.addEventListener("close", removeSubscriber);
    server.addEventListener("error", removeSubscriber);
    server.send(JSON.stringify(boardUpdateFrame(await this.ensureBoard())));
    const notifications = await this.state.storage.get(NOTIFICATIONS_KEY);
    for (const notification of notifications ?? []) {
      server.send(JSON.stringify(notificationFrame(notification)));
    }
    return webSocketResponse(client);
  }
  async acceptInternalNotification(request, pathname) {
    const record = await this.ensureRecord(request);
    const body = await readObjectBody2(request);
    if (body === void 0) {
      return jsonResponse2({ error: "invalid_request", message: "body must be a JSON object" }, 400);
    }
    const now = Date.now();
    const notification = {
      type: notificationTypeForPath(pathname),
      receivedAt: now,
      payload: body
    };
    const notifications = await this.state.storage.get(NOTIFICATIONS_KEY);
    await this.state.storage.put(NOTIFICATIONS_KEY, [...notifications ?? [], notification]);
    await this.state.storage.put(TEAM_RECORD_KEY, {
      ...record,
      updatedAt: now
    });
    this.broadcast(notificationFrame(notification));
    return jsonResponse2({ accepted: true, type: notification.type });
  }
  async touchRecord(request) {
    const record = await this.ensureRecord(request);
    await this.state.storage.put(TEAM_RECORD_KEY, {
      ...record,
      updatedAt: Date.now()
    });
  }
  broadcast(frame) {
    const message = JSON.stringify(frame);
    for (const subscriber of this.subscribers) {
      try {
        subscriber.send(message);
      } catch {
        this.subscribers.delete(subscriber);
      }
    }
  }
};
function notificationTypeForPath(pathname) {
  if (pathname === "/run-complete") {
    return "run-complete";
  }
  if (pathname === "/lease-revoked") {
    return "lease-revoked";
  }
  return "run-event";
}
__name(notificationTypeForPath, "notificationTypeForPath");
function createWebSocketPair() {
  const Pair = globalThis.WebSocketPair;
  if (Pair === void 0) {
    return void 0;
  }
  const pair = new Pair();
  return [pair[0], pair[1]];
}
__name(createWebSocketPair, "createWebSocketPair");
function emptyBoard() {
  return {
    open: [],
    claimed: [],
    running: [],
    done: []
  };
}
__name(emptyBoard, "emptyBoard");
function normalizeBoard(raw) {
  return {
    open: normalizeBoardEntries(raw.open, "open"),
    claimed: normalizeBoardEntries(raw.claimed, "claimed"),
    running: normalizeBoardEntries(raw.running, "running"),
    done: normalizeBoardEntries(raw.done, "done")
  };
}
__name(normalizeBoard, "normalizeBoard");
function normalizeBoardEntries(entries, phase) {
  return (entries ?? []).flatMap((entry) => {
    const normalized = normalizeBoardEntry(entry, phase, Date.now());
    return normalized === void 0 ? [] : [normalized];
  });
}
__name(normalizeBoardEntries, "normalizeBoardEntries");
function isFullBoardRefreshBody(body) {
  const maybeBoard = getObjectField(body, "board") ?? body;
  return hasBoardLists(maybeBoard);
}
__name(isFullBoardRefreshBody, "isFullBoardRefreshBody");
function mergeBoard(existing, updates) {
  const updatedRefs = new Set(BOARD_PHASES.flatMap((phase) => updates[phase].map((entry) => entry.issueRef)));
  const merged = emptyBoard();
  for (const phase of BOARD_PHASES) {
    merged[phase] = existing[phase].filter((entry) => !updatedRefs.has(entry.issueRef));
  }
  for (const phase of BOARD_PHASES) {
    merged[phase].push(...updates[phase]);
  }
  return merged;
}
__name(mergeBoard, "mergeBoard");
function boardFromRefreshBody(body, now) {
  const maybeBoard = getObjectField(body, "board") ?? body;
  if (hasBoardLists(maybeBoard)) {
    const board = emptyBoard();
    for (const phase of BOARD_PHASES) {
      const entries2 = maybeBoard[phase];
      if (!Array.isArray(entries2)) {
        return void 0;
      }
      board[phase] = entries2.flatMap((entry) => {
        const normalized = normalizeBoardEntry(entry, phase, now);
        return normalized === void 0 ? [] : [normalized];
      });
    }
    return board;
  }
  const entries = Array.isArray(body.entries) ? body.entries : Array.isArray(body.issues) ? body.issues : void 0;
  if (entries === void 0) {
    const single = normalizeBoardEntry(body, phaseFromUnknown(body.phase) ?? "open", now);
    return single === void 0 ? void 0 : boardWithEntries([single]);
  }
  const normalizedEntries = entries.flatMap((entry) => {
    const normalized = normalizeBoardEntry(entry, void 0, now);
    return normalized === void 0 ? [] : [normalized];
  });
  return boardWithEntries(normalizedEntries);
}
__name(boardFromRefreshBody, "boardFromRefreshBody");
function hasBoardLists(value) {
  return BOARD_PHASES.every((phase) => Array.isArray(value[phase]));
}
__name(hasBoardLists, "hasBoardLists");
function boardWithEntries(entries) {
  const board = emptyBoard();
  for (const entry of entries) {
    board[entry.phase].push(entry);
  }
  return board;
}
__name(boardWithEntries, "boardWithEntries");
function normalizeBoardEntry(value, defaultPhase, now) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return void 0;
  }
  const entry = value;
  const issueRef = getStringField2(entry, "issueRef") ?? getStringField2(entry, "issue_ref") ?? getStringField2(entry, "id");
  if (issueRef === void 0) {
    return void 0;
  }
  const phase = phaseFromUnknown(entry.phase) ?? defaultPhase ?? "open";
  const runId = getStringField2(entry, "runId") ?? getStringField2(entry, "run_id");
  const assignedWorkerId = getStringField2(entry, "assignedWorkerId") ?? getStringField2(entry, "assigned_worker_id") ?? getStringField2(entry, "workerId") ?? getStringField2(entry, "worker_id");
  return {
    issueRef,
    ...runId === void 0 ? {} : { runId },
    ...assignedWorkerId === void 0 ? {} : { assignedWorkerId },
    phase,
    lastUpdated: getNumberField(entry, "lastUpdated") ?? getNumberField(entry, "last_updated") ?? now
  };
}
__name(normalizeBoardEntry, "normalizeBoardEntry");
function phaseFromUnknown(value) {
  if (value === "open" || value === "claimed" || value === "running" || value === "done") {
    return value;
  }
  if (value === "queued" || value === "todo") {
    return "open";
  }
  if (value === "dispatched") {
    return "claimed";
  }
  if (value === "succeeded" || value === "failed" || value === "cancelled") {
    return "done";
  }
  return void 0;
}
__name(phaseFromUnknown, "phaseFromUnknown");
function boardUpdateFrame(board) {
  return {
    type: "board-update",
    protocol_version: PROTOCOL_VERSION,
    board
  };
}
__name(boardUpdateFrame, "boardUpdateFrame");
function notificationFrame(notification) {
  if (notification.payload.type === notification.type) {
    return {
      protocol_version: PROTOCOL_VERSION,
      ...notification.payload,
      type: notification.type,
      receivedAt: notification.receivedAt
    };
  }
  return {
    type: notification.type,
    protocol_version: PROTOCOL_VERSION,
    receivedAt: notification.receivedAt,
    payload: notification.payload
  };
}
__name(notificationFrame, "notificationFrame");
function getTeamId(request) {
  const header = request.headers.get("x-contrabass-team-id");
  if (header !== null && header.trim() !== "") {
    return header;
  }
  const url = new URL(request.url);
  const query = url.searchParams.get("teamId");
  if (query !== null && query.trim() !== "") {
    return query;
  }
  return void 0;
}
__name(getTeamId, "getTeamId");
async function readObjectBody2(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return void 0;
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return void 0;
  }
  return body;
}
__name(readObjectBody2, "readObjectBody");
function getObjectField(body, key) {
  const value = body[key];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return void 0;
  }
  return value;
}
__name(getObjectField, "getObjectField");
function getStringField2(body, key) {
  const value = body[key];
  return typeof value === "string" && value.trim() !== "" ? value : void 0;
}
__name(getStringField2, "getStringField");
function getNumberField(body, key) {
  const value = body[key];
  return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
__name(getNumberField, "getNumberField");
function webSocketResponse(client) {
  try {
    return new Response(null, { status: 101, webSocket: client });
  } catch (error) {
    if (error instanceof RangeError) {
      return new Response(null, { status: 200, webSocket: client });
    }
    throw error;
  }
}
__name(webSocketResponse, "webSocketResponse");
function jsonResponse2(body, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "content-type": "application/json"
    }
  });
}
__name(jsonResponse2, "jsonResponse");

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
  IssueRun,
  TeamCoordinator,
  index_default as default,
  handleRequest
};
//# sourceMappingURL=index.js.map
