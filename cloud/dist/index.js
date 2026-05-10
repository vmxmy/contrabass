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
    if (request.method === "POST" && url.pathname === "/revoke") {
      const body = await readObjectBody(request);
      return this.handleManualRevoke(body);
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
  async handleManualRevoke(body) {
    const record = await this.state.storage.get(RECORD_KEY);
    if (record === void 0) {
      return jsonResponse({ error: "run_unknown", message: "run was not found" }, 404);
    }
    if (isTerminalIssueRunStatus(record.status)) {
      return jsonResponse({ error: "run_terminal", message: "run is already terminal" }, 409);
    }
    if (record.status !== "running" && record.status !== "dispatched") {
      return jsonResponse({ error: "run_not_active", message: "only dispatched or running runs can be revoked" }, 409);
    }
    const reason = getLeaseRevokedReasonField(body) ?? "manual_reassign";
    await this.sendLeaseRevoked(record, reason);
    const revoked = await this.transitionRecord(record, "queued", Date.now(), { clearLease: true });
    return jsonResponse({ run: revoked.updated, transition: revoked.result });
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
function getLeaseRevokedReasonField(record) {
  const value = getStringField(record, "reason");
  if (value === "heartbeat_timeout" || value === "ack_timeout" || value === "manual_reassign" || value === "cancelled" || value === "team_paused" || value === "config_invalidated" || value === "server_shutdown" || value === "worker_evicted_by_admin" || value === "session_expired" || value === "protocol_version_renegotiation") {
    return value;
  }
  return void 0;
}
__name(getLeaseRevokedReasonField, "getLeaseRevokedReasonField");
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
var WORKER_PENDING_DISPATCHES_KEY = "team-coordinator:worker-pending-dispatches";
var WORKER_REGISTRY_KEY = "team-coordinator:worker-registry";
var USAGE_CAPS_KEY = "team-coordinator:usage-caps";
var USAGE_COUNTERS_KEY = "team-coordinator:usage-counters";
var INTERNAL_NOTIFICATION_PATHS = /* @__PURE__ */ new Set(["/run-event", "/run-complete", "/lease-revoked", "/config-changed"]);
var BOARD_PHASES = ["open", "claimed", "running", "done"];
var PROTOCOL_VERSION = "1.0.0";
var EVENT_RING_BUFFER_LIMIT = 100;
var DEFAULT_WORKER_MAX_CONCURRENCY = 1;
var DEFAULT_REGISTRY_HEARTBEAT_INTERVAL_SEC = 30;
var TeamCoordinator = class {
  constructor(state, env = {}) {
    this.state = state;
    this.env = env;
  }
  static {
    __name(this, "TeamCoordinator");
  }
  subscribers = /* @__PURE__ */ new Set();
  workerDispatchSubscribers = /* @__PURE__ */ new Map();
  workerLongPollWaiters = /* @__PURE__ */ new Map();
  workerRegistry;
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/state")) {
      const record = await this.ensureRecord(request);
      return jsonResponse2({ team: record, usageCaps: await this.ensureUsageCaps(request) });
    }
    if (request.method === "GET" && url.pathname === "/board") {
      return jsonResponse2({ board: await this.ensureBoard() });
    }
    if (request.method === "GET" && url.pathname === "/workers") {
      return jsonResponse2({ registry: await this.ensureWorkerRegistry() });
    }
    const workerDispatchMatch = /^\/workers\/([^/]+)\/dispatch$/u.exec(url.pathname);
    if (request.method === "GET" && workerDispatchMatch?.[1] !== void 0) {
      return this.longPollWorkerDispatch(workerDispatchMatch[1], url);
    }
    if (request.method === "POST" && url.pathname === "/workers/register") {
      return this.registerWorker(request);
    }
    if (request.method === "POST" && url.pathname === "/workers/heartbeat") {
      return this.recordWorkerHeartbeat(request);
    }
    if (request.method === "POST" && url.pathname === "/dispatch") {
      return this.dispatchRun(request);
    }
    if (request.method === "POST" && url.pathname === "/board/refresh") {
      return this.refreshBoard(request);
    }
    if (request.method === "POST" && url.pathname === "/board/reassign-run") {
      return this.reassignRun(request);
    }
    if (request.method === "POST" && url.pathname === "/board/cancel-run") {
      return this.cancelRun(request);
    }
    if (request.method === "POST" && (url.pathname === "/board/pause" || url.pathname === "/board/pause-team")) {
      return this.setTeamPaused(request, true);
    }
    if (request.method === "POST" && (url.pathname === "/board/resume" || url.pathname === "/board/resume-team")) {
      return this.setTeamPaused(request, false);
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
  async ensureWorkerRegistry() {
    if (this.workerRegistry !== void 0) {
      const evaluated = evaluateWorkerHealth(this.workerRegistry, Date.now());
      if (evaluated.changed) {
        await this.persistWorkerRegistry(evaluated.registry);
      }
      return evaluated.registry;
    }
    const existing = await this.state.storage.get(WORKER_REGISTRY_KEY);
    const normalized = normalizeWorkerRegistry(existing ?? {}, Date.now());
    this.workerRegistry = normalized;
    await this.state.storage.put(WORKER_REGISTRY_KEY, normalized);
    return normalized;
  }
  async persistWorkerRegistry(registry) {
    this.workerRegistry = registry;
    await this.state.storage.put(WORKER_REGISTRY_KEY, registry);
  }
  async registerWorker(request) {
    const body = await readObjectBody2(request);
    if (body === void 0) {
      return jsonResponse2({ error: "invalid_request", message: "body must be a JSON object" }, 400);
    }
    const now = Date.now();
    const worker2 = workerRecordFromRegistrationBody(body, now);
    if (worker2 === void 0) {
      return jsonResponse2({
        error: "invalid_request",
        message: "workerId, capabilities, maxConcurrency, kind, and version are required"
      }, 400);
    }
    const registry = {
      ...await this.ensureWorkerRegistry()
    };
    const existing = registry[worker2.workerId];
    const usageCaps = await this.ensureUsageCaps(request);
    if (existing === void 0 && exceedsActiveWorkerCap(registry, usageCaps)) {
      return teamWorkerCapExceededResponse(usageCaps.max_active_workers);
    }
    const updatedRegistry = {
      ...registry,
      [worker2.workerId]: worker2
    };
    await this.persistWorkerRegistry(updatedRegistry);
    await this.touchRecord(request);
    this.broadcast(workerStatusFrame(worker2));
    return jsonResponse2({ worker: worker2, registry: updatedRegistry });
  }
  async recordWorkerHeartbeat(request) {
    const body = await readObjectBody2(request);
    if (body === void 0) {
      return jsonResponse2({ error: "invalid_request", message: "body must be a JSON object" }, 400);
    }
    const workerId = getStringField2(body, "workerId") ?? getStringField2(body, "worker_id");
    if (workerId === void 0) {
      return jsonResponse2({ error: "invalid_request", message: "workerId is required" }, 400);
    }
    const registry = await this.ensureWorkerRegistry();
    const existing = registry[workerId];
    if (existing === void 0) {
      return jsonResponse2({ error: "worker_not_registered" }, 404);
    }
    const currentLoad = clampWorkerLoad(
      getNumberField(body, "currentLoad") ?? getNumberField(body, "current_load") ?? existing.currentLoad,
      existing.maxConcurrency
    );
    const worker2 = {
      ...existing,
      currentLoad,
      lastHeartbeatTs: Date.now(),
      status: statusForWorkerLoad(currentLoad)
    };
    const updatedRegistry = {
      ...registry,
      [workerId]: worker2
    };
    await this.persistWorkerRegistry(updatedRegistry);
    await this.touchRecord(request);
    this.broadcast(workerStatusFrame(worker2));
    return jsonResponse2({ worker: worker2, registry: updatedRegistry });
  }
  async dispatchRun(request) {
    const body = await readObjectBody2(request);
    if (body === void 0) {
      return jsonResponse2({ error: "invalid_request", message: "body must be a JSON object" }, 400);
    }
    const runId = getStringField2(body, "runId") ?? getStringField2(body, "run_id");
    const issueRef = getStringField2(body, "issueRef") ?? getStringField2(body, "issue_ref");
    if (runId === void 0 || issueRef === void 0) {
      return jsonResponse2({ error: "invalid_request", message: "runId and issueRef are required" }, 400);
    }
    const requiredCapabilities = getDispatchRequiredCapabilities(body);
    if (requiredCapabilities === void 0) {
      return jsonResponse2({ error: "invalid_request", message: "required capabilities must be strings" }, 400);
    }
    const usageCaps = await this.ensureUsageCaps(request);
    const counters = await this.ensureUsageCounters();
    if (usageCaps.max_runs_per_day !== void 0 && counters.runs >= usageCaps.max_runs_per_day) {
      return usageCapExceededResponse("team_run_cap_exceeded", "max_runs_per_day", usageCaps.max_runs_per_day);
    }
    const acceptedCounters = { ...counters, runs: counters.runs + 1 };
    const record = await this.ensureRecord(request);
    if (record.paused) {
      const board2 = mergeBoard(await this.ensureBoard(), boardWithEntries([
        {
          issueRef,
          runId,
          phase: "open",
          lastUpdated: Date.now()
        }
      ]));
      await this.state.storage.put(BOARD_KEY, board2);
      await this.persistUsageCounters(acceptedCounters);
      await this.touchRecord(request);
      this.broadcast(boardUpdateFrame(board2));
      return jsonResponse2({ dispatched: false, paused: true, board: board2 }, 202);
    }
    const registry = await this.ensureWorkerRegistry();
    const selectedWorker = selectDispatchWorker(registry, requiredCapabilities);
    if (selectedWorker === void 0) {
      await this.persistUsageCounters(acceptedCounters);
      const event = await this.emitNoWorkerAvailable(request, body, requiredCapabilities);
      return jsonResponse2({ dispatched: false, event }, 202);
    }
    const worker2 = incrementWorkerLoad(selectedWorker);
    const updatedRegistry = {
      ...registry,
      [worker2.workerId]: worker2
    };
    await this.persistWorkerRegistry(updatedRegistry);
    await this.persistUsageCounters(acceptedCounters);
    const board = mergeBoard(await this.ensureBoard(), boardWithEntries([
      {
        issueRef,
        runId,
        assignedWorkerId: worker2.workerId,
        phase: "claimed",
        lastUpdated: Date.now()
      }
    ]));
    await this.state.storage.put(BOARD_KEY, board);
    await this.touchRecord(request);
    const dispatch = dispatchFrameFromBody(body, worker2.workerId, runId, issueRef);
    this.broadcast(workerStatusFrame(worker2));
    this.broadcast(boardUpdateFrame(board));
    if (this.hasWorkerDispatchSubscriber(worker2.workerId)) {
      this.sendToWorker(worker2.workerId, dispatch);
    } else {
      await this.deliverLongPollDispatch(worker2.workerId, dispatch);
    }
    return jsonResponse2({ dispatched: true, worker: worker2, dispatch, board });
  }
  async longPollWorkerDispatch(workerId, url) {
    const normalizedWorkerId = decodeURIComponent(workerId).trim();
    if (normalizedWorkerId === "") {
      return jsonResponse2({ error: "invalid_worker_id" }, 400);
    }
    const queued = await this.takePendingDispatch(normalizedWorkerId);
    if (queued !== void 0) {
      return jsonResponse2({ ...queued });
    }
    const waitMs = parseWaitMs(url.searchParams.get("wait"));
    if (waitMs <= 0) {
      return new Response(null, { status: 204 });
    }
    const dispatch = await this.waitForWorkerDispatch(normalizedWorkerId, waitMs);
    return dispatch === void 0 ? new Response(null, { status: 204 }) : jsonResponse2({ ...dispatch });
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
  async reassignRun(request) {
    const body = await readObjectBody2(request);
    if (body === void 0) {
      return jsonResponse2({ error: "invalid_request", message: "body must be a JSON object" }, 400);
    }
    const runId = getStringField2(body, "runId") ?? getStringField2(body, "run_id");
    const targetWorkerId = getStringField2(body, "targetWorkerId") ?? getStringField2(body, "target_worker_id");
    if (runId === void 0 || targetWorkerId === void 0) {
      return jsonResponse2({ error: "invalid_request", message: "runId and targetWorkerId are required" }, 400);
    }
    const board = await this.ensureBoard();
    const existingEntry = findBoardEntryByRunId(board, runId);
    if (existingEntry === void 0) {
      return jsonResponse2({ error: "run_not_found" }, 404);
    }
    const registry = await this.ensureWorkerRegistry();
    const targetWorker = registry[targetWorkerId];
    if (targetWorker === void 0) {
      return jsonResponse2({ error: "target_worker_not_registered" }, 404);
    }
    if (!isDispatchCandidate(targetWorker, [])) {
      return jsonResponse2({ error: "target_worker_unavailable" }, 409);
    }
    const issueRun = await this.issueRunStub(request, body, existingEntry);
    if (issueRun === void 0) {
      return jsonResponse2({ error: "issue_run_binding_unavailable" }, 503);
    }
    const revokeResponse = await issueRun.fetch("https://issue-run.internal/revoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "manual_reassign" })
    });
    if (!revokeResponse.ok) {
      return forwardErrorResponse(revokeResponse);
    }
    const dispatch = dispatchFrameFromBody(body, targetWorkerId, runId, existingEntry.issueRef);
    const dispatchResponse = await issueRun.fetch("https://issue-run.internal/dispatch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(dispatch)
    });
    if (!dispatchResponse.ok) {
      return forwardErrorResponse(dispatchResponse);
    }
    const updatedRegistry = {
      ...registry,
      [targetWorkerId]: incrementWorkerLoad(targetWorker)
    };
    if (existingEntry.assignedWorkerId !== void 0) {
      const previousWorker = decrementWorkerLoad(registry[existingEntry.assignedWorkerId]);
      if (previousWorker !== void 0) {
        updatedRegistry[existingEntry.assignedWorkerId] = previousWorker;
      }
    }
    await this.persistWorkerRegistry(updatedRegistry);
    const updatedBoard = moveBoardEntry(board, runId, {
      assignedWorkerId: targetWorkerId,
      phase: "claimed",
      lastUpdated: Date.now()
    });
    await this.state.storage.put(BOARD_KEY, updatedBoard);
    await this.touchRecord(request);
    if (existingEntry.assignedWorkerId !== void 0 && updatedRegistry[existingEntry.assignedWorkerId] !== void 0) {
      this.broadcast(workerStatusFrame(updatedRegistry[existingEntry.assignedWorkerId]));
    }
    this.broadcast(workerStatusFrame(updatedRegistry[targetWorkerId]));
    this.broadcast(boardUpdateFrame(updatedBoard));
    if (this.hasWorkerDispatchSubscriber(targetWorkerId)) {
      this.sendToWorker(targetWorkerId, dispatch);
    } else {
      await this.deliverLongPollDispatch(targetWorkerId, dispatch);
    }
    return jsonResponse2({ reassigned: true, dispatch, board: updatedBoard, registry: updatedRegistry });
  }
  async cancelRun(request) {
    const body = await readObjectBody2(request);
    if (body === void 0) {
      return jsonResponse2({ error: "invalid_request", message: "body must be a JSON object" }, 400);
    }
    const runId = getStringField2(body, "runId") ?? getStringField2(body, "run_id");
    if (runId === void 0) {
      return jsonResponse2({ error: "invalid_request", message: "runId is required" }, 400);
    }
    const board = await this.ensureBoard();
    const existingEntry = findBoardEntryByRunId(board, runId);
    if (existingEntry === void 0) {
      return jsonResponse2({ error: "run_not_found" }, 404);
    }
    const issueRun = await this.issueRunStub(request, body, existingEntry);
    if (issueRun === void 0) {
      return jsonResponse2({ error: "issue_run_binding_unavailable" }, 503);
    }
    const cancelResponse = await issueRun.fetch("https://issue-run.internal/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!cancelResponse.ok) {
      return forwardErrorResponse(cancelResponse);
    }
    const registry = await this.ensureWorkerRegistry();
    const updatedRegistry = { ...registry };
    if (existingEntry.assignedWorkerId !== void 0) {
      const previousWorker = decrementWorkerLoad(registry[existingEntry.assignedWorkerId]);
      if (previousWorker !== void 0) {
        updatedRegistry[existingEntry.assignedWorkerId] = previousWorker;
      }
      await this.persistWorkerRegistry(updatedRegistry);
      if (updatedRegistry[existingEntry.assignedWorkerId] !== void 0) {
        this.broadcast(workerStatusFrame(updatedRegistry[existingEntry.assignedWorkerId]));
      }
    }
    const updatedBoard = moveBoardEntry(board, runId, {
      phase: "done",
      lastUpdated: Date.now()
    });
    await this.state.storage.put(BOARD_KEY, updatedBoard);
    await this.touchRecord(request);
    this.broadcast(boardUpdateFrame(updatedBoard));
    return jsonResponse2({ cancelled: true, board: updatedBoard, registry: updatedRegistry });
  }
  async setTeamPaused(request, paused) {
    const record = await this.ensureRecord(request);
    const updated = {
      ...record,
      paused,
      updatedAt: Date.now()
    };
    await this.state.storage.put(TEAM_RECORD_KEY, updated);
    return jsonResponse2({ team: updated });
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
    const workerId = getSubscriptionWorkerId(request);
    if (workerId !== void 0) {
      server.accept();
      this.addWorkerDispatchSubscriber(workerId, server);
    } else {
      this.acceptDashboardSubscriber(server);
      server.send(JSON.stringify(boardUpdateFrame(await this.ensureBoard())));
      const notifications = await this.state.storage.get(NOTIFICATIONS_KEY);
      const lastEventId = getLastEventId(request);
      for (const notification of replayNotifications(notifications ?? [], lastEventId)) {
        server.send(JSON.stringify(notificationFrame(notification)));
      }
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
    const usageCaps = pathname === "/config-changed" ? parseUsageCaps(body) ?? await this.ensureUsageCaps(request) : await this.ensureUsageCaps(request);
    const counters = await this.ensureUsageCounters();
    if (pathname === "/run-event" && usageCaps.max_events_per_day !== void 0 && counters.events >= usageCaps.max_events_per_day) {
      return usageCapExceededResponse("team_event_cap_exceeded", "max_events_per_day", usageCaps.max_events_per_day);
    }
    const notifications = await this.state.storage.get(NOTIFICATIONS_KEY);
    const notification = {
      eventId: nextNotificationEventId(notifications ?? []),
      type: notificationTypeForPath(pathname),
      receivedAt: now,
      payload: body
    };
    await this.state.storage.put(NOTIFICATIONS_KEY, appendNotification(notifications ?? [], notification));
    if (notification.type === "run-event") {
      await this.persistUsageCounters({ ...counters, events: counters.events + 1 });
    }
    if (notification.type === "config-changed") {
      const updatedCaps = parseUsageCaps(body);
      if (updatedCaps !== void 0) {
        await this.state.storage.put(USAGE_CAPS_KEY, updatedCaps);
      }
    }
    await this.state.storage.put(TEAM_RECORD_KEY, {
      ...record,
      updatedAt: now
    });
    const frame = notificationFrame(notification);
    if (notification.type === "lease-revoked") {
      const workerId = getStringField2(body, "workerId") ?? getStringField2(body, "worker_id");
      if (workerId !== void 0) {
        this.sendToWorker(workerId, frame);
      }
    }
    this.broadcast(frame);
    return jsonResponse2({ accepted: true, type: notification.type });
  }
  async emitNoWorkerAvailable(request, payload, requiredCapabilities) {
    const record = await this.ensureRecord(request);
    const now = Date.now();
    const notifications = await this.state.storage.get(NOTIFICATIONS_KEY);
    const notification = {
      eventId: nextNotificationEventId(notifications ?? []),
      type: "no-worker-available",
      receivedAt: now,
      payload: {
        ...payload,
        requiredCapabilities
      }
    };
    await this.state.storage.put(NOTIFICATIONS_KEY, appendNotification(notifications ?? [], notification));
    await this.state.storage.put(TEAM_RECORD_KEY, {
      ...record,
      updatedAt: now
    });
    this.broadcast(notificationFrame(notification));
    return notification;
  }
  async touchRecord(request) {
    const record = await this.ensureRecord(request);
    await this.state.storage.put(TEAM_RECORD_KEY, {
      ...record,
      updatedAt: Date.now()
    });
  }
  async ensureUsageCaps(request) {
    const stored = await this.state.storage.get(USAGE_CAPS_KEY);
    if (stored !== void 0) {
      return normalizeUsageCaps(stored) ?? {};
    }
    const headers = usageCapsFromHeaders(request.headers);
    if (headers !== void 0) {
      await this.state.storage.put(USAGE_CAPS_KEY, headers);
      return headers;
    }
    return {};
  }
  async ensureUsageCounters() {
    const day = usageDay(Date.now());
    const stored = await this.state.storage.get(USAGE_COUNTERS_KEY);
    if (stored !== void 0 && stored.day === day) {
      return {
        day,
        runs: Math.max(0, Math.trunc(stored.runs)),
        events: Math.max(0, Math.trunc(stored.events))
      };
    }
    const counters = { day, runs: 0, events: 0 };
    await this.persistUsageCounters(counters);
    return counters;
  }
  async persistUsageCounters(counters) {
    await this.state.storage.put(USAGE_COUNTERS_KEY, counters);
  }
  webSocketMessage(socket, message) {
    if (message === "ping") {
      socket.send(JSON.stringify({ type: "pong", protocol_version: PROTOCOL_VERSION }));
    }
  }
  webSocketClose(socket) {
    this.subscribers.delete(socket);
  }
  webSocketError(socket) {
    this.subscribers.delete(socket);
  }
  acceptDashboardSubscriber(socket) {
    if (this.state.acceptWebSocket !== void 0) {
      this.state.acceptWebSocket(socket, ["dashboard"]);
      return;
    }
    socket.accept();
    this.subscribers.add(socket);
    const removeSubscriber = /* @__PURE__ */ __name(() => {
      this.subscribers.delete(socket);
    }, "removeSubscriber");
    socket.addEventListener("close", removeSubscriber);
    socket.addEventListener("error", removeSubscriber);
  }
  broadcast(frame) {
    const message = JSON.stringify(frame);
    for (const subscriber of this.dashboardSubscribers()) {
      try {
        subscriber.send(message);
      } catch {
        this.subscribers.delete(subscriber);
      }
    }
  }
  dashboardSubscribers() {
    const sockets = new Set(this.subscribers);
    for (const socket of this.state.getWebSockets?.("dashboard") ?? []) {
      sockets.add(socket);
    }
    return [...sockets];
  }
  addWorkerDispatchSubscriber(workerId, socket) {
    const sockets = this.workerDispatchSubscribers.get(workerId) ?? /* @__PURE__ */ new Set();
    sockets.add(socket);
    this.workerDispatchSubscribers.set(workerId, sockets);
    const removeSubscriber = /* @__PURE__ */ __name(() => {
      sockets.delete(socket);
      if (sockets.size === 0) {
        this.workerDispatchSubscribers.delete(workerId);
      }
    }, "removeSubscriber");
    socket.addEventListener("close", removeSubscriber);
    socket.addEventListener("error", removeSubscriber);
  }
  hasWorkerDispatchSubscriber(workerId) {
    return (this.workerDispatchSubscribers.get(workerId)?.size ?? 0) > 0;
  }
  sendToWorker(workerId, frame) {
    const sockets = this.workerDispatchSubscribers.get(workerId);
    if (sockets === void 0) {
      return;
    }
    const message = JSON.stringify(frame);
    for (const socket of sockets) {
      try {
        socket.send(message);
      } catch {
        sockets.delete(socket);
      }
    }
    if (sockets.size === 0) {
      this.workerDispatchSubscribers.delete(workerId);
    }
  }
  async deliverLongPollDispatch(workerId, dispatch) {
    const waiters = this.workerLongPollWaiters.get(workerId);
    const waiter = waiters?.values().next().value;
    if (waiter !== void 0) {
      waiters?.delete(waiter);
      if (waiters?.size === 0) {
        this.workerLongPollWaiters.delete(workerId);
      }
      waiter(dispatch);
      return;
    }
    const pending = await this.state.storage.get(
      WORKER_PENDING_DISPATCHES_KEY
    ) ?? {};
    const workerQueue = pending[workerId] ?? [];
    await this.state.storage.put(WORKER_PENDING_DISPATCHES_KEY, {
      ...pending,
      [workerId]: [...workerQueue, dispatch]
    });
  }
  async takePendingDispatch(workerId) {
    const pending = await this.state.storage.get(
      WORKER_PENDING_DISPATCHES_KEY
    );
    const workerQueue = pending?.[workerId];
    if (pending === void 0 || workerQueue === void 0 || workerQueue.length === 0) {
      return void 0;
    }
    const [dispatch, ...remaining] = workerQueue;
    const updated = { ...pending };
    if (remaining.length === 0) {
      delete updated[workerId];
    } else {
      updated[workerId] = remaining;
    }
    await this.state.storage.put(WORKER_PENDING_DISPATCHES_KEY, updated);
    return dispatch;
  }
  waitForWorkerDispatch(workerId, waitMs) {
    return new Promise((resolve) => {
      const waiters = this.workerLongPollWaiters.get(workerId) ?? /* @__PURE__ */ new Set();
      const timeout = setTimeout(() => {
        waiters.delete(resolveOnce);
        if (waiters.size === 0) {
          this.workerLongPollWaiters.delete(workerId);
        }
        resolve(void 0);
      }, waitMs);
      const resolveOnce = /* @__PURE__ */ __name((dispatch) => {
        clearTimeout(timeout);
        resolve(dispatch);
      }, "resolveOnce");
      waiters.add(resolveOnce);
      this.workerLongPollWaiters.set(workerId, waiters);
    });
  }
  async issueRunStub(request, body, entry) {
    if (this.env.ISSUE_RUN === void 0) {
      return void 0;
    }
    const record = await this.ensureRecord(request);
    const teamId = getStringField2(body, "teamId") ?? getStringField2(body, "team_id") ?? record.teamId ?? getTeamId(request);
    if (teamId === void 0) {
      return void 0;
    }
    const id = this.env.ISSUE_RUN.idFromName(`${teamId}:${entry.issueRef}`);
    return this.env.ISSUE_RUN.get(id);
  }
};
function notificationTypeForPath(pathname) {
  if (pathname === "/run-complete") {
    return "run-complete";
  }
  if (pathname === "/lease-revoked") {
    return "lease-revoked";
  }
  if (pathname === "/config-changed") {
    return "config-changed";
  }
  return "run-event";
}
__name(notificationTypeForPath, "notificationTypeForPath");
function createWebSocketPair() {
  const Pair2 = globalThis.WebSocketPair;
  if (Pair2 === void 0) {
    return void 0;
  }
  const pair = new Pair2();
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
function normalizeBoard(raw2) {
  return {
    open: normalizeBoardEntries(raw2.open, "open"),
    claimed: normalizeBoardEntries(raw2.claimed, "claimed"),
    running: normalizeBoardEntries(raw2.running, "running"),
    done: normalizeBoardEntries(raw2.done, "done")
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
function findBoardEntryByRunId(board, runId) {
  for (const phase of BOARD_PHASES) {
    const entry = board[phase].find((candidate) => candidate.runId === runId);
    if (entry !== void 0) {
      return entry;
    }
  }
  return void 0;
}
__name(findBoardEntryByRunId, "findBoardEntryByRunId");
function moveBoardEntry(board, runId, updates) {
  const existing = findBoardEntryByRunId(board, runId);
  if (existing === void 0) {
    return board;
  }
  const moved = {
    ...existing,
    ...updates
  };
  const next = emptyBoard();
  for (const phase of BOARD_PHASES) {
    next[phase] = board[phase].filter((entry) => entry.runId !== runId);
  }
  next[moved.phase].push(moved);
  return next;
}
__name(moveBoardEntry, "moveBoardEntry");
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
function workerStatusFrame(worker2) {
  return {
    type: "worker-status",
    protocol_version: PROTOCOL_VERSION,
    worker: worker2
  };
}
__name(workerStatusFrame, "workerStatusFrame");
function notificationFrame(notification) {
  if (notification.payload.type === notification.type) {
    return {
      protocol_version: PROTOCOL_VERSION,
      ...notification.payload,
      type: notification.type,
      event_id: notification.eventId,
      receivedAt: notification.receivedAt
    };
  }
  return {
    type: notification.type,
    protocol_version: PROTOCOL_VERSION,
    event_id: notification.eventId,
    receivedAt: notification.receivedAt,
    payload: notification.payload
  };
}
__name(notificationFrame, "notificationFrame");
function appendNotification(notifications, notification) {
  return [...notifications, notification].slice(-EVENT_RING_BUFFER_LIMIT);
}
__name(appendNotification, "appendNotification");
function nextNotificationEventId(notifications) {
  const last = notifications.at(-1);
  const lastEventId = last === void 0 ? 0 : Number.parseInt(last.eventId, 10);
  return String((Number.isFinite(lastEventId) ? lastEventId : 0) + 1);
}
__name(nextNotificationEventId, "nextNotificationEventId");
function replayNotifications(notifications, lastEventId) {
  if (lastEventId === void 0) {
    return notifications;
  }
  return notifications.filter((notification) => {
    const eventId = Number.parseInt(notification.eventId, 10);
    return Number.isFinite(eventId) && eventId > lastEventId;
  });
}
__name(replayNotifications, "replayNotifications");
function selectDispatchWorker(registry, requiredCapabilities) {
  const candidates = Object.values(registry).filter((worker2) => isDispatchCandidate(worker2, requiredCapabilities)).sort(compareDispatchWorkers);
  return candidates[0];
}
__name(selectDispatchWorker, "selectDispatchWorker");
function isDispatchCandidate(worker2, requiredCapabilities) {
  if (worker2.status !== "idle" && !(worker2.status === "busy" && worker2.currentLoad < worker2.maxConcurrency)) {
    return false;
  }
  const capabilities = new Set(worker2.capabilities);
  return requiredCapabilities.every((capability) => capabilities.has(capability));
}
__name(isDispatchCandidate, "isDispatchCandidate");
function exceedsActiveWorkerCap(registry, usageCaps) {
  if (usageCaps.max_active_workers === void 0) {
    return false;
  }
  return Object.keys(registry).length >= usageCaps.max_active_workers;
}
__name(exceedsActiveWorkerCap, "exceedsActiveWorkerCap");
function compareDispatchWorkers(a, b) {
  const kindComparison = workerKindRank(a.kind) - workerKindRank(b.kind);
  if (kindComparison !== 0) {
    return kindComparison;
  }
  const loadComparison = a.currentLoad - b.currentLoad;
  if (loadComparison !== 0) {
    return loadComparison;
  }
  return a.workerId.localeCompare(b.workerId);
}
__name(compareDispatchWorkers, "compareDispatchWorkers");
function workerKindRank(kind) {
  return kind === "local" ? 0 : 1;
}
__name(workerKindRank, "workerKindRank");
function incrementWorkerLoad(worker2) {
  const currentLoad = clampWorkerLoad(worker2.currentLoad + 1, worker2.maxConcurrency);
  return {
    ...worker2,
    currentLoad,
    status: statusForWorkerLoad(currentLoad)
  };
}
__name(incrementWorkerLoad, "incrementWorkerLoad");
function decrementWorkerLoad(worker2) {
  if (worker2 === void 0) {
    return void 0;
  }
  const currentLoad = clampWorkerLoad(worker2.currentLoad - 1, worker2.maxConcurrency);
  return {
    ...worker2,
    currentLoad,
    status: statusForWorkerLoad(currentLoad)
  };
}
__name(decrementWorkerLoad, "decrementWorkerLoad");
function dispatchFrameFromBody(body, workerId, runId, issueRef) {
  const branch = getStringField2(body, "branch");
  const prompt = getStringField2(body, "prompt");
  const configHash = getStringField2(body, "configHash") ?? getStringField2(body, "config_hash");
  const leaseSec = getPositiveIntegerField(body, "leaseSec") ?? getPositiveIntegerField(body, "lease_sec");
  const artifactUploadURLs = getObjectField(body, "artifactUploadURLs") ?? getObjectField(body, "artifact_upload_urls");
  return {
    type: "dispatch",
    protocol_version: PROTOCOL_VERSION,
    runId,
    issueRef,
    workerId,
    ...branch === void 0 ? {} : { branch },
    ...prompt === void 0 ? {} : { prompt },
    ...configHash === void 0 ? {} : { configHash },
    ...leaseSec === void 0 ? {} : { leaseSec },
    ...artifactUploadURLs === void 0 ? {} : { artifactUploadURLs }
  };
}
__name(dispatchFrameFromBody, "dispatchFrameFromBody");
function getDispatchRequiredCapabilities(body) {
  for (const key of ["requiredCapabilities", "required_capabilities", "capabilities"]) {
    if (hasOwnField(body, key)) {
      return getStringArrayField(body, key);
    }
  }
  const requirements = getObjectField(body, "requirements");
  if (requirements === void 0) {
    return [];
  }
  if (!hasOwnField(requirements, "capabilities")) {
    return [];
  }
  return getStringArrayField(requirements, "capabilities");
}
__name(getDispatchRequiredCapabilities, "getDispatchRequiredCapabilities");
function parseWaitMs(value) {
  if (value === null || value.trim() === "") {
    return 0;
  }
  const trimmed = value.trim().toLowerCase();
  const match2 = /^(\d+)(ms|s)?$/u.exec(trimmed);
  if (match2?.[1] === void 0) {
    return 0;
  }
  const amount = Number.parseInt(match2[1], 10);
  if (!Number.isFinite(amount) || amount < 0) {
    return 0;
  }
  const waitMs = match2[2] === "ms" ? amount : amount * 1e3;
  return Math.min(waitMs, 25e3);
}
__name(parseWaitMs, "parseWaitMs");
function hasOwnField(body, key) {
  return Object.prototype.hasOwnProperty.call(body, key);
}
__name(hasOwnField, "hasOwnField");
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
function getSubscriptionWorkerId(request) {
  const header = request.headers.get("x-contrabass-worker-id");
  if (header !== null && header.trim() !== "") {
    return header;
  }
  const url = new URL(request.url);
  const query = url.searchParams.get("workerId") ?? url.searchParams.get("worker_id");
  if (query !== null && query.trim() !== "") {
    return query;
  }
  return void 0;
}
__name(getSubscriptionWorkerId, "getSubscriptionWorkerId");
function getLastEventId(request) {
  const raw2 = new URL(request.url).searchParams.get("last_event_id");
  if (raw2 === null || raw2.trim() === "") {
    return void 0;
  }
  const eventId = Number.parseInt(raw2, 10);
  return Number.isFinite(eventId) ? eventId : void 0;
}
__name(getLastEventId, "getLastEventId");
function usageDay(now) {
  return new Date(now).toISOString().slice(0, 10);
}
__name(usageDay, "usageDay");
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
function workerRecordFromRegistrationBody(body, now) {
  const workerId = getStringField2(body, "workerId") ?? getStringField2(body, "worker_id");
  const capabilities = getStringArrayField(body, "capabilities");
  const maxConcurrency = getPositiveIntegerField(body, "maxConcurrency") ?? getPositiveIntegerField(body, "max_concurrency");
  const kind = getWorkerKindField2(body);
  const version = getStringField2(body, "version");
  if (workerId === void 0 || capabilities === void 0 || maxConcurrency === void 0 || kind === void 0 || version === void 0) {
    return void 0;
  }
  return {
    workerId,
    capabilities,
    maxConcurrency,
    currentLoad: 0,
    lastHeartbeatTs: now,
    kind,
    version,
    status: "idle"
  };
}
__name(workerRecordFromRegistrationBody, "workerRecordFromRegistrationBody");
function normalizeWorkerRegistry(raw2, now) {
  const registry = {};
  for (const [workerId, worker2] of Object.entries(raw2)) {
    const normalized = normalizeWorkerRecord(workerId, worker2, now);
    if (normalized !== void 0) {
      registry[normalized.workerId] = normalized;
    }
  }
  return evaluateWorkerHealth(registry, now).registry;
}
__name(normalizeWorkerRegistry, "normalizeWorkerRegistry");
function normalizeWorkerRecord(fallbackWorkerId, value, now) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return void 0;
  }
  const record = value;
  const workerId = getStringField2(record, "workerId") ?? getStringField2(record, "worker_id") ?? fallbackWorkerId;
  const capabilities = getStringArrayField(record, "capabilities") ?? [];
  const maxConcurrency = getPositiveIntegerField(record, "maxConcurrency") ?? getPositiveIntegerField(record, "max_concurrency") ?? DEFAULT_WORKER_MAX_CONCURRENCY;
  const currentLoad = clampWorkerLoad(
    getNumberField(record, "currentLoad") ?? getNumberField(record, "current_load") ?? 0,
    maxConcurrency
  );
  const kind = getWorkerKindField2(record) ?? "local";
  const version = getStringField2(record, "version") ?? "unknown";
  const lastHeartbeatTs = getNumberField(record, "lastHeartbeatTs") ?? getNumberField(record, "last_heartbeat_ts") ?? now;
  return {
    workerId,
    capabilities,
    maxConcurrency,
    currentLoad,
    lastHeartbeatTs,
    kind,
    version,
    status: isWorkerUnhealthy(lastHeartbeatTs, now) ? "unhealthy" : statusForWorkerLoad(currentLoad)
  };
}
__name(normalizeWorkerRecord, "normalizeWorkerRecord");
function evaluateWorkerHealth(registry, now) {
  let changed = false;
  const evaluated = {};
  for (const [workerId, worker2] of Object.entries(registry)) {
    const status = isWorkerUnhealthy(worker2.lastHeartbeatTs, now) ? "unhealthy" : statusForWorkerLoad(worker2.currentLoad);
    if (status !== worker2.status) {
      changed = true;
    }
    evaluated[workerId] = {
      ...worker2,
      status
    };
  }
  return { registry: evaluated, changed };
}
__name(evaluateWorkerHealth, "evaluateWorkerHealth");
function isWorkerUnhealthy(lastHeartbeatTs, now) {
  return now - lastHeartbeatTs >= DEFAULT_REGISTRY_HEARTBEAT_INTERVAL_SEC * 3 * 1e3;
}
__name(isWorkerUnhealthy, "isWorkerUnhealthy");
function statusForWorkerLoad(currentLoad) {
  return currentLoad > 0 ? "busy" : "idle";
}
__name(statusForWorkerLoad, "statusForWorkerLoad");
function clampWorkerLoad(value, maxConcurrency) {
  return Math.max(0, Math.min(Math.trunc(value), maxConcurrency));
}
__name(clampWorkerLoad, "clampWorkerLoad");
function getStringArrayField(body, key) {
  const value = body[key];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    return void 0;
  }
  return value;
}
__name(getStringArrayField, "getStringArrayField");
function getPositiveIntegerField(body, key) {
  const value = getNumberField(body, key);
  if (value === void 0 || !Number.isInteger(value) || value < 1) {
    return void 0;
  }
  return value;
}
__name(getPositiveIntegerField, "getPositiveIntegerField");
function parseUsageCaps(body) {
  const source = getObjectField(body, "usageCaps") ?? getObjectField(body, "usage_caps") ?? getObjectField(body, "config") ?? getObjectField(body, "limits") ?? getObjectField(body, "team") ?? body;
  return normalizeUsageCaps(source);
}
__name(parseUsageCaps, "parseUsageCaps");
function normalizeUsageCaps(body) {
  const caps = {};
  const maxActiveWorkers = getPositiveIntegerField(body, "max_active_workers") ?? getPositiveIntegerField(body, "maxActiveWorkers");
  const maxRunsPerDay = getPositiveIntegerField(body, "max_runs_per_day") ?? getPositiveIntegerField(body, "maxRunsPerDay");
  const maxEventsPerDay = getPositiveIntegerField(body, "max_events_per_day") ?? getPositiveIntegerField(body, "maxEventsPerDay");
  if (maxActiveWorkers !== void 0) {
    caps.max_active_workers = maxActiveWorkers;
  }
  if (maxRunsPerDay !== void 0) {
    caps.max_runs_per_day = maxRunsPerDay;
  }
  if (maxEventsPerDay !== void 0) {
    caps.max_events_per_day = maxEventsPerDay;
  }
  return Object.keys(caps).length === 0 ? void 0 : caps;
}
__name(normalizeUsageCaps, "normalizeUsageCaps");
function usageCapsFromHeaders(headers) {
  const caps = {};
  const maxActiveWorkers = positiveIntegerHeader(headers, "x-contrabass-max-active-workers");
  const maxRunsPerDay = positiveIntegerHeader(headers, "x-contrabass-max-runs-per-day");
  const maxEventsPerDay = positiveIntegerHeader(headers, "x-contrabass-max-events-per-day");
  if (maxActiveWorkers !== void 0) {
    caps.max_active_workers = maxActiveWorkers;
  }
  if (maxRunsPerDay !== void 0) {
    caps.max_runs_per_day = maxRunsPerDay;
  }
  if (maxEventsPerDay !== void 0) {
    caps.max_events_per_day = maxEventsPerDay;
  }
  return Object.keys(caps).length === 0 ? void 0 : caps;
}
__name(usageCapsFromHeaders, "usageCapsFromHeaders");
function positiveIntegerHeader(headers, key) {
  const value = headers.get(key);
  if (value === null || value.trim() === "") {
    return void 0;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : void 0;
}
__name(positiveIntegerHeader, "positiveIntegerHeader");
function getWorkerKindField2(body) {
  const kind = getStringField2(body, "kind");
  if (kind === "local" || kind === "container") {
    return kind;
  }
  return void 0;
}
__name(getWorkerKindField2, "getWorkerKindField");
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
function teamWorkerCapExceededResponse(maxActiveWorkers) {
  return jsonResponse2({
    error: "team_worker_cap_exceeded",
    max_active_workers: maxActiveWorkers ?? 0,
    message: "team has reached the active worker limit",
    protocol_version: PROTOCOL_VERSION
  }, 429);
}
__name(teamWorkerCapExceededResponse, "teamWorkerCapExceededResponse");
function usageCapExceededResponse(error, capKey, cap) {
  return jsonResponse2({
    error,
    [capKey]: cap,
    message: "team has reached the daily usage limit",
    protocol_version: PROTOCOL_VERSION
  }, 429);
}
__name(usageCapExceededResponse, "usageCapExceededResponse");
async function forwardErrorResponse(response) {
  let body;
  try {
    body = await response.json();
  } catch {
    body = { error: "upstream_error" };
  }
  return Response.json(
    body === null || typeof body !== "object" || Array.isArray(body) ? { error: "upstream_error" } : body,
    { status: response.status }
  );
}
__name(forwardErrorResponse, "forwardErrorResponse");

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
  const timestamp2 = message.timestamp;
  if (timestamp2 instanceof Date) {
    return timestamp2;
  }
  return new Date(timestamp2);
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

// ../node_modules/.bun/hono@4.12.18/node_modules/hono/dist/compose.js
var compose = /* @__PURE__ */ __name((middleware, onError, onNotFound) => {
  return (context, next) => {
    let index = -1;
    return dispatch(0);
    async function dispatch(i) {
      if (i <= index) {
        throw new Error("next() called multiple times");
      }
      index = i;
      let res;
      let isError = false;
      let handler;
      if (middleware[i]) {
        handler = middleware[i][0][0];
        context.req.routeIndex = i;
      } else {
        handler = i === middleware.length && next || void 0;
      }
      if (handler) {
        try {
          res = await handler(context, () => dispatch(i + 1));
        } catch (err) {
          if (err instanceof Error && onError) {
            context.error = err;
            res = await onError(err, context);
            isError = true;
          } else {
            throw err;
          }
        }
      } else {
        if (context.finalized === false && onNotFound) {
          res = await onNotFound(context);
        }
      }
      if (res && (context.finalized === false || isError)) {
        context.res = res;
      }
      return context;
    }
    __name(dispatch, "dispatch");
  };
}, "compose");

// ../node_modules/.bun/hono@4.12.18/node_modules/hono/dist/request/constants.js
var GET_MATCH_RESULT = /* @__PURE__ */ Symbol();

// ../node_modules/.bun/hono@4.12.18/node_modules/hono/dist/utils/body.js
var parseBody = /* @__PURE__ */ __name(async (request, options = /* @__PURE__ */ Object.create(null)) => {
  const { all = false, dot = false } = options;
  const headers = request instanceof HonoRequest ? request.raw.headers : request.headers;
  const contentType = headers.get("Content-Type");
  if (contentType?.startsWith("multipart/form-data") || contentType?.startsWith("application/x-www-form-urlencoded")) {
    return parseFormData(request, { all, dot });
  }
  return {};
}, "parseBody");
async function parseFormData(request, options) {
  const formData = await request.formData();
  if (formData) {
    return convertFormDataToBodyData(formData, options);
  }
  return {};
}
__name(parseFormData, "parseFormData");
function convertFormDataToBodyData(formData, options) {
  const form = /* @__PURE__ */ Object.create(null);
  formData.forEach((value, key) => {
    const shouldParseAllValues = options.all || key.endsWith("[]");
    if (!shouldParseAllValues) {
      form[key] = value;
    } else {
      handleParsingAllValues(form, key, value);
    }
  });
  if (options.dot) {
    Object.entries(form).forEach(([key, value]) => {
      const shouldParseDotValues = key.includes(".");
      if (shouldParseDotValues) {
        handleParsingNestedValues(form, key, value);
        delete form[key];
      }
    });
  }
  return form;
}
__name(convertFormDataToBodyData, "convertFormDataToBodyData");
var handleParsingAllValues = /* @__PURE__ */ __name((form, key, value) => {
  if (form[key] !== void 0) {
    if (Array.isArray(form[key])) {
      ;
      form[key].push(value);
    } else {
      form[key] = [form[key], value];
    }
  } else {
    if (!key.endsWith("[]")) {
      form[key] = value;
    } else {
      form[key] = [value];
    }
  }
}, "handleParsingAllValues");
var handleParsingNestedValues = /* @__PURE__ */ __name((form, key, value) => {
  if (/(?:^|\.)__proto__\./.test(key)) {
    return;
  }
  let nestedForm = form;
  const keys = key.split(".");
  keys.forEach((key2, index) => {
    if (index === keys.length - 1) {
      nestedForm[key2] = value;
    } else {
      if (!nestedForm[key2] || typeof nestedForm[key2] !== "object" || Array.isArray(nestedForm[key2]) || nestedForm[key2] instanceof File) {
        nestedForm[key2] = /* @__PURE__ */ Object.create(null);
      }
      nestedForm = nestedForm[key2];
    }
  });
}, "handleParsingNestedValues");

// ../node_modules/.bun/hono@4.12.18/node_modules/hono/dist/utils/url.js
var splitPath = /* @__PURE__ */ __name((path) => {
  const paths = path.split("/");
  if (paths[0] === "") {
    paths.shift();
  }
  return paths;
}, "splitPath");
var splitRoutingPath = /* @__PURE__ */ __name((routePath) => {
  const { groups, path } = extractGroupsFromPath(routePath);
  const paths = splitPath(path);
  return replaceGroupMarks(paths, groups);
}, "splitRoutingPath");
var extractGroupsFromPath = /* @__PURE__ */ __name((path) => {
  const groups = [];
  path = path.replace(/\{[^}]+\}/g, (match2, index) => {
    const mark = `@${index}`;
    groups.push([mark, match2]);
    return mark;
  });
  return { groups, path };
}, "extractGroupsFromPath");
var replaceGroupMarks = /* @__PURE__ */ __name((paths, groups) => {
  for (let i = groups.length - 1; i >= 0; i--) {
    const [mark] = groups[i];
    for (let j = paths.length - 1; j >= 0; j--) {
      if (paths[j].includes(mark)) {
        paths[j] = paths[j].replace(mark, groups[i][1]);
        break;
      }
    }
  }
  return paths;
}, "replaceGroupMarks");
var patternCache = {};
var getPattern = /* @__PURE__ */ __name((label, next) => {
  if (label === "*") {
    return "*";
  }
  const match2 = label.match(/^\:([^\{\}]+)(?:\{(.+)\})?$/);
  if (match2) {
    const cacheKey = `${label}#${next}`;
    if (!patternCache[cacheKey]) {
      if (match2[2]) {
        patternCache[cacheKey] = next && next[0] !== ":" && next[0] !== "*" ? [cacheKey, match2[1], new RegExp(`^${match2[2]}(?=/${next})`)] : [label, match2[1], new RegExp(`^${match2[2]}$`)];
      } else {
        patternCache[cacheKey] = [label, match2[1], true];
      }
    }
    return patternCache[cacheKey];
  }
  return null;
}, "getPattern");
var tryDecode = /* @__PURE__ */ __name((str, decoder) => {
  try {
    return decoder(str);
  } catch {
    return str.replace(/(?:%[0-9A-Fa-f]{2})+/g, (match2) => {
      try {
        return decoder(match2);
      } catch {
        return match2;
      }
    });
  }
}, "tryDecode");
var tryDecodeURI = /* @__PURE__ */ __name((str) => tryDecode(str, decodeURI), "tryDecodeURI");
var getPath = /* @__PURE__ */ __name((request) => {
  const url = request.url;
  const start = url.indexOf("/", url.indexOf(":") + 4);
  let i = start;
  for (; i < url.length; i++) {
    const charCode = url.charCodeAt(i);
    if (charCode === 37) {
      const queryIndex = url.indexOf("?", i);
      const hashIndex = url.indexOf("#", i);
      const end = queryIndex === -1 ? hashIndex === -1 ? void 0 : hashIndex : hashIndex === -1 ? queryIndex : Math.min(queryIndex, hashIndex);
      const path = url.slice(start, end);
      return tryDecodeURI(path.includes("%25") ? path.replace(/%25/g, "%2525") : path);
    } else if (charCode === 63 || charCode === 35) {
      break;
    }
  }
  return url.slice(start, i);
}, "getPath");
var getPathNoStrict = /* @__PURE__ */ __name((request) => {
  const result = getPath(request);
  return result.length > 1 && result.at(-1) === "/" ? result.slice(0, -1) : result;
}, "getPathNoStrict");
var mergePath = /* @__PURE__ */ __name((base, sub, ...rest) => {
  if (rest.length) {
    sub = mergePath(sub, ...rest);
  }
  return `${base?.[0] === "/" ? "" : "/"}${base}${sub === "/" ? "" : `${base?.at(-1) === "/" ? "" : "/"}${sub?.[0] === "/" ? sub.slice(1) : sub}`}`;
}, "mergePath");
var checkOptionalParameter = /* @__PURE__ */ __name((path) => {
  if (path.charCodeAt(path.length - 1) !== 63 || !path.includes(":")) {
    return null;
  }
  const segments = path.split("/");
  const results = [];
  let basePath = "";
  segments.forEach((segment) => {
    if (segment !== "" && !/\:/.test(segment)) {
      basePath += "/" + segment;
    } else if (/\:/.test(segment)) {
      if (/\?/.test(segment)) {
        if (results.length === 0 && basePath === "") {
          results.push("/");
        } else {
          results.push(basePath);
        }
        const optionalSegment = segment.replace("?", "");
        basePath += "/" + optionalSegment;
        results.push(basePath);
      } else {
        basePath += "/" + segment;
      }
    }
  });
  return results.filter((v, i, a) => a.indexOf(v) === i);
}, "checkOptionalParameter");
var _decodeURI = /* @__PURE__ */ __name((value) => {
  if (!/[%+]/.test(value)) {
    return value;
  }
  if (value.indexOf("+") !== -1) {
    value = value.replace(/\+/g, " ");
  }
  return value.indexOf("%") !== -1 ? tryDecode(value, decodeURIComponent_) : value;
}, "_decodeURI");
var _getQueryParam = /* @__PURE__ */ __name((url, key, multiple) => {
  let encoded;
  if (!multiple && key && !/[%+]/.test(key)) {
    let keyIndex2 = url.indexOf("?", 8);
    if (keyIndex2 === -1) {
      return void 0;
    }
    if (!url.startsWith(key, keyIndex2 + 1)) {
      keyIndex2 = url.indexOf(`&${key}`, keyIndex2 + 1);
    }
    while (keyIndex2 !== -1) {
      const trailingKeyCode = url.charCodeAt(keyIndex2 + key.length + 1);
      if (trailingKeyCode === 61) {
        const valueIndex = keyIndex2 + key.length + 2;
        const endIndex = url.indexOf("&", valueIndex);
        return _decodeURI(url.slice(valueIndex, endIndex === -1 ? void 0 : endIndex));
      } else if (trailingKeyCode == 38 || isNaN(trailingKeyCode)) {
        return "";
      }
      keyIndex2 = url.indexOf(`&${key}`, keyIndex2 + 1);
    }
    encoded = /[%+]/.test(url);
    if (!encoded) {
      return void 0;
    }
  }
  const results = {};
  encoded ??= /[%+]/.test(url);
  let keyIndex = url.indexOf("?", 8);
  while (keyIndex !== -1) {
    const nextKeyIndex = url.indexOf("&", keyIndex + 1);
    let valueIndex = url.indexOf("=", keyIndex);
    if (valueIndex > nextKeyIndex && nextKeyIndex !== -1) {
      valueIndex = -1;
    }
    let name = url.slice(
      keyIndex + 1,
      valueIndex === -1 ? nextKeyIndex === -1 ? void 0 : nextKeyIndex : valueIndex
    );
    if (encoded) {
      name = _decodeURI(name);
    }
    keyIndex = nextKeyIndex;
    if (name === "") {
      continue;
    }
    let value;
    if (valueIndex === -1) {
      value = "";
    } else {
      value = url.slice(valueIndex + 1, nextKeyIndex === -1 ? void 0 : nextKeyIndex);
      if (encoded) {
        value = _decodeURI(value);
      }
    }
    if (multiple) {
      if (!(results[name] && Array.isArray(results[name]))) {
        results[name] = [];
      }
      ;
      results[name].push(value);
    } else {
      results[name] ??= value;
    }
  }
  return key ? results[key] : results;
}, "_getQueryParam");
var getQueryParam = _getQueryParam;
var getQueryParams = /* @__PURE__ */ __name((url, key) => {
  return _getQueryParam(url, key, true);
}, "getQueryParams");
var decodeURIComponent_ = decodeURIComponent;

// ../node_modules/.bun/hono@4.12.18/node_modules/hono/dist/request.js
var tryDecodeURIComponent = /* @__PURE__ */ __name((str) => tryDecode(str, decodeURIComponent_), "tryDecodeURIComponent");
var HonoRequest = class {
  static {
    __name(this, "HonoRequest");
  }
  /**
   * `.raw` can get the raw Request object.
   *
   * @see {@link https://hono.dev/docs/api/request#raw}
   *
   * @example
   * ```ts
   * // For Cloudflare Workers
   * app.post('/', async (c) => {
   *   const metadata = c.req.raw.cf?.hostMetadata?
   *   ...
   * })
   * ```
   */
  raw;
  #validatedData;
  // Short name of validatedData
  #matchResult;
  routeIndex = 0;
  /**
   * `.path` can get the pathname of the request.
   *
   * @see {@link https://hono.dev/docs/api/request#path}
   *
   * @example
   * ```ts
   * app.get('/about/me', (c) => {
   *   const pathname = c.req.path // `/about/me`
   * })
   * ```
   */
  path;
  bodyCache = {};
  constructor(request, path = "/", matchResult = [[]]) {
    this.raw = request;
    this.path = path;
    this.#matchResult = matchResult;
    this.#validatedData = {};
  }
  param(key) {
    return key ? this.#getDecodedParam(key) : this.#getAllDecodedParams();
  }
  #getDecodedParam(key) {
    const paramKey = this.#matchResult[0][this.routeIndex][1][key];
    const param = this.#getParamValue(paramKey);
    return param && /\%/.test(param) ? tryDecodeURIComponent(param) : param;
  }
  #getAllDecodedParams() {
    const decoded = {};
    const keys = Object.keys(this.#matchResult[0][this.routeIndex][1]);
    for (const key of keys) {
      const value = this.#getParamValue(this.#matchResult[0][this.routeIndex][1][key]);
      if (value !== void 0) {
        decoded[key] = /\%/.test(value) ? tryDecodeURIComponent(value) : value;
      }
    }
    return decoded;
  }
  #getParamValue(paramKey) {
    return this.#matchResult[1] ? this.#matchResult[1][paramKey] : paramKey;
  }
  query(key) {
    return getQueryParam(this.url, key);
  }
  queries(key) {
    return getQueryParams(this.url, key);
  }
  header(name) {
    if (name) {
      return this.raw.headers.get(name) ?? void 0;
    }
    const headerData = {};
    this.raw.headers.forEach((value, key) => {
      headerData[key] = value;
    });
    return headerData;
  }
  async parseBody(options) {
    return parseBody(this, options);
  }
  #cachedBody = /* @__PURE__ */ __name((key) => {
    const { bodyCache, raw: raw2 } = this;
    const cachedBody = bodyCache[key];
    if (cachedBody) {
      return cachedBody;
    }
    const anyCachedKey = Object.keys(bodyCache)[0];
    if (anyCachedKey) {
      return bodyCache[anyCachedKey].then((body) => {
        if (anyCachedKey === "json") {
          body = JSON.stringify(body);
        }
        return new Response(body)[key]();
      });
    }
    return bodyCache[key] = raw2[key]();
  }, "#cachedBody");
  /**
   * `.json()` can parse Request body of type `application/json`
   *
   * @see {@link https://hono.dev/docs/api/request#json}
   *
   * @example
   * ```ts
   * app.post('/entry', async (c) => {
   *   const body = await c.req.json()
   * })
   * ```
   */
  json() {
    return this.#cachedBody("text").then((text) => JSON.parse(text));
  }
  /**
   * `.text()` can parse Request body of type `text/plain`
   *
   * @see {@link https://hono.dev/docs/api/request#text}
   *
   * @example
   * ```ts
   * app.post('/entry', async (c) => {
   *   const body = await c.req.text()
   * })
   * ```
   */
  text() {
    return this.#cachedBody("text");
  }
  /**
   * `.arrayBuffer()` parse Request body as an `ArrayBuffer`
   *
   * @see {@link https://hono.dev/docs/api/request#arraybuffer}
   *
   * @example
   * ```ts
   * app.post('/entry', async (c) => {
   *   const body = await c.req.arrayBuffer()
   * })
   * ```
   */
  arrayBuffer() {
    return this.#cachedBody("arrayBuffer");
  }
  /**
   * Parses the request body as a `Blob`.
   * @example
   * ```ts
   * app.post('/entry', async (c) => {
   *   const body = await c.req.blob();
   * });
   * ```
   * @see https://hono.dev/docs/api/request#blob
   */
  blob() {
    return this.#cachedBody("blob");
  }
  /**
   * Parses the request body as `FormData`.
   * @example
   * ```ts
   * app.post('/entry', async (c) => {
   *   const body = await c.req.formData();
   * });
   * ```
   * @see https://hono.dev/docs/api/request#formdata
   */
  formData() {
    return this.#cachedBody("formData");
  }
  /**
   * Adds validated data to the request.
   *
   * @param target - The target of the validation.
   * @param data - The validated data to add.
   */
  addValidatedData(target, data) {
    this.#validatedData[target] = data;
  }
  valid(target) {
    return this.#validatedData[target];
  }
  /**
   * `.url()` can get the request url strings.
   *
   * @see {@link https://hono.dev/docs/api/request#url}
   *
   * @example
   * ```ts
   * app.get('/about/me', (c) => {
   *   const url = c.req.url // `http://localhost:8787/about/me`
   *   ...
   * })
   * ```
   */
  get url() {
    return this.raw.url;
  }
  /**
   * `.method()` can get the method name of the request.
   *
   * @see {@link https://hono.dev/docs/api/request#method}
   *
   * @example
   * ```ts
   * app.get('/about/me', (c) => {
   *   const method = c.req.method // `GET`
   * })
   * ```
   */
  get method() {
    return this.raw.method;
  }
  get [GET_MATCH_RESULT]() {
    return this.#matchResult;
  }
  /**
   * `.matchedRoutes()` can return a matched route in the handler
   *
   * @deprecated
   *
   * Use matchedRoutes helper defined in "hono/route" instead.
   *
   * @see {@link https://hono.dev/docs/api/request#matchedroutes}
   *
   * @example
   * ```ts
   * app.use('*', async function logger(c, next) {
   *   await next()
   *   c.req.matchedRoutes.forEach(({ handler, method, path }, i) => {
   *     const name = handler.name || (handler.length < 2 ? '[handler]' : '[middleware]')
   *     console.log(
   *       method,
   *       ' ',
   *       path,
   *       ' '.repeat(Math.max(10 - path.length, 0)),
   *       name,
   *       i === c.req.routeIndex ? '<- respond from here' : ''
   *     )
   *   })
   * })
   * ```
   */
  get matchedRoutes() {
    return this.#matchResult[0].map(([[, route]]) => route);
  }
  /**
   * `routePath()` can retrieve the path registered within the handler
   *
   * @deprecated
   *
   * Use routePath helper defined in "hono/route" instead.
   *
   * @see {@link https://hono.dev/docs/api/request#routepath}
   *
   * @example
   * ```ts
   * app.get('/posts/:id', (c) => {
   *   return c.json({ path: c.req.routePath })
   * })
   * ```
   */
  get routePath() {
    return this.#matchResult[0].map(([[, route]]) => route)[this.routeIndex].path;
  }
};

// ../node_modules/.bun/hono@4.12.18/node_modules/hono/dist/utils/html.js
var HtmlEscapedCallbackPhase = {
  Stringify: 1,
  BeforeStream: 2,
  Stream: 3
};
var raw = /* @__PURE__ */ __name((value, callbacks) => {
  const escapedString = new String(value);
  escapedString.isEscaped = true;
  escapedString.callbacks = callbacks;
  return escapedString;
}, "raw");
var resolveCallback = /* @__PURE__ */ __name(async (str, phase, preserveCallbacks, context, buffer) => {
  if (typeof str === "object" && !(str instanceof String)) {
    if (!(str instanceof Promise)) {
      str = str.toString();
    }
    if (str instanceof Promise) {
      str = await str;
    }
  }
  const callbacks = str.callbacks;
  if (!callbacks?.length) {
    return Promise.resolve(str);
  }
  if (buffer) {
    buffer[0] += str;
  } else {
    buffer = [str];
  }
  const resStr = Promise.all(callbacks.map((c) => c({ phase, buffer, context }))).then(
    (res) => Promise.all(
      res.filter(Boolean).map((str2) => resolveCallback(str2, phase, false, context, buffer))
    ).then(() => buffer[0])
  );
  if (preserveCallbacks) {
    return raw(await resStr, callbacks);
  } else {
    return resStr;
  }
}, "resolveCallback");

// ../node_modules/.bun/hono@4.12.18/node_modules/hono/dist/context.js
var TEXT_PLAIN = "text/plain; charset=UTF-8";
var setDefaultContentType = /* @__PURE__ */ __name((contentType, headers) => {
  return {
    "Content-Type": contentType,
    ...headers
  };
}, "setDefaultContentType");
var createResponseInstance = /* @__PURE__ */ __name((body, init) => new Response(body, init), "createResponseInstance");
var Context = class {
  static {
    __name(this, "Context");
  }
  #rawRequest;
  #req;
  /**
   * `.env` can get bindings (environment variables, secrets, KV namespaces, D1 database, R2 bucket etc.) in Cloudflare Workers.
   *
   * @see {@link https://hono.dev/docs/api/context#env}
   *
   * @example
   * ```ts
   * // Environment object for Cloudflare Workers
   * app.get('*', async c => {
   *   const counter = c.env.COUNTER
   * })
   * ```
   */
  env = {};
  #var;
  finalized = false;
  /**
   * `.error` can get the error object from the middleware if the Handler throws an error.
   *
   * @see {@link https://hono.dev/docs/api/context#error}
   *
   * @example
   * ```ts
   * app.use('*', async (c, next) => {
   *   await next()
   *   if (c.error) {
   *     // do something...
   *   }
   * })
   * ```
   */
  error;
  #status;
  #executionCtx;
  #res;
  #layout;
  #renderer;
  #notFoundHandler;
  #preparedHeaders;
  #matchResult;
  #path;
  /**
   * Creates an instance of the Context class.
   *
   * @param req - The Request object.
   * @param options - Optional configuration options for the context.
   */
  constructor(req, options) {
    this.#rawRequest = req;
    if (options) {
      this.#executionCtx = options.executionCtx;
      this.env = options.env;
      this.#notFoundHandler = options.notFoundHandler;
      this.#path = options.path;
      this.#matchResult = options.matchResult;
    }
  }
  /**
   * `.req` is the instance of {@link HonoRequest}.
   */
  get req() {
    this.#req ??= new HonoRequest(this.#rawRequest, this.#path, this.#matchResult);
    return this.#req;
  }
  /**
   * @see {@link https://hono.dev/docs/api/context#event}
   * The FetchEvent associated with the current request.
   *
   * @throws Will throw an error if the context does not have a FetchEvent.
   */
  get event() {
    if (this.#executionCtx && "respondWith" in this.#executionCtx) {
      return this.#executionCtx;
    } else {
      throw Error("This context has no FetchEvent");
    }
  }
  /**
   * @see {@link https://hono.dev/docs/api/context#executionctx}
   * The ExecutionContext associated with the current request.
   *
   * @throws Will throw an error if the context does not have an ExecutionContext.
   */
  get executionCtx() {
    if (this.#executionCtx) {
      return this.#executionCtx;
    } else {
      throw Error("This context has no ExecutionContext");
    }
  }
  /**
   * @see {@link https://hono.dev/docs/api/context#res}
   * The Response object for the current request.
   */
  get res() {
    return this.#res ||= createResponseInstance(null, {
      headers: this.#preparedHeaders ??= new Headers()
    });
  }
  /**
   * Sets the Response object for the current request.
   *
   * @param _res - The Response object to set.
   */
  set res(_res) {
    if (this.#res && _res) {
      _res = createResponseInstance(_res.body, _res);
      for (const [k, v] of this.#res.headers.entries()) {
        if (k === "content-type") {
          continue;
        }
        if (k === "set-cookie") {
          const cookies = this.#res.headers.getSetCookie();
          _res.headers.delete("set-cookie");
          for (const cookie of cookies) {
            _res.headers.append("set-cookie", cookie);
          }
        } else {
          _res.headers.set(k, v);
        }
      }
    }
    this.#res = _res;
    this.finalized = true;
  }
  /**
   * `.render()` can create a response within a layout.
   *
   * @see {@link https://hono.dev/docs/api/context#render-setrenderer}
   *
   * @example
   * ```ts
   * app.get('/', (c) => {
   *   return c.render('Hello!')
   * })
   * ```
   */
  render = /* @__PURE__ */ __name((...args) => {
    this.#renderer ??= (content) => this.html(content);
    return this.#renderer(...args);
  }, "render");
  /**
   * Sets the layout for the response.
   *
   * @param layout - The layout to set.
   * @returns The layout function.
   */
  setLayout = /* @__PURE__ */ __name((layout) => this.#layout = layout, "setLayout");
  /**
   * Gets the current layout for the response.
   *
   * @returns The current layout function.
   */
  getLayout = /* @__PURE__ */ __name(() => this.#layout, "getLayout");
  /**
   * `.setRenderer()` can set the layout in the custom middleware.
   *
   * @see {@link https://hono.dev/docs/api/context#render-setrenderer}
   *
   * @example
   * ```tsx
   * app.use('*', async (c, next) => {
   *   c.setRenderer((content) => {
   *     return c.html(
   *       <html>
   *         <body>
   *           <p>{content}</p>
   *         </body>
   *       </html>
   *     )
   *   })
   *   await next()
   * })
   * ```
   */
  setRenderer = /* @__PURE__ */ __name((renderer) => {
    this.#renderer = renderer;
  }, "setRenderer");
  /**
   * `.header()` can set headers.
   *
   * @see {@link https://hono.dev/docs/api/context#header}
   *
   * @example
   * ```ts
   * app.get('/welcome', (c) => {
   *   // Set headers
   *   c.header('X-Message', 'Hello!')
   *   c.header('Content-Type', 'text/plain')
   *
   *   return c.body('Thank you for coming')
   * })
   * ```
   */
  header = /* @__PURE__ */ __name((name, value, options) => {
    if (this.finalized) {
      this.#res = createResponseInstance(this.#res.body, this.#res);
    }
    const headers = this.#res ? this.#res.headers : this.#preparedHeaders ??= new Headers();
    if (value === void 0) {
      headers.delete(name);
    } else if (options?.append) {
      headers.append(name, value);
    } else {
      headers.set(name, value);
    }
  }, "header");
  status = /* @__PURE__ */ __name((status) => {
    this.#status = status;
  }, "status");
  /**
   * `.set()` can set the value specified by the key.
   *
   * @see {@link https://hono.dev/docs/api/context#set-get}
   *
   * @example
   * ```ts
   * app.use('*', async (c, next) => {
   *   c.set('message', 'Hono is hot!!')
   *   await next()
   * })
   * ```
   */
  set = /* @__PURE__ */ __name((key, value) => {
    this.#var ??= /* @__PURE__ */ new Map();
    this.#var.set(key, value);
  }, "set");
  /**
   * `.get()` can use the value specified by the key.
   *
   * @see {@link https://hono.dev/docs/api/context#set-get}
   *
   * @example
   * ```ts
   * app.get('/', (c) => {
   *   const message = c.get('message')
   *   return c.text(`The message is "${message}"`)
   * })
   * ```
   */
  get = /* @__PURE__ */ __name((key) => {
    return this.#var ? this.#var.get(key) : void 0;
  }, "get");
  /**
   * `.var` can access the value of a variable.
   *
   * @see {@link https://hono.dev/docs/api/context#var}
   *
   * @example
   * ```ts
   * const result = c.var.client.oneMethod()
   * ```
   */
  // c.var.propName is a read-only
  get var() {
    if (!this.#var) {
      return {};
    }
    return Object.fromEntries(this.#var);
  }
  #newResponse(data, arg, headers) {
    const responseHeaders = this.#res ? new Headers(this.#res.headers) : this.#preparedHeaders ?? new Headers();
    if (typeof arg === "object" && "headers" in arg) {
      const argHeaders = arg.headers instanceof Headers ? arg.headers : new Headers(arg.headers);
      for (const [key, value] of argHeaders) {
        if (key.toLowerCase() === "set-cookie") {
          responseHeaders.append(key, value);
        } else {
          responseHeaders.set(key, value);
        }
      }
    }
    if (headers) {
      for (const [k, v] of Object.entries(headers)) {
        if (typeof v === "string") {
          responseHeaders.set(k, v);
        } else {
          responseHeaders.delete(k);
          for (const v2 of v) {
            responseHeaders.append(k, v2);
          }
        }
      }
    }
    const status = typeof arg === "number" ? arg : arg?.status ?? this.#status;
    return createResponseInstance(data, { status, headers: responseHeaders });
  }
  newResponse = /* @__PURE__ */ __name((...args) => this.#newResponse(...args), "newResponse");
  /**
   * `.body()` can return the HTTP response.
   * You can set headers with `.header()` and set HTTP status code with `.status`.
   * This can also be set in `.text()`, `.json()` and so on.
   *
   * @see {@link https://hono.dev/docs/api/context#body}
   *
   * @example
   * ```ts
   * app.get('/welcome', (c) => {
   *   // Set headers
   *   c.header('X-Message', 'Hello!')
   *   c.header('Content-Type', 'text/plain')
   *   // Set HTTP status code
   *   c.status(201)
   *
   *   // Return the response body
   *   return c.body('Thank you for coming')
   * })
   * ```
   */
  body = /* @__PURE__ */ __name((data, arg, headers) => this.#newResponse(data, arg, headers), "body");
  /**
   * `.text()` can render text as `Content-Type:text/plain`.
   *
   * @see {@link https://hono.dev/docs/api/context#text}
   *
   * @example
   * ```ts
   * app.get('/say', (c) => {
   *   return c.text('Hello!')
   * })
   * ```
   */
  text = /* @__PURE__ */ __name((text, arg, headers) => {
    return !this.#preparedHeaders && !this.#status && !arg && !headers && !this.finalized ? new Response(text) : this.#newResponse(
      text,
      arg,
      setDefaultContentType(TEXT_PLAIN, headers)
    );
  }, "text");
  /**
   * `.json()` can render JSON as `Content-Type:application/json`.
   *
   * @see {@link https://hono.dev/docs/api/context#json}
   *
   * @example
   * ```ts
   * app.get('/api', (c) => {
   *   return c.json({ message: 'Hello!' })
   * })
   * ```
   */
  json = /* @__PURE__ */ __name((object, arg, headers) => {
    return this.#newResponse(
      JSON.stringify(object),
      arg,
      setDefaultContentType("application/json", headers)
    );
  }, "json");
  html = /* @__PURE__ */ __name((html, arg, headers) => {
    const res = /* @__PURE__ */ __name((html2) => this.#newResponse(html2, arg, setDefaultContentType("text/html; charset=UTF-8", headers)), "res");
    return typeof html === "object" ? resolveCallback(html, HtmlEscapedCallbackPhase.Stringify, false, {}).then(res) : res(html);
  }, "html");
  /**
   * `.redirect()` can Redirect, default status code is 302.
   *
   * @see {@link https://hono.dev/docs/api/context#redirect}
   *
   * @example
   * ```ts
   * app.get('/redirect', (c) => {
   *   return c.redirect('/')
   * })
   * app.get('/redirect-permanently', (c) => {
   *   return c.redirect('/', 301)
   * })
   * ```
   */
  redirect = /* @__PURE__ */ __name((location, status) => {
    const locationString = String(location);
    this.header(
      "Location",
      // Multibyes should be encoded
      // eslint-disable-next-line no-control-regex
      !/[^\x00-\xFF]/.test(locationString) ? locationString : encodeURI(locationString)
    );
    return this.newResponse(null, status ?? 302);
  }, "redirect");
  /**
   * `.notFound()` can return the Not Found Response.
   *
   * @see {@link https://hono.dev/docs/api/context#notfound}
   *
   * @example
   * ```ts
   * app.get('/notfound', (c) => {
   *   return c.notFound()
   * })
   * ```
   */
  notFound = /* @__PURE__ */ __name(() => {
    this.#notFoundHandler ??= () => createResponseInstance();
    return this.#notFoundHandler(this);
  }, "notFound");
};

// ../node_modules/.bun/hono@4.12.18/node_modules/hono/dist/router.js
var METHOD_NAME_ALL = "ALL";
var METHOD_NAME_ALL_LOWERCASE = "all";
var METHODS = ["get", "post", "put", "delete", "options", "patch"];
var MESSAGE_MATCHER_IS_ALREADY_BUILT = "Can not add a route since the matcher is already built.";
var UnsupportedPathError = class extends Error {
  static {
    __name(this, "UnsupportedPathError");
  }
};

// ../node_modules/.bun/hono@4.12.18/node_modules/hono/dist/utils/constants.js
var COMPOSED_HANDLER = "__COMPOSED_HANDLER";

// ../node_modules/.bun/hono@4.12.18/node_modules/hono/dist/hono-base.js
var notFoundHandler = /* @__PURE__ */ __name((c) => {
  return c.text("404 Not Found", 404);
}, "notFoundHandler");
var errorHandler = /* @__PURE__ */ __name((err, c) => {
  if ("getResponse" in err) {
    const res = err.getResponse();
    return c.newResponse(res.body, res);
  }
  console.error(err);
  return c.text("Internal Server Error", 500);
}, "errorHandler");
var Hono = class _Hono {
  static {
    __name(this, "_Hono");
  }
  get;
  post;
  put;
  delete;
  options;
  patch;
  all;
  on;
  use;
  /*
    This class is like an abstract class and does not have a router.
    To use it, inherit the class and implement router in the constructor.
  */
  router;
  getPath;
  // Cannot use `#` because it requires visibility at JavaScript runtime.
  _basePath = "/";
  #path = "/";
  routes = [];
  constructor(options = {}) {
    const allMethods = [...METHODS, METHOD_NAME_ALL_LOWERCASE];
    allMethods.forEach((method) => {
      this[method] = (args1, ...args) => {
        if (typeof args1 === "string") {
          this.#path = args1;
        } else {
          this.#addRoute(method, this.#path, args1);
        }
        args.forEach((handler) => {
          this.#addRoute(method, this.#path, handler);
        });
        return this;
      };
    });
    this.on = (method, path, ...handlers) => {
      for (const p of [path].flat()) {
        this.#path = p;
        for (const m of [method].flat()) {
          handlers.map((handler) => {
            this.#addRoute(m.toUpperCase(), this.#path, handler);
          });
        }
      }
      return this;
    };
    this.use = (arg1, ...handlers) => {
      if (typeof arg1 === "string") {
        this.#path = arg1;
      } else {
        this.#path = "*";
        handlers.unshift(arg1);
      }
      handlers.forEach((handler) => {
        this.#addRoute(METHOD_NAME_ALL, this.#path, handler);
      });
      return this;
    };
    const { strict, ...optionsWithoutStrict } = options;
    Object.assign(this, optionsWithoutStrict);
    this.getPath = strict ?? true ? options.getPath ?? getPath : getPathNoStrict;
  }
  #clone() {
    const clone = new _Hono({
      router: this.router,
      getPath: this.getPath
    });
    clone.errorHandler = this.errorHandler;
    clone.#notFoundHandler = this.#notFoundHandler;
    clone.routes = this.routes;
    return clone;
  }
  #notFoundHandler = notFoundHandler;
  // Cannot use `#` because it requires visibility at JavaScript runtime.
  errorHandler = errorHandler;
  /**
   * `.route()` allows grouping other Hono instance in routes.
   *
   * @see {@link https://hono.dev/docs/api/routing#grouping}
   *
   * @param {string} path - base Path
   * @param {Hono} app - other Hono instance
   * @returns {Hono} routed Hono instance
   *
   * @example
   * ```ts
   * const app = new Hono()
   * const app2 = new Hono()
   *
   * app2.get("/user", (c) => c.text("user"))
   * app.route("/api", app2) // GET /api/user
   * ```
   */
  route(path, app) {
    const subApp = this.basePath(path);
    app.routes.map((r) => {
      let handler;
      if (app.errorHandler === errorHandler) {
        handler = r.handler;
      } else {
        handler = /* @__PURE__ */ __name(async (c, next) => (await compose([], app.errorHandler)(c, () => r.handler(c, next))).res, "handler");
        handler[COMPOSED_HANDLER] = r.handler;
      }
      subApp.#addRoute(r.method, r.path, handler);
    });
    return this;
  }
  /**
   * `.basePath()` allows base paths to be specified.
   *
   * @see {@link https://hono.dev/docs/api/routing#base-path}
   *
   * @param {string} path - base Path
   * @returns {Hono} changed Hono instance
   *
   * @example
   * ```ts
   * const api = new Hono().basePath('/api')
   * ```
   */
  basePath(path) {
    const subApp = this.#clone();
    subApp._basePath = mergePath(this._basePath, path);
    return subApp;
  }
  /**
   * `.onError()` handles an error and returns a customized Response.
   *
   * @see {@link https://hono.dev/docs/api/hono#error-handling}
   *
   * @param {ErrorHandler} handler - request Handler for error
   * @returns {Hono} changed Hono instance
   *
   * @example
   * ```ts
   * app.onError((err, c) => {
   *   console.error(`${err}`)
   *   return c.text('Custom Error Message', 500)
   * })
   * ```
   */
  onError = /* @__PURE__ */ __name((handler) => {
    this.errorHandler = handler;
    return this;
  }, "onError");
  /**
   * `.notFound()` allows you to customize a Not Found Response.
   *
   * @see {@link https://hono.dev/docs/api/hono#not-found}
   *
   * @param {NotFoundHandler} handler - request handler for not-found
   * @returns {Hono} changed Hono instance
   *
   * @example
   * ```ts
   * app.notFound((c) => {
   *   return c.text('Custom 404 Message', 404)
   * })
   * ```
   */
  notFound = /* @__PURE__ */ __name((handler) => {
    this.#notFoundHandler = handler;
    return this;
  }, "notFound");
  /**
   * `.mount()` allows you to mount applications built with other frameworks into your Hono application.
   *
   * @see {@link https://hono.dev/docs/api/hono#mount}
   *
   * @param {string} path - base Path
   * @param {Function} applicationHandler - other Request Handler
   * @param {MountOptions} [options] - options of `.mount()`
   * @returns {Hono} mounted Hono instance
   *
   * @example
   * ```ts
   * import { Router as IttyRouter } from 'itty-router'
   * import { Hono } from 'hono'
   * // Create itty-router application
   * const ittyRouter = IttyRouter()
   * // GET /itty-router/hello
   * ittyRouter.get('/hello', () => new Response('Hello from itty-router'))
   *
   * const app = new Hono()
   * app.mount('/itty-router', ittyRouter.handle)
   * ```
   *
   * @example
   * ```ts
   * const app = new Hono()
   * // Send the request to another application without modification.
   * app.mount('/app', anotherApp, {
   *   replaceRequest: (req) => req,
   * })
   * ```
   */
  mount(path, applicationHandler, options) {
    let replaceRequest;
    let optionHandler;
    if (options) {
      if (typeof options === "function") {
        optionHandler = options;
      } else {
        optionHandler = options.optionHandler;
        if (options.replaceRequest === false) {
          replaceRequest = /* @__PURE__ */ __name((request) => request, "replaceRequest");
        } else {
          replaceRequest = options.replaceRequest;
        }
      }
    }
    const getOptions = optionHandler ? (c) => {
      const options2 = optionHandler(c);
      return Array.isArray(options2) ? options2 : [options2];
    } : (c) => {
      let executionContext = void 0;
      try {
        executionContext = c.executionCtx;
      } catch {
      }
      return [c.env, executionContext];
    };
    replaceRequest ||= (() => {
      const mergedPath = mergePath(this._basePath, path);
      const pathPrefixLength = mergedPath === "/" ? 0 : mergedPath.length;
      return (request) => {
        const url = new URL(request.url);
        url.pathname = url.pathname.slice(pathPrefixLength) || "/";
        return new Request(url, request);
      };
    })();
    const handler = /* @__PURE__ */ __name(async (c, next) => {
      const res = await applicationHandler(replaceRequest(c.req.raw), ...getOptions(c));
      if (res) {
        return res;
      }
      await next();
    }, "handler");
    this.#addRoute(METHOD_NAME_ALL, mergePath(path, "*"), handler);
    return this;
  }
  #addRoute(method, path, handler) {
    method = method.toUpperCase();
    path = mergePath(this._basePath, path);
    const r = { basePath: this._basePath, path, method, handler };
    this.router.add(method, path, [handler, r]);
    this.routes.push(r);
  }
  #handleError(err, c) {
    if (err instanceof Error) {
      return this.errorHandler(err, c);
    }
    throw err;
  }
  #dispatch(request, executionCtx, env, method) {
    if (method === "HEAD") {
      return (async () => new Response(null, await this.#dispatch(request, executionCtx, env, "GET")))();
    }
    const path = this.getPath(request, { env });
    const matchResult = this.router.match(method, path);
    const c = new Context(request, {
      path,
      matchResult,
      env,
      executionCtx,
      notFoundHandler: this.#notFoundHandler
    });
    if (matchResult[0].length === 1) {
      let res;
      try {
        res = matchResult[0][0][0][0](c, async () => {
          c.res = await this.#notFoundHandler(c);
        });
      } catch (err) {
        return this.#handleError(err, c);
      }
      return res instanceof Promise ? res.then(
        (resolved) => resolved || (c.finalized ? c.res : this.#notFoundHandler(c))
      ).catch((err) => this.#handleError(err, c)) : res ?? this.#notFoundHandler(c);
    }
    const composed = compose(matchResult[0], this.errorHandler, this.#notFoundHandler);
    return (async () => {
      try {
        const context = await composed(c);
        if (!context.finalized) {
          throw new Error(
            "Context is not finalized. Did you forget to return a Response object or `await next()`?"
          );
        }
        return context.res;
      } catch (err) {
        return this.#handleError(err, c);
      }
    })();
  }
  /**
   * `.fetch()` will be entry point of your app.
   *
   * @see {@link https://hono.dev/docs/api/hono#fetch}
   *
   * @param {Request} request - request Object of request
   * @param {Env} Env - env Object
   * @param {ExecutionContext} - context of execution
   * @returns {Response | Promise<Response>} response of request
   *
   */
  fetch = /* @__PURE__ */ __name((request, ...rest) => {
    return this.#dispatch(request, rest[1], rest[0], request.method);
  }, "fetch");
  /**
   * `.request()` is a useful method for testing.
   * You can pass a URL or pathname to send a GET request.
   * app will return a Response object.
   * ```ts
   * test('GET /hello is ok', async () => {
   *   const res = await app.request('/hello')
   *   expect(res.status).toBe(200)
   * })
   * ```
   * @see https://hono.dev/docs/api/hono#request
   */
  request = /* @__PURE__ */ __name((input, requestInit, Env, executionCtx) => {
    if (input instanceof Request) {
      return this.fetch(requestInit ? new Request(input, requestInit) : input, Env, executionCtx);
    }
    input = input.toString();
    return this.fetch(
      new Request(
        /^https?:\/\//.test(input) ? input : `http://localhost${mergePath("/", input)}`,
        requestInit
      ),
      Env,
      executionCtx
    );
  }, "request");
  /**
   * `.fire()` automatically adds a global fetch event listener.
   * This can be useful for environments that adhere to the Service Worker API, such as non-ES module Cloudflare Workers.
   * @deprecated
   * Use `fire` from `hono/service-worker` instead.
   * ```ts
   * import { Hono } from 'hono'
   * import { fire } from 'hono/service-worker'
   *
   * const app = new Hono()
   * // ...
   * fire(app)
   * ```
   * @see https://hono.dev/docs/api/hono#fire
   * @see https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API
   * @see https://developers.cloudflare.com/workers/reference/migrate-to-module-workers/
   */
  fire = /* @__PURE__ */ __name(() => {
    addEventListener("fetch", (event) => {
      event.respondWith(this.#dispatch(event.request, event, void 0, event.request.method));
    });
  }, "fire");
};

// ../node_modules/.bun/hono@4.12.18/node_modules/hono/dist/router/reg-exp-router/matcher.js
var emptyParam = [];
function match(method, path) {
  const matchers = this.buildAllMatchers();
  const match2 = /* @__PURE__ */ __name(((method2, path2) => {
    const matcher = matchers[method2] || matchers[METHOD_NAME_ALL];
    const staticMatch = matcher[2][path2];
    if (staticMatch) {
      return staticMatch;
    }
    const match3 = path2.match(matcher[0]);
    if (!match3) {
      return [[], emptyParam];
    }
    const index = match3.indexOf("", 1);
    return [matcher[1][index], match3];
  }), "match2");
  this.match = match2;
  return match2(method, path);
}
__name(match, "match");

// ../node_modules/.bun/hono@4.12.18/node_modules/hono/dist/router/reg-exp-router/node.js
var LABEL_REG_EXP_STR = "[^/]+";
var ONLY_WILDCARD_REG_EXP_STR = ".*";
var TAIL_WILDCARD_REG_EXP_STR = "(?:|/.*)";
var PATH_ERROR = /* @__PURE__ */ Symbol();
var regExpMetaChars = new Set(".\\+*[^]$()");
function compareKey(a, b) {
  if (a.length === 1) {
    return b.length === 1 ? a < b ? -1 : 1 : -1;
  }
  if (b.length === 1) {
    return 1;
  }
  if (a === ONLY_WILDCARD_REG_EXP_STR || a === TAIL_WILDCARD_REG_EXP_STR) {
    return 1;
  } else if (b === ONLY_WILDCARD_REG_EXP_STR || b === TAIL_WILDCARD_REG_EXP_STR) {
    return -1;
  }
  if (a === LABEL_REG_EXP_STR) {
    return 1;
  } else if (b === LABEL_REG_EXP_STR) {
    return -1;
  }
  return a.length === b.length ? a < b ? -1 : 1 : b.length - a.length;
}
__name(compareKey, "compareKey");
var Node = class _Node {
  static {
    __name(this, "_Node");
  }
  #index;
  #varIndex;
  #children = /* @__PURE__ */ Object.create(null);
  insert(tokens, index, paramMap, context, pathErrorCheckOnly) {
    if (tokens.length === 0) {
      if (this.#index !== void 0) {
        throw PATH_ERROR;
      }
      if (pathErrorCheckOnly) {
        return;
      }
      this.#index = index;
      return;
    }
    const [token, ...restTokens] = tokens;
    const pattern = token === "*" ? restTokens.length === 0 ? ["", "", ONLY_WILDCARD_REG_EXP_STR] : ["", "", LABEL_REG_EXP_STR] : token === "/*" ? ["", "", TAIL_WILDCARD_REG_EXP_STR] : token.match(/^\:([^\{\}]+)(?:\{(.+)\})?$/);
    let node;
    if (pattern) {
      const name = pattern[1];
      let regexpStr = pattern[2] || LABEL_REG_EXP_STR;
      if (name && pattern[2]) {
        if (regexpStr === ".*") {
          throw PATH_ERROR;
        }
        regexpStr = regexpStr.replace(/^\((?!\?:)(?=[^)]+\)$)/, "(?:");
        if (/\((?!\?:)/.test(regexpStr)) {
          throw PATH_ERROR;
        }
      }
      node = this.#children[regexpStr];
      if (!node) {
        if (Object.keys(this.#children).some(
          (k) => k !== ONLY_WILDCARD_REG_EXP_STR && k !== TAIL_WILDCARD_REG_EXP_STR
        )) {
          throw PATH_ERROR;
        }
        if (pathErrorCheckOnly) {
          return;
        }
        node = this.#children[regexpStr] = new _Node();
        if (name !== "") {
          node.#varIndex = context.varIndex++;
        }
      }
      if (!pathErrorCheckOnly && name !== "") {
        paramMap.push([name, node.#varIndex]);
      }
    } else {
      node = this.#children[token];
      if (!node) {
        if (Object.keys(this.#children).some(
          (k) => k.length > 1 && k !== ONLY_WILDCARD_REG_EXP_STR && k !== TAIL_WILDCARD_REG_EXP_STR
        )) {
          throw PATH_ERROR;
        }
        if (pathErrorCheckOnly) {
          return;
        }
        node = this.#children[token] = new _Node();
      }
    }
    node.insert(restTokens, index, paramMap, context, pathErrorCheckOnly);
  }
  buildRegExpStr() {
    const childKeys = Object.keys(this.#children).sort(compareKey);
    const strList = childKeys.map((k) => {
      const c = this.#children[k];
      return (typeof c.#varIndex === "number" ? `(${k})@${c.#varIndex}` : regExpMetaChars.has(k) ? `\\${k}` : k) + c.buildRegExpStr();
    });
    if (typeof this.#index === "number") {
      strList.unshift(`#${this.#index}`);
    }
    if (strList.length === 0) {
      return "";
    }
    if (strList.length === 1) {
      return strList[0];
    }
    return "(?:" + strList.join("|") + ")";
  }
};

// ../node_modules/.bun/hono@4.12.18/node_modules/hono/dist/router/reg-exp-router/trie.js
var Trie = class {
  static {
    __name(this, "Trie");
  }
  #context = { varIndex: 0 };
  #root = new Node();
  insert(path, index, pathErrorCheckOnly) {
    const paramAssoc = [];
    const groups = [];
    for (let i = 0; ; ) {
      let replaced = false;
      path = path.replace(/\{[^}]+\}/g, (m) => {
        const mark = `@\\${i}`;
        groups[i] = [mark, m];
        i++;
        replaced = true;
        return mark;
      });
      if (!replaced) {
        break;
      }
    }
    const tokens = path.match(/(?::[^\/]+)|(?:\/\*$)|./g) || [];
    for (let i = groups.length - 1; i >= 0; i--) {
      const [mark] = groups[i];
      for (let j = tokens.length - 1; j >= 0; j--) {
        if (tokens[j].indexOf(mark) !== -1) {
          tokens[j] = tokens[j].replace(mark, groups[i][1]);
          break;
        }
      }
    }
    this.#root.insert(tokens, index, paramAssoc, this.#context, pathErrorCheckOnly);
    return paramAssoc;
  }
  buildRegExp() {
    let regexp = this.#root.buildRegExpStr();
    if (regexp === "") {
      return [/^$/, [], []];
    }
    let captureIndex = 0;
    const indexReplacementMap = [];
    const paramReplacementMap = [];
    regexp = regexp.replace(/#(\d+)|@(\d+)|\.\*\$/g, (_, handlerIndex, paramIndex) => {
      if (handlerIndex !== void 0) {
        indexReplacementMap[++captureIndex] = Number(handlerIndex);
        return "$()";
      }
      if (paramIndex !== void 0) {
        paramReplacementMap[Number(paramIndex)] = ++captureIndex;
        return "";
      }
      return "";
    });
    return [new RegExp(`^${regexp}`), indexReplacementMap, paramReplacementMap];
  }
};

// ../node_modules/.bun/hono@4.12.18/node_modules/hono/dist/router/reg-exp-router/router.js
var nullMatcher = [/^$/, [], /* @__PURE__ */ Object.create(null)];
var wildcardRegExpCache = /* @__PURE__ */ Object.create(null);
function buildWildcardRegExp(path) {
  return wildcardRegExpCache[path] ??= new RegExp(
    path === "*" ? "" : `^${path.replace(
      /\/\*$|([.\\+*[^\]$()])/g,
      (_, metaChar) => metaChar ? `\\${metaChar}` : "(?:|/.*)"
    )}$`
  );
}
__name(buildWildcardRegExp, "buildWildcardRegExp");
function clearWildcardRegExpCache() {
  wildcardRegExpCache = /* @__PURE__ */ Object.create(null);
}
__name(clearWildcardRegExpCache, "clearWildcardRegExpCache");
function buildMatcherFromPreprocessedRoutes(routes) {
  const trie = new Trie();
  const handlerData = [];
  if (routes.length === 0) {
    return nullMatcher;
  }
  const routesWithStaticPathFlag = routes.map(
    (route) => [!/\*|\/:/.test(route[0]), ...route]
  ).sort(
    ([isStaticA, pathA], [isStaticB, pathB]) => isStaticA ? 1 : isStaticB ? -1 : pathA.length - pathB.length
  );
  const staticMap = /* @__PURE__ */ Object.create(null);
  for (let i = 0, j = -1, len = routesWithStaticPathFlag.length; i < len; i++) {
    const [pathErrorCheckOnly, path, handlers] = routesWithStaticPathFlag[i];
    if (pathErrorCheckOnly) {
      staticMap[path] = [handlers.map(([h]) => [h, /* @__PURE__ */ Object.create(null)]), emptyParam];
    } else {
      j++;
    }
    let paramAssoc;
    try {
      paramAssoc = trie.insert(path, j, pathErrorCheckOnly);
    } catch (e) {
      throw e === PATH_ERROR ? new UnsupportedPathError(path) : e;
    }
    if (pathErrorCheckOnly) {
      continue;
    }
    handlerData[j] = handlers.map(([h, paramCount]) => {
      const paramIndexMap = /* @__PURE__ */ Object.create(null);
      paramCount -= 1;
      for (; paramCount >= 0; paramCount--) {
        const [key, value] = paramAssoc[paramCount];
        paramIndexMap[key] = value;
      }
      return [h, paramIndexMap];
    });
  }
  const [regexp, indexReplacementMap, paramReplacementMap] = trie.buildRegExp();
  for (let i = 0, len = handlerData.length; i < len; i++) {
    for (let j = 0, len2 = handlerData[i].length; j < len2; j++) {
      const map2 = handlerData[i][j]?.[1];
      if (!map2) {
        continue;
      }
      const keys = Object.keys(map2);
      for (let k = 0, len3 = keys.length; k < len3; k++) {
        map2[keys[k]] = paramReplacementMap[map2[keys[k]]];
      }
    }
  }
  const handlerMap = [];
  for (const i in indexReplacementMap) {
    handlerMap[i] = handlerData[indexReplacementMap[i]];
  }
  return [regexp, handlerMap, staticMap];
}
__name(buildMatcherFromPreprocessedRoutes, "buildMatcherFromPreprocessedRoutes");
function findMiddleware(middleware, path) {
  if (!middleware) {
    return void 0;
  }
  for (const k of Object.keys(middleware).sort((a, b) => b.length - a.length)) {
    if (buildWildcardRegExp(k).test(path)) {
      return [...middleware[k]];
    }
  }
  return void 0;
}
__name(findMiddleware, "findMiddleware");
var RegExpRouter = class {
  static {
    __name(this, "RegExpRouter");
  }
  name = "RegExpRouter";
  #middleware;
  #routes;
  constructor() {
    this.#middleware = { [METHOD_NAME_ALL]: /* @__PURE__ */ Object.create(null) };
    this.#routes = { [METHOD_NAME_ALL]: /* @__PURE__ */ Object.create(null) };
  }
  add(method, path, handler) {
    const middleware = this.#middleware;
    const routes = this.#routes;
    if (!middleware || !routes) {
      throw new Error(MESSAGE_MATCHER_IS_ALREADY_BUILT);
    }
    if (!middleware[method]) {
      ;
      [middleware, routes].forEach((handlerMap) => {
        handlerMap[method] = /* @__PURE__ */ Object.create(null);
        Object.keys(handlerMap[METHOD_NAME_ALL]).forEach((p) => {
          handlerMap[method][p] = [...handlerMap[METHOD_NAME_ALL][p]];
        });
      });
    }
    if (path === "/*") {
      path = "*";
    }
    const paramCount = (path.match(/\/:/g) || []).length;
    if (/\*$/.test(path)) {
      const re = buildWildcardRegExp(path);
      if (method === METHOD_NAME_ALL) {
        Object.keys(middleware).forEach((m) => {
          middleware[m][path] ||= findMiddleware(middleware[m], path) || findMiddleware(middleware[METHOD_NAME_ALL], path) || [];
        });
      } else {
        middleware[method][path] ||= findMiddleware(middleware[method], path) || findMiddleware(middleware[METHOD_NAME_ALL], path) || [];
      }
      Object.keys(middleware).forEach((m) => {
        if (method === METHOD_NAME_ALL || method === m) {
          Object.keys(middleware[m]).forEach((p) => {
            re.test(p) && middleware[m][p].push([handler, paramCount]);
          });
        }
      });
      Object.keys(routes).forEach((m) => {
        if (method === METHOD_NAME_ALL || method === m) {
          Object.keys(routes[m]).forEach(
            (p) => re.test(p) && routes[m][p].push([handler, paramCount])
          );
        }
      });
      return;
    }
    const paths = checkOptionalParameter(path) || [path];
    for (let i = 0, len = paths.length; i < len; i++) {
      const path2 = paths[i];
      Object.keys(routes).forEach((m) => {
        if (method === METHOD_NAME_ALL || method === m) {
          routes[m][path2] ||= [
            ...findMiddleware(middleware[m], path2) || findMiddleware(middleware[METHOD_NAME_ALL], path2) || []
          ];
          routes[m][path2].push([handler, paramCount - len + i + 1]);
        }
      });
    }
  }
  match = match;
  buildAllMatchers() {
    const matchers = /* @__PURE__ */ Object.create(null);
    Object.keys(this.#routes).concat(Object.keys(this.#middleware)).forEach((method) => {
      matchers[method] ||= this.#buildMatcher(method);
    });
    this.#middleware = this.#routes = void 0;
    clearWildcardRegExpCache();
    return matchers;
  }
  #buildMatcher(method) {
    const routes = [];
    let hasOwnRoute = method === METHOD_NAME_ALL;
    [this.#middleware, this.#routes].forEach((r) => {
      const ownRoute = r[method] ? Object.keys(r[method]).map((path) => [path, r[method][path]]) : [];
      if (ownRoute.length !== 0) {
        hasOwnRoute ||= true;
        routes.push(...ownRoute);
      } else if (method !== METHOD_NAME_ALL) {
        routes.push(
          ...Object.keys(r[METHOD_NAME_ALL]).map((path) => [path, r[METHOD_NAME_ALL][path]])
        );
      }
    });
    if (!hasOwnRoute) {
      return null;
    } else {
      return buildMatcherFromPreprocessedRoutes(routes);
    }
  }
};

// ../node_modules/.bun/hono@4.12.18/node_modules/hono/dist/router/smart-router/router.js
var SmartRouter = class {
  static {
    __name(this, "SmartRouter");
  }
  name = "SmartRouter";
  #routers = [];
  #routes = [];
  constructor(init) {
    this.#routers = init.routers;
  }
  add(method, path, handler) {
    if (!this.#routes) {
      throw new Error(MESSAGE_MATCHER_IS_ALREADY_BUILT);
    }
    this.#routes.push([method, path, handler]);
  }
  match(method, path) {
    if (!this.#routes) {
      throw new Error("Fatal error");
    }
    const routers = this.#routers;
    const routes = this.#routes;
    const len = routers.length;
    let i = 0;
    let res;
    for (; i < len; i++) {
      const router = routers[i];
      try {
        for (let i2 = 0, len2 = routes.length; i2 < len2; i2++) {
          router.add(...routes[i2]);
        }
        res = router.match(method, path);
      } catch (e) {
        if (e instanceof UnsupportedPathError) {
          continue;
        }
        throw e;
      }
      this.match = router.match.bind(router);
      this.#routers = [router];
      this.#routes = void 0;
      break;
    }
    if (i === len) {
      throw new Error("Fatal error");
    }
    this.name = `SmartRouter + ${this.activeRouter.name}`;
    return res;
  }
  get activeRouter() {
    if (this.#routes || this.#routers.length !== 1) {
      throw new Error("No active router has been determined yet.");
    }
    return this.#routers[0];
  }
};

// ../node_modules/.bun/hono@4.12.18/node_modules/hono/dist/router/trie-router/node.js
var emptyParams = /* @__PURE__ */ Object.create(null);
var hasChildren = /* @__PURE__ */ __name((children) => {
  for (const _ in children) {
    return true;
  }
  return false;
}, "hasChildren");
var Node2 = class _Node2 {
  static {
    __name(this, "_Node");
  }
  #methods;
  #children;
  #patterns;
  #order = 0;
  #params = emptyParams;
  constructor(method, handler, children) {
    this.#children = children || /* @__PURE__ */ Object.create(null);
    this.#methods = [];
    if (method && handler) {
      const m = /* @__PURE__ */ Object.create(null);
      m[method] = { handler, possibleKeys: [], score: 0 };
      this.#methods = [m];
    }
    this.#patterns = [];
  }
  insert(method, path, handler) {
    this.#order = ++this.#order;
    let curNode = this;
    const parts = splitRoutingPath(path);
    const possibleKeys = [];
    for (let i = 0, len = parts.length; i < len; i++) {
      const p = parts[i];
      const nextP = parts[i + 1];
      const pattern = getPattern(p, nextP);
      const key = Array.isArray(pattern) ? pattern[0] : p;
      if (key in curNode.#children) {
        curNode = curNode.#children[key];
        if (pattern) {
          possibleKeys.push(pattern[1]);
        }
        continue;
      }
      curNode.#children[key] = new _Node2();
      if (pattern) {
        curNode.#patterns.push(pattern);
        possibleKeys.push(pattern[1]);
      }
      curNode = curNode.#children[key];
    }
    curNode.#methods.push({
      [method]: {
        handler,
        possibleKeys: possibleKeys.filter((v, i, a) => a.indexOf(v) === i),
        score: this.#order
      }
    });
    return curNode;
  }
  #pushHandlerSets(handlerSets, node, method, nodeParams, params) {
    for (let i = 0, len = node.#methods.length; i < len; i++) {
      const m = node.#methods[i];
      const handlerSet = m[method] || m[METHOD_NAME_ALL];
      const processedSet = {};
      if (handlerSet !== void 0) {
        handlerSet.params = /* @__PURE__ */ Object.create(null);
        handlerSets.push(handlerSet);
        if (nodeParams !== emptyParams || params && params !== emptyParams) {
          for (let i2 = 0, len2 = handlerSet.possibleKeys.length; i2 < len2; i2++) {
            const key = handlerSet.possibleKeys[i2];
            const processed = processedSet[handlerSet.score];
            handlerSet.params[key] = params?.[key] && !processed ? params[key] : nodeParams[key] ?? params?.[key];
            processedSet[handlerSet.score] = true;
          }
        }
      }
    }
  }
  search(method, path) {
    const handlerSets = [];
    this.#params = emptyParams;
    const curNode = this;
    let curNodes = [curNode];
    const parts = splitPath(path);
    const curNodesQueue = [];
    const len = parts.length;
    let partOffsets = null;
    for (let i = 0; i < len; i++) {
      const part = parts[i];
      const isLast = i === len - 1;
      const tempNodes = [];
      for (let j = 0, len2 = curNodes.length; j < len2; j++) {
        const node = curNodes[j];
        const nextNode = node.#children[part];
        if (nextNode) {
          nextNode.#params = node.#params;
          if (isLast) {
            if (nextNode.#children["*"]) {
              this.#pushHandlerSets(handlerSets, nextNode.#children["*"], method, node.#params);
            }
            this.#pushHandlerSets(handlerSets, nextNode, method, node.#params);
          } else {
            tempNodes.push(nextNode);
          }
        }
        for (let k = 0, len3 = node.#patterns.length; k < len3; k++) {
          const pattern = node.#patterns[k];
          const params = node.#params === emptyParams ? {} : { ...node.#params };
          if (pattern === "*") {
            const astNode = node.#children["*"];
            if (astNode) {
              this.#pushHandlerSets(handlerSets, astNode, method, node.#params);
              astNode.#params = params;
              tempNodes.push(astNode);
            }
            continue;
          }
          const [key, name, matcher] = pattern;
          if (!part && !(matcher instanceof RegExp)) {
            continue;
          }
          const child = node.#children[key];
          if (matcher instanceof RegExp) {
            if (partOffsets === null) {
              partOffsets = new Array(len);
              let offset = path[0] === "/" ? 1 : 0;
              for (let p = 0; p < len; p++) {
                partOffsets[p] = offset;
                offset += parts[p].length + 1;
              }
            }
            const restPathString = path.substring(partOffsets[i]);
            const m = matcher.exec(restPathString);
            if (m) {
              params[name] = m[0];
              this.#pushHandlerSets(handlerSets, child, method, node.#params, params);
              if (hasChildren(child.#children)) {
                child.#params = params;
                const componentCount = m[0].match(/\//)?.length ?? 0;
                const targetCurNodes = curNodesQueue[componentCount] ||= [];
                targetCurNodes.push(child);
              }
              continue;
            }
          }
          if (matcher === true || matcher.test(part)) {
            params[name] = part;
            if (isLast) {
              this.#pushHandlerSets(handlerSets, child, method, params, node.#params);
              if (child.#children["*"]) {
                this.#pushHandlerSets(
                  handlerSets,
                  child.#children["*"],
                  method,
                  params,
                  node.#params
                );
              }
            } else {
              child.#params = params;
              tempNodes.push(child);
            }
          }
        }
      }
      const shifted = curNodesQueue.shift();
      curNodes = shifted ? tempNodes.concat(shifted) : tempNodes;
    }
    if (handlerSets.length > 1) {
      handlerSets.sort((a, b) => {
        return a.score - b.score;
      });
    }
    return [handlerSets.map(({ handler, params }) => [handler, params])];
  }
};

// ../node_modules/.bun/hono@4.12.18/node_modules/hono/dist/router/trie-router/router.js
var TrieRouter = class {
  static {
    __name(this, "TrieRouter");
  }
  name = "TrieRouter";
  #node;
  constructor() {
    this.#node = new Node2();
  }
  add(method, path, handler) {
    const results = checkOptionalParameter(path);
    if (results) {
      for (let i = 0, len = results.length; i < len; i++) {
        this.#node.insert(method, results[i], handler);
      }
      return;
    }
    this.#node.insert(method, path, handler);
  }
  match(method, path) {
    return this.#node.search(method, path);
  }
};

// ../node_modules/.bun/hono@4.12.18/node_modules/hono/dist/hono.js
var Hono2 = class extends Hono {
  static {
    __name(this, "Hono");
  }
  /**
   * Creates an instance of the Hono class.
   *
   * @param options - Optional configuration options for the Hono instance.
   */
  constructor(options = {}) {
    super(options);
    this.router = options.router ?? new SmartRouter({
      routers: [new RegExpRouter(), new TrieRouter()]
    });
  }
};

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/nodes/identity.js
var ALIAS = /* @__PURE__ */ Symbol.for("yaml.alias");
var DOC = /* @__PURE__ */ Symbol.for("yaml.document");
var MAP = /* @__PURE__ */ Symbol.for("yaml.map");
var PAIR = /* @__PURE__ */ Symbol.for("yaml.pair");
var SCALAR = /* @__PURE__ */ Symbol.for("yaml.scalar");
var SEQ = /* @__PURE__ */ Symbol.for("yaml.seq");
var NODE_TYPE = /* @__PURE__ */ Symbol.for("yaml.node.type");
var isAlias = /* @__PURE__ */ __name((node) => !!node && typeof node === "object" && node[NODE_TYPE] === ALIAS, "isAlias");
var isDocument = /* @__PURE__ */ __name((node) => !!node && typeof node === "object" && node[NODE_TYPE] === DOC, "isDocument");
var isMap = /* @__PURE__ */ __name((node) => !!node && typeof node === "object" && node[NODE_TYPE] === MAP, "isMap");
var isPair = /* @__PURE__ */ __name((node) => !!node && typeof node === "object" && node[NODE_TYPE] === PAIR, "isPair");
var isScalar = /* @__PURE__ */ __name((node) => !!node && typeof node === "object" && node[NODE_TYPE] === SCALAR, "isScalar");
var isSeq = /* @__PURE__ */ __name((node) => !!node && typeof node === "object" && node[NODE_TYPE] === SEQ, "isSeq");
function isCollection(node) {
  if (node && typeof node === "object")
    switch (node[NODE_TYPE]) {
      case MAP:
      case SEQ:
        return true;
    }
  return false;
}
__name(isCollection, "isCollection");
function isNode(node) {
  if (node && typeof node === "object")
    switch (node[NODE_TYPE]) {
      case ALIAS:
      case MAP:
      case SCALAR:
      case SEQ:
        return true;
    }
  return false;
}
__name(isNode, "isNode");
var hasAnchor = /* @__PURE__ */ __name((node) => (isScalar(node) || isCollection(node)) && !!node.anchor, "hasAnchor");

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/visit.js
var BREAK = /* @__PURE__ */ Symbol("break visit");
var SKIP = /* @__PURE__ */ Symbol("skip children");
var REMOVE = /* @__PURE__ */ Symbol("remove node");
function visit(node, visitor) {
  const visitor_ = initVisitor(visitor);
  if (isDocument(node)) {
    const cd = visit_(null, node.contents, visitor_, Object.freeze([node]));
    if (cd === REMOVE)
      node.contents = null;
  } else
    visit_(null, node, visitor_, Object.freeze([]));
}
__name(visit, "visit");
visit.BREAK = BREAK;
visit.SKIP = SKIP;
visit.REMOVE = REMOVE;
function visit_(key, node, visitor, path) {
  const ctrl = callVisitor(key, node, visitor, path);
  if (isNode(ctrl) || isPair(ctrl)) {
    replaceNode(key, path, ctrl);
    return visit_(key, ctrl, visitor, path);
  }
  if (typeof ctrl !== "symbol") {
    if (isCollection(node)) {
      path = Object.freeze(path.concat(node));
      for (let i = 0; i < node.items.length; ++i) {
        const ci = visit_(i, node.items[i], visitor, path);
        if (typeof ci === "number")
          i = ci - 1;
        else if (ci === BREAK)
          return BREAK;
        else if (ci === REMOVE) {
          node.items.splice(i, 1);
          i -= 1;
        }
      }
    } else if (isPair(node)) {
      path = Object.freeze(path.concat(node));
      const ck = visit_("key", node.key, visitor, path);
      if (ck === BREAK)
        return BREAK;
      else if (ck === REMOVE)
        node.key = null;
      const cv = visit_("value", node.value, visitor, path);
      if (cv === BREAK)
        return BREAK;
      else if (cv === REMOVE)
        node.value = null;
    }
  }
  return ctrl;
}
__name(visit_, "visit_");
async function visitAsync(node, visitor) {
  const visitor_ = initVisitor(visitor);
  if (isDocument(node)) {
    const cd = await visitAsync_(null, node.contents, visitor_, Object.freeze([node]));
    if (cd === REMOVE)
      node.contents = null;
  } else
    await visitAsync_(null, node, visitor_, Object.freeze([]));
}
__name(visitAsync, "visitAsync");
visitAsync.BREAK = BREAK;
visitAsync.SKIP = SKIP;
visitAsync.REMOVE = REMOVE;
async function visitAsync_(key, node, visitor, path) {
  const ctrl = await callVisitor(key, node, visitor, path);
  if (isNode(ctrl) || isPair(ctrl)) {
    replaceNode(key, path, ctrl);
    return visitAsync_(key, ctrl, visitor, path);
  }
  if (typeof ctrl !== "symbol") {
    if (isCollection(node)) {
      path = Object.freeze(path.concat(node));
      for (let i = 0; i < node.items.length; ++i) {
        const ci = await visitAsync_(i, node.items[i], visitor, path);
        if (typeof ci === "number")
          i = ci - 1;
        else if (ci === BREAK)
          return BREAK;
        else if (ci === REMOVE) {
          node.items.splice(i, 1);
          i -= 1;
        }
      }
    } else if (isPair(node)) {
      path = Object.freeze(path.concat(node));
      const ck = await visitAsync_("key", node.key, visitor, path);
      if (ck === BREAK)
        return BREAK;
      else if (ck === REMOVE)
        node.key = null;
      const cv = await visitAsync_("value", node.value, visitor, path);
      if (cv === BREAK)
        return BREAK;
      else if (cv === REMOVE)
        node.value = null;
    }
  }
  return ctrl;
}
__name(visitAsync_, "visitAsync_");
function initVisitor(visitor) {
  if (typeof visitor === "object" && (visitor.Collection || visitor.Node || visitor.Value)) {
    return Object.assign({
      Alias: visitor.Node,
      Map: visitor.Node,
      Scalar: visitor.Node,
      Seq: visitor.Node
    }, visitor.Value && {
      Map: visitor.Value,
      Scalar: visitor.Value,
      Seq: visitor.Value
    }, visitor.Collection && {
      Map: visitor.Collection,
      Seq: visitor.Collection
    }, visitor);
  }
  return visitor;
}
__name(initVisitor, "initVisitor");
function callVisitor(key, node, visitor, path) {
  if (typeof visitor === "function")
    return visitor(key, node, path);
  if (isMap(node))
    return visitor.Map?.(key, node, path);
  if (isSeq(node))
    return visitor.Seq?.(key, node, path);
  if (isPair(node))
    return visitor.Pair?.(key, node, path);
  if (isScalar(node))
    return visitor.Scalar?.(key, node, path);
  if (isAlias(node))
    return visitor.Alias?.(key, node, path);
  return void 0;
}
__name(callVisitor, "callVisitor");
function replaceNode(key, path, node) {
  const parent = path[path.length - 1];
  if (isCollection(parent)) {
    parent.items[key] = node;
  } else if (isPair(parent)) {
    if (key === "key")
      parent.key = node;
    else
      parent.value = node;
  } else if (isDocument(parent)) {
    parent.contents = node;
  } else {
    const pt = isAlias(parent) ? "alias" : "scalar";
    throw new Error(`Cannot replace node with ${pt} parent`);
  }
}
__name(replaceNode, "replaceNode");

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/doc/directives.js
var escapeChars = {
  "!": "%21",
  ",": "%2C",
  "[": "%5B",
  "]": "%5D",
  "{": "%7B",
  "}": "%7D"
};
var escapeTagName = /* @__PURE__ */ __name((tn) => tn.replace(/[!,[\]{}]/g, (ch) => escapeChars[ch]), "escapeTagName");
var Directives = class _Directives {
  static {
    __name(this, "Directives");
  }
  constructor(yaml, tags) {
    this.docStart = null;
    this.docEnd = false;
    this.yaml = Object.assign({}, _Directives.defaultYaml, yaml);
    this.tags = Object.assign({}, _Directives.defaultTags, tags);
  }
  clone() {
    const copy = new _Directives(this.yaml, this.tags);
    copy.docStart = this.docStart;
    return copy;
  }
  /**
   * During parsing, get a Directives instance for the current document and
   * update the stream state according to the current version's spec.
   */
  atDocument() {
    const res = new _Directives(this.yaml, this.tags);
    switch (this.yaml.version) {
      case "1.1":
        this.atNextDocument = true;
        break;
      case "1.2":
        this.atNextDocument = false;
        this.yaml = {
          explicit: _Directives.defaultYaml.explicit,
          version: "1.2"
        };
        this.tags = Object.assign({}, _Directives.defaultTags);
        break;
    }
    return res;
  }
  /**
   * @param onError - May be called even if the action was successful
   * @returns `true` on success
   */
  add(line, onError) {
    if (this.atNextDocument) {
      this.yaml = { explicit: _Directives.defaultYaml.explicit, version: "1.1" };
      this.tags = Object.assign({}, _Directives.defaultTags);
      this.atNextDocument = false;
    }
    const parts = line.trim().split(/[ \t]+/);
    const name = parts.shift();
    switch (name) {
      case "%TAG": {
        if (parts.length !== 2) {
          onError(0, "%TAG directive should contain exactly two parts");
          if (parts.length < 2)
            return false;
        }
        const [handle, prefix] = parts;
        this.tags[handle] = prefix;
        return true;
      }
      case "%YAML": {
        this.yaml.explicit = true;
        if (parts.length !== 1) {
          onError(0, "%YAML directive should contain exactly one part");
          return false;
        }
        const [version] = parts;
        if (version === "1.1" || version === "1.2") {
          this.yaml.version = version;
          return true;
        } else {
          const isValid = /^\d+\.\d+$/.test(version);
          onError(6, `Unsupported YAML version ${version}`, isValid);
          return false;
        }
      }
      default:
        onError(0, `Unknown directive ${name}`, true);
        return false;
    }
  }
  /**
   * Resolves a tag, matching handles to those defined in %TAG directives.
   *
   * @returns Resolved tag, which may also be the non-specific tag `'!'` or a
   *   `'!local'` tag, or `null` if unresolvable.
   */
  tagName(source, onError) {
    if (source === "!")
      return "!";
    if (source[0] !== "!") {
      onError(`Not a valid tag: ${source}`);
      return null;
    }
    if (source[1] === "<") {
      const verbatim = source.slice(2, -1);
      if (verbatim === "!" || verbatim === "!!") {
        onError(`Verbatim tags aren't resolved, so ${source} is invalid.`);
        return null;
      }
      if (source[source.length - 1] !== ">")
        onError("Verbatim tags must end with a >");
      return verbatim;
    }
    const [, handle, suffix] = source.match(/^(.*!)([^!]*)$/s);
    if (!suffix)
      onError(`The ${source} tag has no suffix`);
    const prefix = this.tags[handle];
    if (prefix) {
      try {
        return prefix + decodeURIComponent(suffix);
      } catch (error) {
        onError(String(error));
        return null;
      }
    }
    if (handle === "!")
      return source;
    onError(`Could not resolve tag: ${source}`);
    return null;
  }
  /**
   * Given a fully resolved tag, returns its printable string form,
   * taking into account current tag prefixes and defaults.
   */
  tagString(tag) {
    for (const [handle, prefix] of Object.entries(this.tags)) {
      if (tag.startsWith(prefix))
        return handle + escapeTagName(tag.substring(prefix.length));
    }
    return tag[0] === "!" ? tag : `!<${tag}>`;
  }
  toString(doc) {
    const lines = this.yaml.explicit ? [`%YAML ${this.yaml.version || "1.2"}`] : [];
    const tagEntries = Object.entries(this.tags);
    let tagNames;
    if (doc && tagEntries.length > 0 && isNode(doc.contents)) {
      const tags = {};
      visit(doc.contents, (_key, node) => {
        if (isNode(node) && node.tag)
          tags[node.tag] = true;
      });
      tagNames = Object.keys(tags);
    } else
      tagNames = [];
    for (const [handle, prefix] of tagEntries) {
      if (handle === "!!" && prefix === "tag:yaml.org,2002:")
        continue;
      if (!doc || tagNames.some((tn) => tn.startsWith(prefix)))
        lines.push(`%TAG ${handle} ${prefix}`);
    }
    return lines.join("\n");
  }
};
Directives.defaultYaml = { explicit: false, version: "1.2" };
Directives.defaultTags = { "!!": "tag:yaml.org,2002:" };

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/doc/anchors.js
function anchorIsValid(anchor) {
  if (/[\x00-\x19\s,[\]{}]/.test(anchor)) {
    const sa = JSON.stringify(anchor);
    const msg = `Anchor must not contain whitespace or control characters: ${sa}`;
    throw new Error(msg);
  }
  return true;
}
__name(anchorIsValid, "anchorIsValid");
function anchorNames(root) {
  const anchors = /* @__PURE__ */ new Set();
  visit(root, {
    Value(_key, node) {
      if (node.anchor)
        anchors.add(node.anchor);
    }
  });
  return anchors;
}
__name(anchorNames, "anchorNames");
function findNewAnchor(prefix, exclude) {
  for (let i = 1; true; ++i) {
    const name = `${prefix}${i}`;
    if (!exclude.has(name))
      return name;
  }
}
__name(findNewAnchor, "findNewAnchor");
function createNodeAnchors(doc, prefix) {
  const aliasObjects = [];
  const sourceObjects = /* @__PURE__ */ new Map();
  let prevAnchors = null;
  return {
    onAnchor: /* @__PURE__ */ __name((source) => {
      aliasObjects.push(source);
      if (!prevAnchors)
        prevAnchors = anchorNames(doc);
      const anchor = findNewAnchor(prefix, prevAnchors);
      prevAnchors.add(anchor);
      return anchor;
    }, "onAnchor"),
    /**
     * With circular references, the source node is only resolved after all
     * of its child nodes are. This is why anchors are set only after all of
     * the nodes have been created.
     */
    setAnchors: /* @__PURE__ */ __name(() => {
      for (const source of aliasObjects) {
        const ref = sourceObjects.get(source);
        if (typeof ref === "object" && ref.anchor && (isScalar(ref.node) || isCollection(ref.node))) {
          ref.node.anchor = ref.anchor;
        } else {
          const error = new Error("Failed to resolve repeated object (this should not happen)");
          error.source = source;
          throw error;
        }
      }
    }, "setAnchors"),
    sourceObjects
  };
}
__name(createNodeAnchors, "createNodeAnchors");

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/doc/applyReviver.js
function applyReviver(reviver, obj, key, val) {
  if (val && typeof val === "object") {
    if (Array.isArray(val)) {
      for (let i = 0, len = val.length; i < len; ++i) {
        const v0 = val[i];
        const v1 = applyReviver(reviver, val, String(i), v0);
        if (v1 === void 0)
          delete val[i];
        else if (v1 !== v0)
          val[i] = v1;
      }
    } else if (val instanceof Map) {
      for (const k of Array.from(val.keys())) {
        const v0 = val.get(k);
        const v1 = applyReviver(reviver, val, k, v0);
        if (v1 === void 0)
          val.delete(k);
        else if (v1 !== v0)
          val.set(k, v1);
      }
    } else if (val instanceof Set) {
      for (const v0 of Array.from(val)) {
        const v1 = applyReviver(reviver, val, v0, v0);
        if (v1 === void 0)
          val.delete(v0);
        else if (v1 !== v0) {
          val.delete(v0);
          val.add(v1);
        }
      }
    } else {
      for (const [k, v0] of Object.entries(val)) {
        const v1 = applyReviver(reviver, val, k, v0);
        if (v1 === void 0)
          delete val[k];
        else if (v1 !== v0)
          val[k] = v1;
      }
    }
  }
  return reviver.call(obj, key, val);
}
__name(applyReviver, "applyReviver");

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/nodes/toJS.js
function toJS(value, arg, ctx) {
  if (Array.isArray(value))
    return value.map((v, i) => toJS(v, String(i), ctx));
  if (value && typeof value.toJSON === "function") {
    if (!ctx || !hasAnchor(value))
      return value.toJSON(arg, ctx);
    const data = { aliasCount: 0, count: 1, res: void 0 };
    ctx.anchors.set(value, data);
    ctx.onCreate = (res2) => {
      data.res = res2;
      delete ctx.onCreate;
    };
    const res = value.toJSON(arg, ctx);
    if (ctx.onCreate)
      ctx.onCreate(res);
    return res;
  }
  if (typeof value === "bigint" && !ctx?.keep)
    return Number(value);
  return value;
}
__name(toJS, "toJS");

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/nodes/Node.js
var NodeBase = class {
  static {
    __name(this, "NodeBase");
  }
  constructor(type) {
    Object.defineProperty(this, NODE_TYPE, { value: type });
  }
  /** Create a copy of this node.  */
  clone() {
    const copy = Object.create(Object.getPrototypeOf(this), Object.getOwnPropertyDescriptors(this));
    if (this.range)
      copy.range = this.range.slice();
    return copy;
  }
  /** A plain JavaScript representation of this node. */
  toJS(doc, { mapAsMap, maxAliasCount, onAnchor, reviver } = {}) {
    if (!isDocument(doc))
      throw new TypeError("A document argument is required");
    const ctx = {
      anchors: /* @__PURE__ */ new Map(),
      doc,
      keep: true,
      mapAsMap: mapAsMap === true,
      mapKeyWarned: false,
      maxAliasCount: typeof maxAliasCount === "number" ? maxAliasCount : 100
    };
    const res = toJS(this, "", ctx);
    if (typeof onAnchor === "function")
      for (const { count, res: res2 } of ctx.anchors.values())
        onAnchor(res2, count);
    return typeof reviver === "function" ? applyReviver(reviver, { "": res }, "", res) : res;
  }
};

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/nodes/Alias.js
var Alias = class extends NodeBase {
  static {
    __name(this, "Alias");
  }
  constructor(source) {
    super(ALIAS);
    this.source = source;
    Object.defineProperty(this, "tag", {
      set() {
        throw new Error("Alias nodes cannot have tags");
      }
    });
  }
  /**
   * Resolve the value of this alias within `doc`, finding the last
   * instance of the `source` anchor before this node.
   */
  resolve(doc) {
    let found = void 0;
    visit(doc, {
      Node: /* @__PURE__ */ __name((_key, node) => {
        if (node === this)
          return visit.BREAK;
        if (node.anchor === this.source)
          found = node;
      }, "Node")
    });
    return found;
  }
  toJSON(_arg, ctx) {
    if (!ctx)
      return { source: this.source };
    const { anchors, doc, maxAliasCount } = ctx;
    const source = this.resolve(doc);
    if (!source) {
      const msg = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
      throw new ReferenceError(msg);
    }
    let data = anchors.get(source);
    if (!data) {
      toJS(source, null, ctx);
      data = anchors.get(source);
    }
    if (!data || data.res === void 0) {
      const msg = "This should not happen: Alias anchor was not resolved?";
      throw new ReferenceError(msg);
    }
    if (maxAliasCount >= 0) {
      data.count += 1;
      if (data.aliasCount === 0)
        data.aliasCount = getAliasCount(doc, source, anchors);
      if (data.count * data.aliasCount > maxAliasCount) {
        const msg = "Excessive alias count indicates a resource exhaustion attack";
        throw new ReferenceError(msg);
      }
    }
    return data.res;
  }
  toString(ctx, _onComment, _onChompKeep) {
    const src = `*${this.source}`;
    if (ctx) {
      anchorIsValid(this.source);
      if (ctx.options.verifyAliasOrder && !ctx.anchors.has(this.source)) {
        const msg = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
        throw new Error(msg);
      }
      if (ctx.implicitKey)
        return `${src} `;
    }
    return src;
  }
};
function getAliasCount(doc, node, anchors) {
  if (isAlias(node)) {
    const source = node.resolve(doc);
    const anchor = anchors && source && anchors.get(source);
    return anchor ? anchor.count * anchor.aliasCount : 0;
  } else if (isCollection(node)) {
    let count = 0;
    for (const item of node.items) {
      const c = getAliasCount(doc, item, anchors);
      if (c > count)
        count = c;
    }
    return count;
  } else if (isPair(node)) {
    const kc = getAliasCount(doc, node.key, anchors);
    const vc = getAliasCount(doc, node.value, anchors);
    return Math.max(kc, vc);
  }
  return 1;
}
__name(getAliasCount, "getAliasCount");

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/nodes/Scalar.js
var isScalarValue = /* @__PURE__ */ __name((value) => !value || typeof value !== "function" && typeof value !== "object", "isScalarValue");
var Scalar = class extends NodeBase {
  static {
    __name(this, "Scalar");
  }
  constructor(value) {
    super(SCALAR);
    this.value = value;
  }
  toJSON(arg, ctx) {
    return ctx?.keep ? this.value : toJS(this.value, arg, ctx);
  }
  toString() {
    return String(this.value);
  }
};
Scalar.BLOCK_FOLDED = "BLOCK_FOLDED";
Scalar.BLOCK_LITERAL = "BLOCK_LITERAL";
Scalar.PLAIN = "PLAIN";
Scalar.QUOTE_DOUBLE = "QUOTE_DOUBLE";
Scalar.QUOTE_SINGLE = "QUOTE_SINGLE";

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/doc/createNode.js
var defaultTagPrefix = "tag:yaml.org,2002:";
function findTagObject(value, tagName, tags) {
  if (tagName) {
    const match2 = tags.filter((t) => t.tag === tagName);
    const tagObj = match2.find((t) => !t.format) ?? match2[0];
    if (!tagObj)
      throw new Error(`Tag ${tagName} not found`);
    return tagObj;
  }
  return tags.find((t) => t.identify?.(value) && !t.format);
}
__name(findTagObject, "findTagObject");
function createNode(value, tagName, ctx) {
  if (isDocument(value))
    value = value.contents;
  if (isNode(value))
    return value;
  if (isPair(value)) {
    const map2 = ctx.schema[MAP].createNode?.(ctx.schema, null, ctx);
    map2.items.push(value);
    return map2;
  }
  if (value instanceof String || value instanceof Number || value instanceof Boolean || typeof BigInt !== "undefined" && value instanceof BigInt) {
    value = value.valueOf();
  }
  const { aliasDuplicateObjects, onAnchor, onTagObj, schema: schema4, sourceObjects } = ctx;
  let ref = void 0;
  if (aliasDuplicateObjects && value && typeof value === "object") {
    ref = sourceObjects.get(value);
    if (ref) {
      if (!ref.anchor)
        ref.anchor = onAnchor(value);
      return new Alias(ref.anchor);
    } else {
      ref = { anchor: null, node: null };
      sourceObjects.set(value, ref);
    }
  }
  if (tagName?.startsWith("!!"))
    tagName = defaultTagPrefix + tagName.slice(2);
  let tagObj = findTagObject(value, tagName, schema4.tags);
  if (!tagObj) {
    if (value && typeof value.toJSON === "function") {
      value = value.toJSON();
    }
    if (!value || typeof value !== "object") {
      const node2 = new Scalar(value);
      if (ref)
        ref.node = node2;
      return node2;
    }
    tagObj = value instanceof Map ? schema4[MAP] : Symbol.iterator in Object(value) ? schema4[SEQ] : schema4[MAP];
  }
  if (onTagObj) {
    onTagObj(tagObj);
    delete ctx.onTagObj;
  }
  const node = tagObj?.createNode ? tagObj.createNode(ctx.schema, value, ctx) : typeof tagObj?.nodeClass?.from === "function" ? tagObj.nodeClass.from(ctx.schema, value, ctx) : new Scalar(value);
  if (tagName)
    node.tag = tagName;
  else if (!tagObj.default)
    node.tag = tagObj.tag;
  if (ref)
    ref.node = node;
  return node;
}
__name(createNode, "createNode");

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/nodes/Collection.js
function collectionFromPath(schema4, path, value) {
  let v = value;
  for (let i = path.length - 1; i >= 0; --i) {
    const k = path[i];
    if (typeof k === "number" && Number.isInteger(k) && k >= 0) {
      const a = [];
      a[k] = v;
      v = a;
    } else {
      v = /* @__PURE__ */ new Map([[k, v]]);
    }
  }
  return createNode(v, void 0, {
    aliasDuplicateObjects: false,
    keepUndefined: false,
    onAnchor: /* @__PURE__ */ __name(() => {
      throw new Error("This should not happen, please report a bug.");
    }, "onAnchor"),
    schema: schema4,
    sourceObjects: /* @__PURE__ */ new Map()
  });
}
__name(collectionFromPath, "collectionFromPath");
var isEmptyPath = /* @__PURE__ */ __name((path) => path == null || typeof path === "object" && !!path[Symbol.iterator]().next().done, "isEmptyPath");
var Collection = class extends NodeBase {
  static {
    __name(this, "Collection");
  }
  constructor(type, schema4) {
    super(type);
    Object.defineProperty(this, "schema", {
      value: schema4,
      configurable: true,
      enumerable: false,
      writable: true
    });
  }
  /**
   * Create a copy of this collection.
   *
   * @param schema - If defined, overwrites the original's schema
   */
  clone(schema4) {
    const copy = Object.create(Object.getPrototypeOf(this), Object.getOwnPropertyDescriptors(this));
    if (schema4)
      copy.schema = schema4;
    copy.items = copy.items.map((it) => isNode(it) || isPair(it) ? it.clone(schema4) : it);
    if (this.range)
      copy.range = this.range.slice();
    return copy;
  }
  /**
   * Adds a value to the collection. For `!!map` and `!!omap` the value must
   * be a Pair instance or a `{ key, value }` object, which may not have a key
   * that already exists in the map.
   */
  addIn(path, value) {
    if (isEmptyPath(path))
      this.add(value);
    else {
      const [key, ...rest] = path;
      const node = this.get(key, true);
      if (isCollection(node))
        node.addIn(rest, value);
      else if (node === void 0 && this.schema)
        this.set(key, collectionFromPath(this.schema, rest, value));
      else
        throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
    }
  }
  /**
   * Removes a value from the collection.
   * @returns `true` if the item was found and removed.
   */
  deleteIn(path) {
    const [key, ...rest] = path;
    if (rest.length === 0)
      return this.delete(key);
    const node = this.get(key, true);
    if (isCollection(node))
      return node.deleteIn(rest);
    else
      throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
  }
  /**
   * Returns item at `key`, or `undefined` if not found. By default unwraps
   * scalar values from their surrounding node; to disable set `keepScalar` to
   * `true` (collections are always returned intact).
   */
  getIn(path, keepScalar) {
    const [key, ...rest] = path;
    const node = this.get(key, true);
    if (rest.length === 0)
      return !keepScalar && isScalar(node) ? node.value : node;
    else
      return isCollection(node) ? node.getIn(rest, keepScalar) : void 0;
  }
  hasAllNullValues(allowScalar) {
    return this.items.every((node) => {
      if (!isPair(node))
        return false;
      const n = node.value;
      return n == null || allowScalar && isScalar(n) && n.value == null && !n.commentBefore && !n.comment && !n.tag;
    });
  }
  /**
   * Checks if the collection includes a value with the key `key`.
   */
  hasIn(path) {
    const [key, ...rest] = path;
    if (rest.length === 0)
      return this.has(key);
    const node = this.get(key, true);
    return isCollection(node) ? node.hasIn(rest) : false;
  }
  /**
   * Sets a value in this collection. For `!!set`, `value` needs to be a
   * boolean to add/remove the item from the set.
   */
  setIn(path, value) {
    const [key, ...rest] = path;
    if (rest.length === 0) {
      this.set(key, value);
    } else {
      const node = this.get(key, true);
      if (isCollection(node))
        node.setIn(rest, value);
      else if (node === void 0 && this.schema)
        this.set(key, collectionFromPath(this.schema, rest, value));
      else
        throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
    }
  }
};

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/stringify/stringifyComment.js
var stringifyComment = /* @__PURE__ */ __name((str) => str.replace(/^(?!$)(?: $)?/gm, "#"), "stringifyComment");
function indentComment(comment, indent) {
  if (/^\n+$/.test(comment))
    return comment.substring(1);
  return indent ? comment.replace(/^(?! *$)/gm, indent) : comment;
}
__name(indentComment, "indentComment");
var lineComment = /* @__PURE__ */ __name((str, indent, comment) => str.endsWith("\n") ? indentComment(comment, indent) : comment.includes("\n") ? "\n" + indentComment(comment, indent) : (str.endsWith(" ") ? "" : " ") + comment, "lineComment");

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/stringify/foldFlowLines.js
var FOLD_FLOW = "flow";
var FOLD_BLOCK = "block";
var FOLD_QUOTED = "quoted";
function foldFlowLines(text, indent, mode = "flow", { indentAtStart, lineWidth = 80, minContentWidth = 20, onFold, onOverflow } = {}) {
  if (!lineWidth || lineWidth < 0)
    return text;
  if (lineWidth < minContentWidth)
    minContentWidth = 0;
  const endStep = Math.max(1 + minContentWidth, 1 + lineWidth - indent.length);
  if (text.length <= endStep)
    return text;
  const folds = [];
  const escapedFolds = {};
  let end = lineWidth - indent.length;
  if (typeof indentAtStart === "number") {
    if (indentAtStart > lineWidth - Math.max(2, minContentWidth))
      folds.push(0);
    else
      end = lineWidth - indentAtStart;
  }
  let split = void 0;
  let prev = void 0;
  let overflow = false;
  let i = -1;
  let escStart = -1;
  let escEnd = -1;
  if (mode === FOLD_BLOCK) {
    i = consumeMoreIndentedLines(text, i, indent.length);
    if (i !== -1)
      end = i + endStep;
  }
  for (let ch; ch = text[i += 1]; ) {
    if (mode === FOLD_QUOTED && ch === "\\") {
      escStart = i;
      switch (text[i + 1]) {
        case "x":
          i += 3;
          break;
        case "u":
          i += 5;
          break;
        case "U":
          i += 9;
          break;
        default:
          i += 1;
      }
      escEnd = i;
    }
    if (ch === "\n") {
      if (mode === FOLD_BLOCK)
        i = consumeMoreIndentedLines(text, i, indent.length);
      end = i + indent.length + endStep;
      split = void 0;
    } else {
      if (ch === " " && prev && prev !== " " && prev !== "\n" && prev !== "	") {
        const next = text[i + 1];
        if (next && next !== " " && next !== "\n" && next !== "	")
          split = i;
      }
      if (i >= end) {
        if (split) {
          folds.push(split);
          end = split + endStep;
          split = void 0;
        } else if (mode === FOLD_QUOTED) {
          while (prev === " " || prev === "	") {
            prev = ch;
            ch = text[i += 1];
            overflow = true;
          }
          const j = i > escEnd + 1 ? i - 2 : escStart - 1;
          if (escapedFolds[j])
            return text;
          folds.push(j);
          escapedFolds[j] = true;
          end = j + endStep;
          split = void 0;
        } else {
          overflow = true;
        }
      }
    }
    prev = ch;
  }
  if (overflow && onOverflow)
    onOverflow();
  if (folds.length === 0)
    return text;
  if (onFold)
    onFold();
  let res = text.slice(0, folds[0]);
  for (let i2 = 0; i2 < folds.length; ++i2) {
    const fold = folds[i2];
    const end2 = folds[i2 + 1] || text.length;
    if (fold === 0)
      res = `
${indent}${text.slice(0, end2)}`;
    else {
      if (mode === FOLD_QUOTED && escapedFolds[fold])
        res += `${text[fold]}\\`;
      res += `
${indent}${text.slice(fold + 1, end2)}`;
    }
  }
  return res;
}
__name(foldFlowLines, "foldFlowLines");
function consumeMoreIndentedLines(text, i, indent) {
  let end = i;
  let start = i + 1;
  let ch = text[start];
  while (ch === " " || ch === "	") {
    if (i < start + indent) {
      ch = text[++i];
    } else {
      do {
        ch = text[++i];
      } while (ch && ch !== "\n");
      end = i;
      start = i + 1;
      ch = text[start];
    }
  }
  return end;
}
__name(consumeMoreIndentedLines, "consumeMoreIndentedLines");

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/stringify/stringifyString.js
var getFoldOptions = /* @__PURE__ */ __name((ctx, isBlock2) => ({
  indentAtStart: isBlock2 ? ctx.indent.length : ctx.indentAtStart,
  lineWidth: ctx.options.lineWidth,
  minContentWidth: ctx.options.minContentWidth
}), "getFoldOptions");
var containsDocumentMarker = /* @__PURE__ */ __name((str) => /^(%|---|\.\.\.)/m.test(str), "containsDocumentMarker");
function lineLengthOverLimit(str, lineWidth, indentLength) {
  if (!lineWidth || lineWidth < 0)
    return false;
  const limit = lineWidth - indentLength;
  const strLen = str.length;
  if (strLen <= limit)
    return false;
  for (let i = 0, start = 0; i < strLen; ++i) {
    if (str[i] === "\n") {
      if (i - start > limit)
        return true;
      start = i + 1;
      if (strLen - start <= limit)
        return false;
    }
  }
  return true;
}
__name(lineLengthOverLimit, "lineLengthOverLimit");
function doubleQuotedString(value, ctx) {
  const json = JSON.stringify(value);
  if (ctx.options.doubleQuotedAsJSON)
    return json;
  const { implicitKey } = ctx;
  const minMultiLineLength = ctx.options.doubleQuotedMinMultiLineLength;
  const indent = ctx.indent || (containsDocumentMarker(value) ? "  " : "");
  let str = "";
  let start = 0;
  for (let i = 0, ch = json[i]; ch; ch = json[++i]) {
    if (ch === " " && json[i + 1] === "\\" && json[i + 2] === "n") {
      str += json.slice(start, i) + "\\ ";
      i += 1;
      start = i;
      ch = "\\";
    }
    if (ch === "\\")
      switch (json[i + 1]) {
        case "u":
          {
            str += json.slice(start, i);
            const code = json.substr(i + 2, 4);
            switch (code) {
              case "0000":
                str += "\\0";
                break;
              case "0007":
                str += "\\a";
                break;
              case "000b":
                str += "\\v";
                break;
              case "001b":
                str += "\\e";
                break;
              case "0085":
                str += "\\N";
                break;
              case "00a0":
                str += "\\_";
                break;
              case "2028":
                str += "\\L";
                break;
              case "2029":
                str += "\\P";
                break;
              default:
                if (code.substr(0, 2) === "00")
                  str += "\\x" + code.substr(2);
                else
                  str += json.substr(i, 6);
            }
            i += 5;
            start = i + 1;
          }
          break;
        case "n":
          if (implicitKey || json[i + 2] === '"' || json.length < minMultiLineLength) {
            i += 1;
          } else {
            str += json.slice(start, i) + "\n\n";
            while (json[i + 2] === "\\" && json[i + 3] === "n" && json[i + 4] !== '"') {
              str += "\n";
              i += 2;
            }
            str += indent;
            if (json[i + 2] === " ")
              str += "\\";
            i += 1;
            start = i + 1;
          }
          break;
        default:
          i += 1;
      }
  }
  str = start ? str + json.slice(start) : json;
  return implicitKey ? str : foldFlowLines(str, indent, FOLD_QUOTED, getFoldOptions(ctx, false));
}
__name(doubleQuotedString, "doubleQuotedString");
function singleQuotedString(value, ctx) {
  if (ctx.options.singleQuote === false || ctx.implicitKey && value.includes("\n") || /[ \t]\n|\n[ \t]/.test(value))
    return doubleQuotedString(value, ctx);
  const indent = ctx.indent || (containsDocumentMarker(value) ? "  " : "");
  const res = "'" + value.replace(/'/g, "''").replace(/\n+/g, `$&
${indent}`) + "'";
  return ctx.implicitKey ? res : foldFlowLines(res, indent, FOLD_FLOW, getFoldOptions(ctx, false));
}
__name(singleQuotedString, "singleQuotedString");
function quotedString(value, ctx) {
  const { singleQuote } = ctx.options;
  let qs;
  if (singleQuote === false)
    qs = doubleQuotedString;
  else {
    const hasDouble = value.includes('"');
    const hasSingle = value.includes("'");
    if (hasDouble && !hasSingle)
      qs = singleQuotedString;
    else if (hasSingle && !hasDouble)
      qs = doubleQuotedString;
    else
      qs = singleQuote ? singleQuotedString : doubleQuotedString;
  }
  return qs(value, ctx);
}
__name(quotedString, "quotedString");
var blockEndNewlines;
try {
  blockEndNewlines = new RegExp("(^|(?<!\n))\n+(?!\n|$)", "g");
} catch {
  blockEndNewlines = /\n+(?!\n|$)/g;
}
function blockString({ comment, type, value }, ctx, onComment, onChompKeep) {
  const { blockQuote, commentString, lineWidth } = ctx.options;
  if (!blockQuote || /\n[\t ]+$/.test(value) || /^\s*$/.test(value)) {
    return quotedString(value, ctx);
  }
  const indent = ctx.indent || (ctx.forceBlockIndent || containsDocumentMarker(value) ? "  " : "");
  const literal = blockQuote === "literal" ? true : blockQuote === "folded" || type === Scalar.BLOCK_FOLDED ? false : type === Scalar.BLOCK_LITERAL ? true : !lineLengthOverLimit(value, lineWidth, indent.length);
  if (!value)
    return literal ? "|\n" : ">\n";
  let chomp;
  let endStart;
  for (endStart = value.length; endStart > 0; --endStart) {
    const ch = value[endStart - 1];
    if (ch !== "\n" && ch !== "	" && ch !== " ")
      break;
  }
  let end = value.substring(endStart);
  const endNlPos = end.indexOf("\n");
  if (endNlPos === -1) {
    chomp = "-";
  } else if (value === end || endNlPos !== end.length - 1) {
    chomp = "+";
    if (onChompKeep)
      onChompKeep();
  } else {
    chomp = "";
  }
  if (end) {
    value = value.slice(0, -end.length);
    if (end[end.length - 1] === "\n")
      end = end.slice(0, -1);
    end = end.replace(blockEndNewlines, `$&${indent}`);
  }
  let startWithSpace = false;
  let startEnd;
  let startNlPos = -1;
  for (startEnd = 0; startEnd < value.length; ++startEnd) {
    const ch = value[startEnd];
    if (ch === " ")
      startWithSpace = true;
    else if (ch === "\n")
      startNlPos = startEnd;
    else
      break;
  }
  let start = value.substring(0, startNlPos < startEnd ? startNlPos + 1 : startEnd);
  if (start) {
    value = value.substring(start.length);
    start = start.replace(/\n+/g, `$&${indent}`);
  }
  const indentSize = indent ? "2" : "1";
  let header = (startWithSpace ? indentSize : "") + chomp;
  if (comment) {
    header += " " + commentString(comment.replace(/ ?[\r\n]+/g, " "));
    if (onComment)
      onComment();
  }
  if (!literal) {
    const foldedValue = value.replace(/\n+/g, "\n$&").replace(/(?:^|\n)([\t ].*)(?:([\n\t ]*)\n(?![\n\t ]))?/g, "$1$2").replace(/\n+/g, `$&${indent}`);
    let literalFallback = false;
    const foldOptions = getFoldOptions(ctx, true);
    if (blockQuote !== "folded" && type !== Scalar.BLOCK_FOLDED) {
      foldOptions.onOverflow = () => {
        literalFallback = true;
      };
    }
    const body = foldFlowLines(`${start}${foldedValue}${end}`, indent, FOLD_BLOCK, foldOptions);
    if (!literalFallback)
      return `>${header}
${indent}${body}`;
  }
  value = value.replace(/\n+/g, `$&${indent}`);
  return `|${header}
${indent}${start}${value}${end}`;
}
__name(blockString, "blockString");
function plainString(item, ctx, onComment, onChompKeep) {
  const { type, value } = item;
  const { actualString, implicitKey, indent, indentStep, inFlow } = ctx;
  if (implicitKey && value.includes("\n") || inFlow && /[[\]{},]/.test(value)) {
    return quotedString(value, ctx);
  }
  if (!value || /^[\n\t ,[\]{}#&*!|>'"%@`]|^[?-]$|^[?-][ \t]|[\n:][ \t]|[ \t]\n|[\n\t ]#|[\n\t :]$/.test(value)) {
    return implicitKey || inFlow || !value.includes("\n") ? quotedString(value, ctx) : blockString(item, ctx, onComment, onChompKeep);
  }
  if (!implicitKey && !inFlow && type !== Scalar.PLAIN && value.includes("\n")) {
    return blockString(item, ctx, onComment, onChompKeep);
  }
  if (containsDocumentMarker(value)) {
    if (indent === "") {
      ctx.forceBlockIndent = true;
      return blockString(item, ctx, onComment, onChompKeep);
    } else if (implicitKey && indent === indentStep) {
      return quotedString(value, ctx);
    }
  }
  const str = value.replace(/\n+/g, `$&
${indent}`);
  if (actualString) {
    const test = /* @__PURE__ */ __name((tag) => tag.default && tag.tag !== "tag:yaml.org,2002:str" && tag.test?.test(str), "test");
    const { compat, tags } = ctx.doc.schema;
    if (tags.some(test) || compat?.some(test))
      return quotedString(value, ctx);
  }
  return implicitKey ? str : foldFlowLines(str, indent, FOLD_FLOW, getFoldOptions(ctx, false));
}
__name(plainString, "plainString");
function stringifyString(item, ctx, onComment, onChompKeep) {
  const { implicitKey, inFlow } = ctx;
  const ss = typeof item.value === "string" ? item : Object.assign({}, item, { value: String(item.value) });
  let { type } = item;
  if (type !== Scalar.QUOTE_DOUBLE) {
    if (/[\x00-\x08\x0b-\x1f\x7f-\x9f\u{D800}-\u{DFFF}]/u.test(ss.value))
      type = Scalar.QUOTE_DOUBLE;
  }
  const _stringify = /* @__PURE__ */ __name((_type) => {
    switch (_type) {
      case Scalar.BLOCK_FOLDED:
      case Scalar.BLOCK_LITERAL:
        return implicitKey || inFlow ? quotedString(ss.value, ctx) : blockString(ss, ctx, onComment, onChompKeep);
      case Scalar.QUOTE_DOUBLE:
        return doubleQuotedString(ss.value, ctx);
      case Scalar.QUOTE_SINGLE:
        return singleQuotedString(ss.value, ctx);
      case Scalar.PLAIN:
        return plainString(ss, ctx, onComment, onChompKeep);
      default:
        return null;
    }
  }, "_stringify");
  let res = _stringify(type);
  if (res === null) {
    const { defaultKeyType, defaultStringType } = ctx.options;
    const t = implicitKey && defaultKeyType || defaultStringType;
    res = _stringify(t);
    if (res === null)
      throw new Error(`Unsupported default string type ${t}`);
  }
  return res;
}
__name(stringifyString, "stringifyString");

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/stringify/stringify.js
function createStringifyContext(doc, options) {
  const opt = Object.assign({
    blockQuote: true,
    commentString: stringifyComment,
    defaultKeyType: null,
    defaultStringType: "PLAIN",
    directives: null,
    doubleQuotedAsJSON: false,
    doubleQuotedMinMultiLineLength: 40,
    falseStr: "false",
    flowCollectionPadding: true,
    indentSeq: true,
    lineWidth: 80,
    minContentWidth: 20,
    nullStr: "null",
    simpleKeys: false,
    singleQuote: null,
    trueStr: "true",
    verifyAliasOrder: true
  }, doc.schema.toStringOptions, options);
  let inFlow;
  switch (opt.collectionStyle) {
    case "block":
      inFlow = false;
      break;
    case "flow":
      inFlow = true;
      break;
    default:
      inFlow = null;
  }
  return {
    anchors: /* @__PURE__ */ new Set(),
    doc,
    flowCollectionPadding: opt.flowCollectionPadding ? " " : "",
    indent: "",
    indentStep: typeof opt.indent === "number" ? " ".repeat(opt.indent) : "  ",
    inFlow,
    options: opt
  };
}
__name(createStringifyContext, "createStringifyContext");
function getTagObject(tags, item) {
  if (item.tag) {
    const match2 = tags.filter((t) => t.tag === item.tag);
    if (match2.length > 0)
      return match2.find((t) => t.format === item.format) ?? match2[0];
  }
  let tagObj = void 0;
  let obj;
  if (isScalar(item)) {
    obj = item.value;
    let match2 = tags.filter((t) => t.identify?.(obj));
    if (match2.length > 1) {
      const testMatch = match2.filter((t) => t.test);
      if (testMatch.length > 0)
        match2 = testMatch;
    }
    tagObj = match2.find((t) => t.format === item.format) ?? match2.find((t) => !t.format);
  } else {
    obj = item;
    tagObj = tags.find((t) => t.nodeClass && obj instanceof t.nodeClass);
  }
  if (!tagObj) {
    const name = obj?.constructor?.name ?? typeof obj;
    throw new Error(`Tag not resolved for ${name} value`);
  }
  return tagObj;
}
__name(getTagObject, "getTagObject");
function stringifyProps(node, tagObj, { anchors, doc }) {
  if (!doc.directives)
    return "";
  const props = [];
  const anchor = (isScalar(node) || isCollection(node)) && node.anchor;
  if (anchor && anchorIsValid(anchor)) {
    anchors.add(anchor);
    props.push(`&${anchor}`);
  }
  const tag = node.tag ? node.tag : tagObj.default ? null : tagObj.tag;
  if (tag)
    props.push(doc.directives.tagString(tag));
  return props.join(" ");
}
__name(stringifyProps, "stringifyProps");
function stringify(item, ctx, onComment, onChompKeep) {
  if (isPair(item))
    return item.toString(ctx, onComment, onChompKeep);
  if (isAlias(item)) {
    if (ctx.doc.directives)
      return item.toString(ctx);
    if (ctx.resolvedAliases?.has(item)) {
      throw new TypeError(`Cannot stringify circular structure without alias nodes`);
    } else {
      if (ctx.resolvedAliases)
        ctx.resolvedAliases.add(item);
      else
        ctx.resolvedAliases = /* @__PURE__ */ new Set([item]);
      item = item.resolve(ctx.doc);
    }
  }
  let tagObj = void 0;
  const node = isNode(item) ? item : ctx.doc.createNode(item, { onTagObj: /* @__PURE__ */ __name((o) => tagObj = o, "onTagObj") });
  if (!tagObj)
    tagObj = getTagObject(ctx.doc.schema.tags, node);
  const props = stringifyProps(node, tagObj, ctx);
  if (props.length > 0)
    ctx.indentAtStart = (ctx.indentAtStart ?? 0) + props.length + 1;
  const str = typeof tagObj.stringify === "function" ? tagObj.stringify(node, ctx, onComment, onChompKeep) : isScalar(node) ? stringifyString(node, ctx, onComment, onChompKeep) : node.toString(ctx, onComment, onChompKeep);
  if (!props)
    return str;
  return isScalar(node) || str[0] === "{" || str[0] === "[" ? `${props} ${str}` : `${props}
${ctx.indent}${str}`;
}
__name(stringify, "stringify");

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/stringify/stringifyPair.js
function stringifyPair({ key, value }, ctx, onComment, onChompKeep) {
  const { allNullValues, doc, indent, indentStep, options: { commentString, indentSeq, simpleKeys } } = ctx;
  let keyComment = isNode(key) && key.comment || null;
  if (simpleKeys) {
    if (keyComment) {
      throw new Error("With simple keys, key nodes cannot have comments");
    }
    if (isCollection(key) || !isNode(key) && typeof key === "object") {
      const msg = "With simple keys, collection cannot be used as a key value";
      throw new Error(msg);
    }
  }
  let explicitKey = !simpleKeys && (!key || keyComment && value == null && !ctx.inFlow || isCollection(key) || (isScalar(key) ? key.type === Scalar.BLOCK_FOLDED || key.type === Scalar.BLOCK_LITERAL : typeof key === "object"));
  ctx = Object.assign({}, ctx, {
    allNullValues: false,
    implicitKey: !explicitKey && (simpleKeys || !allNullValues),
    indent: indent + indentStep
  });
  let keyCommentDone = false;
  let chompKeep = false;
  let str = stringify(key, ctx, () => keyCommentDone = true, () => chompKeep = true);
  if (!explicitKey && !ctx.inFlow && str.length > 1024) {
    if (simpleKeys)
      throw new Error("With simple keys, single line scalar must not span more than 1024 characters");
    explicitKey = true;
  }
  if (ctx.inFlow) {
    if (allNullValues || value == null) {
      if (keyCommentDone && onComment)
        onComment();
      return str === "" ? "?" : explicitKey ? `? ${str}` : str;
    }
  } else if (allNullValues && !simpleKeys || value == null && explicitKey) {
    str = `? ${str}`;
    if (keyComment && !keyCommentDone) {
      str += lineComment(str, ctx.indent, commentString(keyComment));
    } else if (chompKeep && onChompKeep)
      onChompKeep();
    return str;
  }
  if (keyCommentDone)
    keyComment = null;
  if (explicitKey) {
    if (keyComment)
      str += lineComment(str, ctx.indent, commentString(keyComment));
    str = `? ${str}
${indent}:`;
  } else {
    str = `${str}:`;
    if (keyComment)
      str += lineComment(str, ctx.indent, commentString(keyComment));
  }
  let vsb, vcb, valueComment;
  if (isNode(value)) {
    vsb = !!value.spaceBefore;
    vcb = value.commentBefore;
    valueComment = value.comment;
  } else {
    vsb = false;
    vcb = null;
    valueComment = null;
    if (value && typeof value === "object")
      value = doc.createNode(value);
  }
  ctx.implicitKey = false;
  if (!explicitKey && !keyComment && isScalar(value))
    ctx.indentAtStart = str.length + 1;
  chompKeep = false;
  if (!indentSeq && indentStep.length >= 2 && !ctx.inFlow && !explicitKey && isSeq(value) && !value.flow && !value.tag && !value.anchor) {
    ctx.indent = ctx.indent.substring(2);
  }
  let valueCommentDone = false;
  const valueStr = stringify(value, ctx, () => valueCommentDone = true, () => chompKeep = true);
  let ws = " ";
  if (keyComment || vsb || vcb) {
    ws = vsb ? "\n" : "";
    if (vcb) {
      const cs = commentString(vcb);
      ws += `
${indentComment(cs, ctx.indent)}`;
    }
    if (valueStr === "" && !ctx.inFlow) {
      if (ws === "\n")
        ws = "\n\n";
    } else {
      ws += `
${ctx.indent}`;
    }
  } else if (!explicitKey && isCollection(value)) {
    const vs0 = valueStr[0];
    const nl0 = valueStr.indexOf("\n");
    const hasNewline = nl0 !== -1;
    const flow = ctx.inFlow ?? value.flow ?? value.items.length === 0;
    if (hasNewline || !flow) {
      let hasPropsLine = false;
      if (hasNewline && (vs0 === "&" || vs0 === "!")) {
        let sp0 = valueStr.indexOf(" ");
        if (vs0 === "&" && sp0 !== -1 && sp0 < nl0 && valueStr[sp0 + 1] === "!") {
          sp0 = valueStr.indexOf(" ", sp0 + 1);
        }
        if (sp0 === -1 || nl0 < sp0)
          hasPropsLine = true;
      }
      if (!hasPropsLine)
        ws = `
${ctx.indent}`;
    }
  } else if (valueStr === "" || valueStr[0] === "\n") {
    ws = "";
  }
  str += ws + valueStr;
  if (ctx.inFlow) {
    if (valueCommentDone && onComment)
      onComment();
  } else if (valueComment && !valueCommentDone) {
    str += lineComment(str, ctx.indent, commentString(valueComment));
  } else if (chompKeep && onChompKeep) {
    onChompKeep();
  }
  return str;
}
__name(stringifyPair, "stringifyPair");

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/log.js
function warn(logLevel, warning) {
  if (logLevel === "debug" || logLevel === "warn") {
    console.warn(warning);
  }
}
__name(warn, "warn");

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/schema/yaml-1.1/merge.js
var MERGE_KEY = "<<";
var merge = {
  identify: /* @__PURE__ */ __name((value) => value === MERGE_KEY || typeof value === "symbol" && value.description === MERGE_KEY, "identify"),
  default: "key",
  tag: "tag:yaml.org,2002:merge",
  test: /^<<$/,
  resolve: /* @__PURE__ */ __name(() => Object.assign(new Scalar(Symbol(MERGE_KEY)), {
    addToJSMap: addMergeToJSMap
  }), "resolve"),
  stringify: /* @__PURE__ */ __name(() => MERGE_KEY, "stringify")
};
var isMergeKey = /* @__PURE__ */ __name((ctx, key) => (merge.identify(key) || isScalar(key) && (!key.type || key.type === Scalar.PLAIN) && merge.identify(key.value)) && ctx?.doc.schema.tags.some((tag) => tag.tag === merge.tag && tag.default), "isMergeKey");
function addMergeToJSMap(ctx, map2, value) {
  value = ctx && isAlias(value) ? value.resolve(ctx.doc) : value;
  if (isSeq(value))
    for (const it of value.items)
      mergeValue(ctx, map2, it);
  else if (Array.isArray(value))
    for (const it of value)
      mergeValue(ctx, map2, it);
  else
    mergeValue(ctx, map2, value);
}
__name(addMergeToJSMap, "addMergeToJSMap");
function mergeValue(ctx, map2, value) {
  const source = ctx && isAlias(value) ? value.resolve(ctx.doc) : value;
  if (!isMap(source))
    throw new Error("Merge sources must be maps or map aliases");
  const srcMap = source.toJSON(null, ctx, Map);
  for (const [key, value2] of srcMap) {
    if (map2 instanceof Map) {
      if (!map2.has(key))
        map2.set(key, value2);
    } else if (map2 instanceof Set) {
      map2.add(key);
    } else if (!Object.prototype.hasOwnProperty.call(map2, key)) {
      Object.defineProperty(map2, key, {
        value: value2,
        writable: true,
        enumerable: true,
        configurable: true
      });
    }
  }
  return map2;
}
__name(mergeValue, "mergeValue");

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/nodes/addPairToJSMap.js
function addPairToJSMap(ctx, map2, { key, value }) {
  if (isNode(key) && key.addToJSMap)
    key.addToJSMap(ctx, map2, value);
  else if (isMergeKey(ctx, key))
    addMergeToJSMap(ctx, map2, value);
  else {
    const jsKey = toJS(key, "", ctx);
    if (map2 instanceof Map) {
      map2.set(jsKey, toJS(value, jsKey, ctx));
    } else if (map2 instanceof Set) {
      map2.add(jsKey);
    } else {
      const stringKey = stringifyKey(key, jsKey, ctx);
      const jsValue = toJS(value, stringKey, ctx);
      if (stringKey in map2)
        Object.defineProperty(map2, stringKey, {
          value: jsValue,
          writable: true,
          enumerable: true,
          configurable: true
        });
      else
        map2[stringKey] = jsValue;
    }
  }
  return map2;
}
__name(addPairToJSMap, "addPairToJSMap");
function stringifyKey(key, jsKey, ctx) {
  if (jsKey === null)
    return "";
  if (typeof jsKey !== "object")
    return String(jsKey);
  if (isNode(key) && ctx?.doc) {
    const strCtx = createStringifyContext(ctx.doc, {});
    strCtx.anchors = /* @__PURE__ */ new Set();
    for (const node of ctx.anchors.keys())
      strCtx.anchors.add(node.anchor);
    strCtx.inFlow = true;
    strCtx.inStringifyKey = true;
    const strKey = key.toString(strCtx);
    if (!ctx.mapKeyWarned) {
      let jsonStr = JSON.stringify(strKey);
      if (jsonStr.length > 40)
        jsonStr = jsonStr.substring(0, 36) + '..."';
      warn(ctx.doc.options.logLevel, `Keys with collection values will be stringified due to JS Object restrictions: ${jsonStr}. Set mapAsMap: true to use object keys.`);
      ctx.mapKeyWarned = true;
    }
    return strKey;
  }
  return JSON.stringify(jsKey);
}
__name(stringifyKey, "stringifyKey");

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/nodes/Pair.js
function createPair(key, value, ctx) {
  const k = createNode(key, void 0, ctx);
  const v = createNode(value, void 0, ctx);
  return new Pair(k, v);
}
__name(createPair, "createPair");
var Pair = class _Pair {
  static {
    __name(this, "Pair");
  }
  constructor(key, value = null) {
    Object.defineProperty(this, NODE_TYPE, { value: PAIR });
    this.key = key;
    this.value = value;
  }
  clone(schema4) {
    let { key, value } = this;
    if (isNode(key))
      key = key.clone(schema4);
    if (isNode(value))
      value = value.clone(schema4);
    return new _Pair(key, value);
  }
  toJSON(_, ctx) {
    const pair = ctx?.mapAsMap ? /* @__PURE__ */ new Map() : {};
    return addPairToJSMap(ctx, pair, this);
  }
  toString(ctx, onComment, onChompKeep) {
    return ctx?.doc ? stringifyPair(this, ctx, onComment, onChompKeep) : JSON.stringify(this);
  }
};

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/stringify/stringifyCollection.js
function stringifyCollection(collection, ctx, options) {
  const flow = ctx.inFlow ?? collection.flow;
  const stringify4 = flow ? stringifyFlowCollection : stringifyBlockCollection;
  return stringify4(collection, ctx, options);
}
__name(stringifyCollection, "stringifyCollection");
function stringifyBlockCollection({ comment, items }, ctx, { blockItemPrefix, flowChars, itemIndent, onChompKeep, onComment }) {
  const { indent, options: { commentString } } = ctx;
  const itemCtx = Object.assign({}, ctx, { indent: itemIndent, type: null });
  let chompKeep = false;
  const lines = [];
  for (let i = 0; i < items.length; ++i) {
    const item = items[i];
    let comment2 = null;
    if (isNode(item)) {
      if (!chompKeep && item.spaceBefore)
        lines.push("");
      addCommentBefore(ctx, lines, item.commentBefore, chompKeep);
      if (item.comment)
        comment2 = item.comment;
    } else if (isPair(item)) {
      const ik = isNode(item.key) ? item.key : null;
      if (ik) {
        if (!chompKeep && ik.spaceBefore)
          lines.push("");
        addCommentBefore(ctx, lines, ik.commentBefore, chompKeep);
      }
    }
    chompKeep = false;
    let str2 = stringify(item, itemCtx, () => comment2 = null, () => chompKeep = true);
    if (comment2)
      str2 += lineComment(str2, itemIndent, commentString(comment2));
    if (chompKeep && comment2)
      chompKeep = false;
    lines.push(blockItemPrefix + str2);
  }
  let str;
  if (lines.length === 0) {
    str = flowChars.start + flowChars.end;
  } else {
    str = lines[0];
    for (let i = 1; i < lines.length; ++i) {
      const line = lines[i];
      str += line ? `
${indent}${line}` : "\n";
    }
  }
  if (comment) {
    str += "\n" + indentComment(commentString(comment), indent);
    if (onComment)
      onComment();
  } else if (chompKeep && onChompKeep)
    onChompKeep();
  return str;
}
__name(stringifyBlockCollection, "stringifyBlockCollection");
function stringifyFlowCollection({ items }, ctx, { flowChars, itemIndent }) {
  const { indent, indentStep, flowCollectionPadding: fcPadding, options: { commentString } } = ctx;
  itemIndent += indentStep;
  const itemCtx = Object.assign({}, ctx, {
    indent: itemIndent,
    inFlow: true,
    type: null
  });
  let reqNewline = false;
  let linesAtValue = 0;
  const lines = [];
  for (let i = 0; i < items.length; ++i) {
    const item = items[i];
    let comment = null;
    if (isNode(item)) {
      if (item.spaceBefore)
        lines.push("");
      addCommentBefore(ctx, lines, item.commentBefore, false);
      if (item.comment)
        comment = item.comment;
    } else if (isPair(item)) {
      const ik = isNode(item.key) ? item.key : null;
      if (ik) {
        if (ik.spaceBefore)
          lines.push("");
        addCommentBefore(ctx, lines, ik.commentBefore, false);
        if (ik.comment)
          reqNewline = true;
      }
      const iv = isNode(item.value) ? item.value : null;
      if (iv) {
        if (iv.comment)
          comment = iv.comment;
        if (iv.commentBefore)
          reqNewline = true;
      } else if (item.value == null && ik?.comment) {
        comment = ik.comment;
      }
    }
    if (comment)
      reqNewline = true;
    let str = stringify(item, itemCtx, () => comment = null);
    if (i < items.length - 1)
      str += ",";
    if (comment)
      str += lineComment(str, itemIndent, commentString(comment));
    if (!reqNewline && (lines.length > linesAtValue || str.includes("\n")))
      reqNewline = true;
    lines.push(str);
    linesAtValue = lines.length;
  }
  const { start, end } = flowChars;
  if (lines.length === 0) {
    return start + end;
  } else {
    if (!reqNewline) {
      const len = lines.reduce((sum, line) => sum + line.length + 2, 2);
      reqNewline = ctx.options.lineWidth > 0 && len > ctx.options.lineWidth;
    }
    if (reqNewline) {
      let str = start;
      for (const line of lines)
        str += line ? `
${indentStep}${indent}${line}` : "\n";
      return `${str}
${indent}${end}`;
    } else {
      return `${start}${fcPadding}${lines.join(" ")}${fcPadding}${end}`;
    }
  }
}
__name(stringifyFlowCollection, "stringifyFlowCollection");
function addCommentBefore({ indent, options: { commentString } }, lines, comment, chompKeep) {
  if (comment && chompKeep)
    comment = comment.replace(/^\n+/, "");
  if (comment) {
    const ic = indentComment(commentString(comment), indent);
    lines.push(ic.trimStart());
  }
}
__name(addCommentBefore, "addCommentBefore");

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/nodes/YAMLMap.js
function findPair(items, key) {
  const k = isScalar(key) ? key.value : key;
  for (const it of items) {
    if (isPair(it)) {
      if (it.key === key || it.key === k)
        return it;
      if (isScalar(it.key) && it.key.value === k)
        return it;
    }
  }
  return void 0;
}
__name(findPair, "findPair");
var YAMLMap = class extends Collection {
  static {
    __name(this, "YAMLMap");
  }
  static get tagName() {
    return "tag:yaml.org,2002:map";
  }
  constructor(schema4) {
    super(MAP, schema4);
    this.items = [];
  }
  /**
   * A generic collection parsing method that can be extended
   * to other node classes that inherit from YAMLMap
   */
  static from(schema4, obj, ctx) {
    const { keepUndefined, replacer } = ctx;
    const map2 = new this(schema4);
    const add = /* @__PURE__ */ __name((key, value) => {
      if (typeof replacer === "function")
        value = replacer.call(obj, key, value);
      else if (Array.isArray(replacer) && !replacer.includes(key))
        return;
      if (value !== void 0 || keepUndefined)
        map2.items.push(createPair(key, value, ctx));
    }, "add");
    if (obj instanceof Map) {
      for (const [key, value] of obj)
        add(key, value);
    } else if (obj && typeof obj === "object") {
      for (const key of Object.keys(obj))
        add(key, obj[key]);
    }
    if (typeof schema4.sortMapEntries === "function") {
      map2.items.sort(schema4.sortMapEntries);
    }
    return map2;
  }
  /**
   * Adds a value to the collection.
   *
   * @param overwrite - If not set `true`, using a key that is already in the
   *   collection will throw. Otherwise, overwrites the previous value.
   */
  add(pair, overwrite) {
    let _pair;
    if (isPair(pair))
      _pair = pair;
    else if (!pair || typeof pair !== "object" || !("key" in pair)) {
      _pair = new Pair(pair, pair?.value);
    } else
      _pair = new Pair(pair.key, pair.value);
    const prev = findPair(this.items, _pair.key);
    const sortEntries = this.schema?.sortMapEntries;
    if (prev) {
      if (!overwrite)
        throw new Error(`Key ${_pair.key} already set`);
      if (isScalar(prev.value) && isScalarValue(_pair.value))
        prev.value.value = _pair.value;
      else
        prev.value = _pair.value;
    } else if (sortEntries) {
      const i = this.items.findIndex((item) => sortEntries(_pair, item) < 0);
      if (i === -1)
        this.items.push(_pair);
      else
        this.items.splice(i, 0, _pair);
    } else {
      this.items.push(_pair);
    }
  }
  delete(key) {
    const it = findPair(this.items, key);
    if (!it)
      return false;
    const del = this.items.splice(this.items.indexOf(it), 1);
    return del.length > 0;
  }
  get(key, keepScalar) {
    const it = findPair(this.items, key);
    const node = it?.value;
    return (!keepScalar && isScalar(node) ? node.value : node) ?? void 0;
  }
  has(key) {
    return !!findPair(this.items, key);
  }
  set(key, value) {
    this.add(new Pair(key, value), true);
  }
  /**
   * @param ctx - Conversion context, originally set in Document#toJS()
   * @param {Class} Type - If set, forces the returned collection type
   * @returns Instance of Type, Map, or Object
   */
  toJSON(_, ctx, Type) {
    const map2 = Type ? new Type() : ctx?.mapAsMap ? /* @__PURE__ */ new Map() : {};
    if (ctx?.onCreate)
      ctx.onCreate(map2);
    for (const item of this.items)
      addPairToJSMap(ctx, map2, item);
    return map2;
  }
  toString(ctx, onComment, onChompKeep) {
    if (!ctx)
      return JSON.stringify(this);
    for (const item of this.items) {
      if (!isPair(item))
        throw new Error(`Map items must all be pairs; found ${JSON.stringify(item)} instead`);
    }
    if (!ctx.allNullValues && this.hasAllNullValues(false))
      ctx = Object.assign({}, ctx, { allNullValues: true });
    return stringifyCollection(this, ctx, {
      blockItemPrefix: "",
      flowChars: { start: "{", end: "}" },
      itemIndent: ctx.indent || "",
      onChompKeep,
      onComment
    });
  }
};

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/schema/common/map.js
var map = {
  collection: "map",
  default: true,
  nodeClass: YAMLMap,
  tag: "tag:yaml.org,2002:map",
  resolve(map2, onError) {
    if (!isMap(map2))
      onError("Expected a mapping for this tag");
    return map2;
  },
  createNode: /* @__PURE__ */ __name((schema4, obj, ctx) => YAMLMap.from(schema4, obj, ctx), "createNode")
};

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/nodes/YAMLSeq.js
var YAMLSeq = class extends Collection {
  static {
    __name(this, "YAMLSeq");
  }
  static get tagName() {
    return "tag:yaml.org,2002:seq";
  }
  constructor(schema4) {
    super(SEQ, schema4);
    this.items = [];
  }
  add(value) {
    this.items.push(value);
  }
  /**
   * Removes a value from the collection.
   *
   * `key` must contain a representation of an integer for this to succeed.
   * It may be wrapped in a `Scalar`.
   *
   * @returns `true` if the item was found and removed.
   */
  delete(key) {
    const idx = asItemIndex(key);
    if (typeof idx !== "number")
      return false;
    const del = this.items.splice(idx, 1);
    return del.length > 0;
  }
  get(key, keepScalar) {
    const idx = asItemIndex(key);
    if (typeof idx !== "number")
      return void 0;
    const it = this.items[idx];
    return !keepScalar && isScalar(it) ? it.value : it;
  }
  /**
   * Checks if the collection includes a value with the key `key`.
   *
   * `key` must contain a representation of an integer for this to succeed.
   * It may be wrapped in a `Scalar`.
   */
  has(key) {
    const idx = asItemIndex(key);
    return typeof idx === "number" && idx < this.items.length;
  }
  /**
   * Sets a value in this collection. For `!!set`, `value` needs to be a
   * boolean to add/remove the item from the set.
   *
   * If `key` does not contain a representation of an integer, this will throw.
   * It may be wrapped in a `Scalar`.
   */
  set(key, value) {
    const idx = asItemIndex(key);
    if (typeof idx !== "number")
      throw new Error(`Expected a valid index, not ${key}.`);
    const prev = this.items[idx];
    if (isScalar(prev) && isScalarValue(value))
      prev.value = value;
    else
      this.items[idx] = value;
  }
  toJSON(_, ctx) {
    const seq2 = [];
    if (ctx?.onCreate)
      ctx.onCreate(seq2);
    let i = 0;
    for (const item of this.items)
      seq2.push(toJS(item, String(i++), ctx));
    return seq2;
  }
  toString(ctx, onComment, onChompKeep) {
    if (!ctx)
      return JSON.stringify(this);
    return stringifyCollection(this, ctx, {
      blockItemPrefix: "- ",
      flowChars: { start: "[", end: "]" },
      itemIndent: (ctx.indent || "") + "  ",
      onChompKeep,
      onComment
    });
  }
  static from(schema4, obj, ctx) {
    const { replacer } = ctx;
    const seq2 = new this(schema4);
    if (obj && Symbol.iterator in Object(obj)) {
      let i = 0;
      for (let it of obj) {
        if (typeof replacer === "function") {
          const key = obj instanceof Set ? it : String(i++);
          it = replacer.call(obj, key, it);
        }
        seq2.items.push(createNode(it, void 0, ctx));
      }
    }
    return seq2;
  }
};
function asItemIndex(key) {
  let idx = isScalar(key) ? key.value : key;
  if (idx && typeof idx === "string")
    idx = Number(idx);
  return typeof idx === "number" && Number.isInteger(idx) && idx >= 0 ? idx : null;
}
__name(asItemIndex, "asItemIndex");

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/schema/common/seq.js
var seq = {
  collection: "seq",
  default: true,
  nodeClass: YAMLSeq,
  tag: "tag:yaml.org,2002:seq",
  resolve(seq2, onError) {
    if (!isSeq(seq2))
      onError("Expected a sequence for this tag");
    return seq2;
  },
  createNode: /* @__PURE__ */ __name((schema4, obj, ctx) => YAMLSeq.from(schema4, obj, ctx), "createNode")
};

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/schema/common/string.js
var string = {
  identify: /* @__PURE__ */ __name((value) => typeof value === "string", "identify"),
  default: true,
  tag: "tag:yaml.org,2002:str",
  resolve: /* @__PURE__ */ __name((str) => str, "resolve"),
  stringify(item, ctx, onComment, onChompKeep) {
    ctx = Object.assign({ actualString: true }, ctx);
    return stringifyString(item, ctx, onComment, onChompKeep);
  }
};

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/schema/common/null.js
var nullTag = {
  identify: /* @__PURE__ */ __name((value) => value == null, "identify"),
  createNode: /* @__PURE__ */ __name(() => new Scalar(null), "createNode"),
  default: true,
  tag: "tag:yaml.org,2002:null",
  test: /^(?:~|[Nn]ull|NULL)?$/,
  resolve: /* @__PURE__ */ __name(() => new Scalar(null), "resolve"),
  stringify: /* @__PURE__ */ __name(({ source }, ctx) => typeof source === "string" && nullTag.test.test(source) ? source : ctx.options.nullStr, "stringify")
};

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/schema/core/bool.js
var boolTag = {
  identify: /* @__PURE__ */ __name((value) => typeof value === "boolean", "identify"),
  default: true,
  tag: "tag:yaml.org,2002:bool",
  test: /^(?:[Tt]rue|TRUE|[Ff]alse|FALSE)$/,
  resolve: /* @__PURE__ */ __name((str) => new Scalar(str[0] === "t" || str[0] === "T"), "resolve"),
  stringify({ source, value }, ctx) {
    if (source && boolTag.test.test(source)) {
      const sv = source[0] === "t" || source[0] === "T";
      if (value === sv)
        return source;
    }
    return value ? ctx.options.trueStr : ctx.options.falseStr;
  }
};

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/stringify/stringifyNumber.js
function stringifyNumber({ format, minFractionDigits, tag, value }) {
  if (typeof value === "bigint")
    return String(value);
  const num = typeof value === "number" ? value : Number(value);
  if (!isFinite(num))
    return isNaN(num) ? ".nan" : num < 0 ? "-.inf" : ".inf";
  let n = JSON.stringify(value);
  if (!format && minFractionDigits && (!tag || tag === "tag:yaml.org,2002:float") && /^\d/.test(n)) {
    let i = n.indexOf(".");
    if (i < 0) {
      i = n.length;
      n += ".";
    }
    let d = minFractionDigits - (n.length - i - 1);
    while (d-- > 0)
      n += "0";
  }
  return n;
}
__name(stringifyNumber, "stringifyNumber");

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/schema/core/float.js
var floatNaN = {
  identify: /* @__PURE__ */ __name((value) => typeof value === "number", "identify"),
  default: true,
  tag: "tag:yaml.org,2002:float",
  test: /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
  resolve: /* @__PURE__ */ __name((str) => str.slice(-3).toLowerCase() === "nan" ? NaN : str[0] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY, "resolve"),
  stringify: stringifyNumber
};
var floatExp = {
  identify: /* @__PURE__ */ __name((value) => typeof value === "number", "identify"),
  default: true,
  tag: "tag:yaml.org,2002:float",
  format: "EXP",
  test: /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)[eE][-+]?[0-9]+$/,
  resolve: /* @__PURE__ */ __name((str) => parseFloat(str), "resolve"),
  stringify(node) {
    const num = Number(node.value);
    return isFinite(num) ? num.toExponential() : stringifyNumber(node);
  }
};
var float = {
  identify: /* @__PURE__ */ __name((value) => typeof value === "number", "identify"),
  default: true,
  tag: "tag:yaml.org,2002:float",
  test: /^[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*)$/,
  resolve(str) {
    const node = new Scalar(parseFloat(str));
    const dot = str.indexOf(".");
    if (dot !== -1 && str[str.length - 1] === "0")
      node.minFractionDigits = str.length - dot - 1;
    return node;
  },
  stringify: stringifyNumber
};

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/schema/core/int.js
var intIdentify = /* @__PURE__ */ __name((value) => typeof value === "bigint" || Number.isInteger(value), "intIdentify");
var intResolve = /* @__PURE__ */ __name((str, offset, radix, { intAsBigInt }) => intAsBigInt ? BigInt(str) : parseInt(str.substring(offset), radix), "intResolve");
function intStringify(node, radix, prefix) {
  const { value } = node;
  if (intIdentify(value) && value >= 0)
    return prefix + value.toString(radix);
  return stringifyNumber(node);
}
__name(intStringify, "intStringify");
var intOct = {
  identify: /* @__PURE__ */ __name((value) => intIdentify(value) && value >= 0, "identify"),
  default: true,
  tag: "tag:yaml.org,2002:int",
  format: "OCT",
  test: /^0o[0-7]+$/,
  resolve: /* @__PURE__ */ __name((str, _onError, opt) => intResolve(str, 2, 8, opt), "resolve"),
  stringify: /* @__PURE__ */ __name((node) => intStringify(node, 8, "0o"), "stringify")
};
var int = {
  identify: intIdentify,
  default: true,
  tag: "tag:yaml.org,2002:int",
  test: /^[-+]?[0-9]+$/,
  resolve: /* @__PURE__ */ __name((str, _onError, opt) => intResolve(str, 0, 10, opt), "resolve"),
  stringify: stringifyNumber
};
var intHex = {
  identify: /* @__PURE__ */ __name((value) => intIdentify(value) && value >= 0, "identify"),
  default: true,
  tag: "tag:yaml.org,2002:int",
  format: "HEX",
  test: /^0x[0-9a-fA-F]+$/,
  resolve: /* @__PURE__ */ __name((str, _onError, opt) => intResolve(str, 2, 16, opt), "resolve"),
  stringify: /* @__PURE__ */ __name((node) => intStringify(node, 16, "0x"), "stringify")
};

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/schema/core/schema.js
var schema = [
  map,
  seq,
  string,
  nullTag,
  boolTag,
  intOct,
  int,
  intHex,
  floatNaN,
  floatExp,
  float
];

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/schema/json/schema.js
function intIdentify2(value) {
  return typeof value === "bigint" || Number.isInteger(value);
}
__name(intIdentify2, "intIdentify");
var stringifyJSON = /* @__PURE__ */ __name(({ value }) => JSON.stringify(value), "stringifyJSON");
var jsonScalars = [
  {
    identify: /* @__PURE__ */ __name((value) => typeof value === "string", "identify"),
    default: true,
    tag: "tag:yaml.org,2002:str",
    resolve: /* @__PURE__ */ __name((str) => str, "resolve"),
    stringify: stringifyJSON
  },
  {
    identify: /* @__PURE__ */ __name((value) => value == null, "identify"),
    createNode: /* @__PURE__ */ __name(() => new Scalar(null), "createNode"),
    default: true,
    tag: "tag:yaml.org,2002:null",
    test: /^null$/,
    resolve: /* @__PURE__ */ __name(() => null, "resolve"),
    stringify: stringifyJSON
  },
  {
    identify: /* @__PURE__ */ __name((value) => typeof value === "boolean", "identify"),
    default: true,
    tag: "tag:yaml.org,2002:bool",
    test: /^true$|^false$/,
    resolve: /* @__PURE__ */ __name((str) => str === "true", "resolve"),
    stringify: stringifyJSON
  },
  {
    identify: intIdentify2,
    default: true,
    tag: "tag:yaml.org,2002:int",
    test: /^-?(?:0|[1-9][0-9]*)$/,
    resolve: /* @__PURE__ */ __name((str, _onError, { intAsBigInt }) => intAsBigInt ? BigInt(str) : parseInt(str, 10), "resolve"),
    stringify: /* @__PURE__ */ __name(({ value }) => intIdentify2(value) ? value.toString() : JSON.stringify(value), "stringify")
  },
  {
    identify: /* @__PURE__ */ __name((value) => typeof value === "number", "identify"),
    default: true,
    tag: "tag:yaml.org,2002:float",
    test: /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]*)?(?:[eE][-+]?[0-9]+)?$/,
    resolve: /* @__PURE__ */ __name((str) => parseFloat(str), "resolve"),
    stringify: stringifyJSON
  }
];
var jsonError = {
  default: true,
  tag: "",
  test: /^/,
  resolve(str, onError) {
    onError(`Unresolved plain scalar ${JSON.stringify(str)}`);
    return str;
  }
};
var schema2 = [map, seq].concat(jsonScalars, jsonError);

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/schema/yaml-1.1/binary.js
var binary = {
  identify: /* @__PURE__ */ __name((value) => value instanceof Uint8Array, "identify"),
  // Buffer inherits from Uint8Array
  default: false,
  tag: "tag:yaml.org,2002:binary",
  /**
   * Returns a Buffer in node and an Uint8Array in browsers
   *
   * To use the resulting buffer as an image, you'll want to do something like:
   *
   *   const blob = new Blob([buffer], { type: 'image/jpeg' })
   *   document.querySelector('#photo').src = URL.createObjectURL(blob)
   */
  resolve(src, onError) {
    if (typeof atob === "function") {
      const str = atob(src.replace(/[\n\r]/g, ""));
      const buffer = new Uint8Array(str.length);
      for (let i = 0; i < str.length; ++i)
        buffer[i] = str.charCodeAt(i);
      return buffer;
    } else {
      onError("This environment does not support reading binary tags; either Buffer or atob is required");
      return src;
    }
  },
  stringify({ comment, type, value }, ctx, onComment, onChompKeep) {
    if (!value)
      return "";
    const buf = value;
    let str;
    if (typeof btoa === "function") {
      let s = "";
      for (let i = 0; i < buf.length; ++i)
        s += String.fromCharCode(buf[i]);
      str = btoa(s);
    } else {
      throw new Error("This environment does not support writing binary tags; either Buffer or btoa is required");
    }
    if (!type)
      type = Scalar.BLOCK_LITERAL;
    if (type !== Scalar.QUOTE_DOUBLE) {
      const lineWidth = Math.max(ctx.options.lineWidth - ctx.indent.length, ctx.options.minContentWidth);
      const n = Math.ceil(str.length / lineWidth);
      const lines = new Array(n);
      for (let i = 0, o = 0; i < n; ++i, o += lineWidth) {
        lines[i] = str.substr(o, lineWidth);
      }
      str = lines.join(type === Scalar.BLOCK_LITERAL ? "\n" : " ");
    }
    return stringifyString({ comment, type, value: str }, ctx, onComment, onChompKeep);
  }
};

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/schema/yaml-1.1/pairs.js
function resolvePairs(seq2, onError) {
  if (isSeq(seq2)) {
    for (let i = 0; i < seq2.items.length; ++i) {
      let item = seq2.items[i];
      if (isPair(item))
        continue;
      else if (isMap(item)) {
        if (item.items.length > 1)
          onError("Each pair must have its own sequence indicator");
        const pair = item.items[0] || new Pair(new Scalar(null));
        if (item.commentBefore)
          pair.key.commentBefore = pair.key.commentBefore ? `${item.commentBefore}
${pair.key.commentBefore}` : item.commentBefore;
        if (item.comment) {
          const cn = pair.value ?? pair.key;
          cn.comment = cn.comment ? `${item.comment}
${cn.comment}` : item.comment;
        }
        item = pair;
      }
      seq2.items[i] = isPair(item) ? item : new Pair(item);
    }
  } else
    onError("Expected a sequence for this tag");
  return seq2;
}
__name(resolvePairs, "resolvePairs");
function createPairs(schema4, iterable, ctx) {
  const { replacer } = ctx;
  const pairs2 = new YAMLSeq(schema4);
  pairs2.tag = "tag:yaml.org,2002:pairs";
  let i = 0;
  if (iterable && Symbol.iterator in Object(iterable))
    for (let it of iterable) {
      if (typeof replacer === "function")
        it = replacer.call(iterable, String(i++), it);
      let key, value;
      if (Array.isArray(it)) {
        if (it.length === 2) {
          key = it[0];
          value = it[1];
        } else
          throw new TypeError(`Expected [key, value] tuple: ${it}`);
      } else if (it && it instanceof Object) {
        const keys = Object.keys(it);
        if (keys.length === 1) {
          key = keys[0];
          value = it[key];
        } else {
          throw new TypeError(`Expected tuple with one key, not ${keys.length} keys`);
        }
      } else {
        key = it;
      }
      pairs2.items.push(createPair(key, value, ctx));
    }
  return pairs2;
}
__name(createPairs, "createPairs");
var pairs = {
  collection: "seq",
  default: false,
  tag: "tag:yaml.org,2002:pairs",
  resolve: resolvePairs,
  createNode: createPairs
};

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/schema/yaml-1.1/omap.js
var YAMLOMap = class _YAMLOMap extends YAMLSeq {
  static {
    __name(this, "YAMLOMap");
  }
  constructor() {
    super();
    this.add = YAMLMap.prototype.add.bind(this);
    this.delete = YAMLMap.prototype.delete.bind(this);
    this.get = YAMLMap.prototype.get.bind(this);
    this.has = YAMLMap.prototype.has.bind(this);
    this.set = YAMLMap.prototype.set.bind(this);
    this.tag = _YAMLOMap.tag;
  }
  /**
   * If `ctx` is given, the return type is actually `Map<unknown, unknown>`,
   * but TypeScript won't allow widening the signature of a child method.
   */
  toJSON(_, ctx) {
    if (!ctx)
      return super.toJSON(_);
    const map2 = /* @__PURE__ */ new Map();
    if (ctx?.onCreate)
      ctx.onCreate(map2);
    for (const pair of this.items) {
      let key, value;
      if (isPair(pair)) {
        key = toJS(pair.key, "", ctx);
        value = toJS(pair.value, key, ctx);
      } else {
        key = toJS(pair, "", ctx);
      }
      if (map2.has(key))
        throw new Error("Ordered maps must not include duplicate keys");
      map2.set(key, value);
    }
    return map2;
  }
  static from(schema4, iterable, ctx) {
    const pairs2 = createPairs(schema4, iterable, ctx);
    const omap2 = new this();
    omap2.items = pairs2.items;
    return omap2;
  }
};
YAMLOMap.tag = "tag:yaml.org,2002:omap";
var omap = {
  collection: "seq",
  identify: /* @__PURE__ */ __name((value) => value instanceof Map, "identify"),
  nodeClass: YAMLOMap,
  default: false,
  tag: "tag:yaml.org,2002:omap",
  resolve(seq2, onError) {
    const pairs2 = resolvePairs(seq2, onError);
    const seenKeys = [];
    for (const { key } of pairs2.items) {
      if (isScalar(key)) {
        if (seenKeys.includes(key.value)) {
          onError(`Ordered maps must not include duplicate keys: ${key.value}`);
        } else {
          seenKeys.push(key.value);
        }
      }
    }
    return Object.assign(new YAMLOMap(), pairs2);
  },
  createNode: /* @__PURE__ */ __name((schema4, iterable, ctx) => YAMLOMap.from(schema4, iterable, ctx), "createNode")
};

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/schema/yaml-1.1/bool.js
function boolStringify({ value, source }, ctx) {
  const boolObj = value ? trueTag : falseTag;
  if (source && boolObj.test.test(source))
    return source;
  return value ? ctx.options.trueStr : ctx.options.falseStr;
}
__name(boolStringify, "boolStringify");
var trueTag = {
  identify: /* @__PURE__ */ __name((value) => value === true, "identify"),
  default: true,
  tag: "tag:yaml.org,2002:bool",
  test: /^(?:Y|y|[Yy]es|YES|[Tt]rue|TRUE|[Oo]n|ON)$/,
  resolve: /* @__PURE__ */ __name(() => new Scalar(true), "resolve"),
  stringify: boolStringify
};
var falseTag = {
  identify: /* @__PURE__ */ __name((value) => value === false, "identify"),
  default: true,
  tag: "tag:yaml.org,2002:bool",
  test: /^(?:N|n|[Nn]o|NO|[Ff]alse|FALSE|[Oo]ff|OFF)$/,
  resolve: /* @__PURE__ */ __name(() => new Scalar(false), "resolve"),
  stringify: boolStringify
};

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/schema/yaml-1.1/float.js
var floatNaN2 = {
  identify: /* @__PURE__ */ __name((value) => typeof value === "number", "identify"),
  default: true,
  tag: "tag:yaml.org,2002:float",
  test: /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
  resolve: /* @__PURE__ */ __name((str) => str.slice(-3).toLowerCase() === "nan" ? NaN : str[0] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY, "resolve"),
  stringify: stringifyNumber
};
var floatExp2 = {
  identify: /* @__PURE__ */ __name((value) => typeof value === "number", "identify"),
  default: true,
  tag: "tag:yaml.org,2002:float",
  format: "EXP",
  test: /^[-+]?(?:[0-9][0-9_]*)?(?:\.[0-9_]*)?[eE][-+]?[0-9]+$/,
  resolve: /* @__PURE__ */ __name((str) => parseFloat(str.replace(/_/g, "")), "resolve"),
  stringify(node) {
    const num = Number(node.value);
    return isFinite(num) ? num.toExponential() : stringifyNumber(node);
  }
};
var float2 = {
  identify: /* @__PURE__ */ __name((value) => typeof value === "number", "identify"),
  default: true,
  tag: "tag:yaml.org,2002:float",
  test: /^[-+]?(?:[0-9][0-9_]*)?\.[0-9_]*$/,
  resolve(str) {
    const node = new Scalar(parseFloat(str.replace(/_/g, "")));
    const dot = str.indexOf(".");
    if (dot !== -1) {
      const f = str.substring(dot + 1).replace(/_/g, "");
      if (f[f.length - 1] === "0")
        node.minFractionDigits = f.length;
    }
    return node;
  },
  stringify: stringifyNumber
};

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/schema/yaml-1.1/int.js
var intIdentify3 = /* @__PURE__ */ __name((value) => typeof value === "bigint" || Number.isInteger(value), "intIdentify");
function intResolve2(str, offset, radix, { intAsBigInt }) {
  const sign = str[0];
  if (sign === "-" || sign === "+")
    offset += 1;
  str = str.substring(offset).replace(/_/g, "");
  if (intAsBigInt) {
    switch (radix) {
      case 2:
        str = `0b${str}`;
        break;
      case 8:
        str = `0o${str}`;
        break;
      case 16:
        str = `0x${str}`;
        break;
    }
    const n2 = BigInt(str);
    return sign === "-" ? BigInt(-1) * n2 : n2;
  }
  const n = parseInt(str, radix);
  return sign === "-" ? -1 * n : n;
}
__name(intResolve2, "intResolve");
function intStringify2(node, radix, prefix) {
  const { value } = node;
  if (intIdentify3(value)) {
    const str = value.toString(radix);
    return value < 0 ? "-" + prefix + str.substr(1) : prefix + str;
  }
  return stringifyNumber(node);
}
__name(intStringify2, "intStringify");
var intBin = {
  identify: intIdentify3,
  default: true,
  tag: "tag:yaml.org,2002:int",
  format: "BIN",
  test: /^[-+]?0b[0-1_]+$/,
  resolve: /* @__PURE__ */ __name((str, _onError, opt) => intResolve2(str, 2, 2, opt), "resolve"),
  stringify: /* @__PURE__ */ __name((node) => intStringify2(node, 2, "0b"), "stringify")
};
var intOct2 = {
  identify: intIdentify3,
  default: true,
  tag: "tag:yaml.org,2002:int",
  format: "OCT",
  test: /^[-+]?0[0-7_]+$/,
  resolve: /* @__PURE__ */ __name((str, _onError, opt) => intResolve2(str, 1, 8, opt), "resolve"),
  stringify: /* @__PURE__ */ __name((node) => intStringify2(node, 8, "0"), "stringify")
};
var int2 = {
  identify: intIdentify3,
  default: true,
  tag: "tag:yaml.org,2002:int",
  test: /^[-+]?[0-9][0-9_]*$/,
  resolve: /* @__PURE__ */ __name((str, _onError, opt) => intResolve2(str, 0, 10, opt), "resolve"),
  stringify: stringifyNumber
};
var intHex2 = {
  identify: intIdentify3,
  default: true,
  tag: "tag:yaml.org,2002:int",
  format: "HEX",
  test: /^[-+]?0x[0-9a-fA-F_]+$/,
  resolve: /* @__PURE__ */ __name((str, _onError, opt) => intResolve2(str, 2, 16, opt), "resolve"),
  stringify: /* @__PURE__ */ __name((node) => intStringify2(node, 16, "0x"), "stringify")
};

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/schema/yaml-1.1/set.js
var YAMLSet = class _YAMLSet extends YAMLMap {
  static {
    __name(this, "YAMLSet");
  }
  constructor(schema4) {
    super(schema4);
    this.tag = _YAMLSet.tag;
  }
  add(key) {
    let pair;
    if (isPair(key))
      pair = key;
    else if (key && typeof key === "object" && "key" in key && "value" in key && key.value === null)
      pair = new Pair(key.key, null);
    else
      pair = new Pair(key, null);
    const prev = findPair(this.items, pair.key);
    if (!prev)
      this.items.push(pair);
  }
  /**
   * If `keepPair` is `true`, returns the Pair matching `key`.
   * Otherwise, returns the value of that Pair's key.
   */
  get(key, keepPair) {
    const pair = findPair(this.items, key);
    return !keepPair && isPair(pair) ? isScalar(pair.key) ? pair.key.value : pair.key : pair;
  }
  set(key, value) {
    if (typeof value !== "boolean")
      throw new Error(`Expected boolean value for set(key, value) in a YAML set, not ${typeof value}`);
    const prev = findPair(this.items, key);
    if (prev && !value) {
      this.items.splice(this.items.indexOf(prev), 1);
    } else if (!prev && value) {
      this.items.push(new Pair(key));
    }
  }
  toJSON(_, ctx) {
    return super.toJSON(_, ctx, Set);
  }
  toString(ctx, onComment, onChompKeep) {
    if (!ctx)
      return JSON.stringify(this);
    if (this.hasAllNullValues(true))
      return super.toString(Object.assign({}, ctx, { allNullValues: true }), onComment, onChompKeep);
    else
      throw new Error("Set items must all have null values");
  }
  static from(schema4, iterable, ctx) {
    const { replacer } = ctx;
    const set2 = new this(schema4);
    if (iterable && Symbol.iterator in Object(iterable))
      for (let value of iterable) {
        if (typeof replacer === "function")
          value = replacer.call(iterable, value, value);
        set2.items.push(createPair(value, null, ctx));
      }
    return set2;
  }
};
YAMLSet.tag = "tag:yaml.org,2002:set";
var set = {
  collection: "map",
  identify: /* @__PURE__ */ __name((value) => value instanceof Set, "identify"),
  nodeClass: YAMLSet,
  default: false,
  tag: "tag:yaml.org,2002:set",
  createNode: /* @__PURE__ */ __name((schema4, iterable, ctx) => YAMLSet.from(schema4, iterable, ctx), "createNode"),
  resolve(map2, onError) {
    if (isMap(map2)) {
      if (map2.hasAllNullValues(true))
        return Object.assign(new YAMLSet(), map2);
      else
        onError("Set items must all have null values");
    } else
      onError("Expected a mapping for this tag");
    return map2;
  }
};

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/schema/yaml-1.1/timestamp.js
function parseSexagesimal(str, asBigInt) {
  const sign = str[0];
  const parts = sign === "-" || sign === "+" ? str.substring(1) : str;
  const num = /* @__PURE__ */ __name((n) => asBigInt ? BigInt(n) : Number(n), "num");
  const res = parts.replace(/_/g, "").split(":").reduce((res2, p) => res2 * num(60) + num(p), num(0));
  return sign === "-" ? num(-1) * res : res;
}
__name(parseSexagesimal, "parseSexagesimal");
function stringifySexagesimal(node) {
  let { value } = node;
  let num = /* @__PURE__ */ __name((n) => n, "num");
  if (typeof value === "bigint")
    num = /* @__PURE__ */ __name((n) => BigInt(n), "num");
  else if (isNaN(value) || !isFinite(value))
    return stringifyNumber(node);
  let sign = "";
  if (value < 0) {
    sign = "-";
    value *= num(-1);
  }
  const _60 = num(60);
  const parts = [value % _60];
  if (value < 60) {
    parts.unshift(0);
  } else {
    value = (value - parts[0]) / _60;
    parts.unshift(value % _60);
    if (value >= 60) {
      value = (value - parts[0]) / _60;
      parts.unshift(value);
    }
  }
  return sign + parts.map((n) => String(n).padStart(2, "0")).join(":").replace(/000000\d*$/, "");
}
__name(stringifySexagesimal, "stringifySexagesimal");
var intTime = {
  identify: /* @__PURE__ */ __name((value) => typeof value === "bigint" || Number.isInteger(value), "identify"),
  default: true,
  tag: "tag:yaml.org,2002:int",
  format: "TIME",
  test: /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+$/,
  resolve: /* @__PURE__ */ __name((str, _onError, { intAsBigInt }) => parseSexagesimal(str, intAsBigInt), "resolve"),
  stringify: stringifySexagesimal
};
var floatTime = {
  identify: /* @__PURE__ */ __name((value) => typeof value === "number", "identify"),
  default: true,
  tag: "tag:yaml.org,2002:float",
  format: "TIME",
  test: /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*$/,
  resolve: /* @__PURE__ */ __name((str) => parseSexagesimal(str, false), "resolve"),
  stringify: stringifySexagesimal
};
var timestamp = {
  identify: /* @__PURE__ */ __name((value) => value instanceof Date, "identify"),
  default: true,
  tag: "tag:yaml.org,2002:timestamp",
  // If the time zone is omitted, the timestamp is assumed to be specified in UTC. The time part
  // may be omitted altogether, resulting in a date format. In such a case, the time part is
  // assumed to be 00:00:00Z (start of day, UTC).
  test: RegExp("^([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})(?:(?:t|T|[ \\t]+)([0-9]{1,2}):([0-9]{1,2}):([0-9]{1,2}(\\.[0-9]+)?)(?:[ \\t]*(Z|[-+][012]?[0-9](?::[0-9]{2})?))?)?$"),
  resolve(str) {
    const match2 = str.match(timestamp.test);
    if (!match2)
      throw new Error("!!timestamp expects a date, starting with yyyy-mm-dd");
    const [, year, month, day, hour, minute, second] = match2.map(Number);
    const millisec = match2[7] ? Number((match2[7] + "00").substr(1, 3)) : 0;
    let date = Date.UTC(year, month - 1, day, hour || 0, minute || 0, second || 0, millisec);
    const tz = match2[8];
    if (tz && tz !== "Z") {
      let d = parseSexagesimal(tz, false);
      if (Math.abs(d) < 30)
        d *= 60;
      date -= 6e4 * d;
    }
    return new Date(date);
  },
  stringify: /* @__PURE__ */ __name(({ value }) => value?.toISOString().replace(/(T00:00:00)?\.000Z$/, "") ?? "", "stringify")
};

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/schema/yaml-1.1/schema.js
var schema3 = [
  map,
  seq,
  string,
  nullTag,
  trueTag,
  falseTag,
  intBin,
  intOct2,
  int2,
  intHex2,
  floatNaN2,
  floatExp2,
  float2,
  binary,
  merge,
  omap,
  pairs,
  set,
  intTime,
  floatTime,
  timestamp
];

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/schema/tags.js
var schemas = /* @__PURE__ */ new Map([
  ["core", schema],
  ["failsafe", [map, seq, string]],
  ["json", schema2],
  ["yaml11", schema3],
  ["yaml-1.1", schema3]
]);
var tagsByName = {
  binary,
  bool: boolTag,
  float,
  floatExp,
  floatNaN,
  floatTime,
  int,
  intHex,
  intOct,
  intTime,
  map,
  merge,
  null: nullTag,
  omap,
  pairs,
  seq,
  set,
  timestamp
};
var coreKnownTags = {
  "tag:yaml.org,2002:binary": binary,
  "tag:yaml.org,2002:merge": merge,
  "tag:yaml.org,2002:omap": omap,
  "tag:yaml.org,2002:pairs": pairs,
  "tag:yaml.org,2002:set": set,
  "tag:yaml.org,2002:timestamp": timestamp
};
function getTags(customTags, schemaName, addMergeTag) {
  const schemaTags = schemas.get(schemaName);
  if (schemaTags && !customTags) {
    return addMergeTag && !schemaTags.includes(merge) ? schemaTags.concat(merge) : schemaTags.slice();
  }
  let tags = schemaTags;
  if (!tags) {
    if (Array.isArray(customTags))
      tags = [];
    else {
      const keys = Array.from(schemas.keys()).filter((key) => key !== "yaml11").map((key) => JSON.stringify(key)).join(", ");
      throw new Error(`Unknown schema "${schemaName}"; use one of ${keys} or define customTags array`);
    }
  }
  if (Array.isArray(customTags)) {
    for (const tag of customTags)
      tags = tags.concat(tag);
  } else if (typeof customTags === "function") {
    tags = customTags(tags.slice());
  }
  if (addMergeTag)
    tags = tags.concat(merge);
  return tags.reduce((tags2, tag) => {
    const tagObj = typeof tag === "string" ? tagsByName[tag] : tag;
    if (!tagObj) {
      const tagName = JSON.stringify(tag);
      const keys = Object.keys(tagsByName).map((key) => JSON.stringify(key)).join(", ");
      throw new Error(`Unknown custom tag ${tagName}; use one of ${keys}`);
    }
    if (!tags2.includes(tagObj))
      tags2.push(tagObj);
    return tags2;
  }, []);
}
__name(getTags, "getTags");

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/schema/Schema.js
var sortMapEntriesByKey = /* @__PURE__ */ __name((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0, "sortMapEntriesByKey");
var Schema = class _Schema {
  static {
    __name(this, "Schema");
  }
  constructor({ compat, customTags, merge: merge2, resolveKnownTags, schema: schema4, sortMapEntries, toStringDefaults }) {
    this.compat = Array.isArray(compat) ? getTags(compat, "compat") : compat ? getTags(null, compat) : null;
    this.name = typeof schema4 === "string" && schema4 || "core";
    this.knownTags = resolveKnownTags ? coreKnownTags : {};
    this.tags = getTags(customTags, this.name, merge2);
    this.toStringOptions = toStringDefaults ?? null;
    Object.defineProperty(this, MAP, { value: map });
    Object.defineProperty(this, SCALAR, { value: string });
    Object.defineProperty(this, SEQ, { value: seq });
    this.sortMapEntries = typeof sortMapEntries === "function" ? sortMapEntries : sortMapEntries === true ? sortMapEntriesByKey : null;
  }
  clone() {
    const copy = Object.create(_Schema.prototype, Object.getOwnPropertyDescriptors(this));
    copy.tags = this.tags.slice();
    return copy;
  }
};

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/stringify/stringifyDocument.js
function stringifyDocument(doc, options) {
  const lines = [];
  let hasDirectives = options.directives === true;
  if (options.directives !== false && doc.directives) {
    const dir = doc.directives.toString(doc);
    if (dir) {
      lines.push(dir);
      hasDirectives = true;
    } else if (doc.directives.docStart)
      hasDirectives = true;
  }
  if (hasDirectives)
    lines.push("---");
  const ctx = createStringifyContext(doc, options);
  const { commentString } = ctx.options;
  if (doc.commentBefore) {
    if (lines.length !== 1)
      lines.unshift("");
    const cs = commentString(doc.commentBefore);
    lines.unshift(indentComment(cs, ""));
  }
  let chompKeep = false;
  let contentComment = null;
  if (doc.contents) {
    if (isNode(doc.contents)) {
      if (doc.contents.spaceBefore && hasDirectives)
        lines.push("");
      if (doc.contents.commentBefore) {
        const cs = commentString(doc.contents.commentBefore);
        lines.push(indentComment(cs, ""));
      }
      ctx.forceBlockIndent = !!doc.comment;
      contentComment = doc.contents.comment;
    }
    const onChompKeep = contentComment ? void 0 : () => chompKeep = true;
    let body = stringify(doc.contents, ctx, () => contentComment = null, onChompKeep);
    if (contentComment)
      body += lineComment(body, "", commentString(contentComment));
    if ((body[0] === "|" || body[0] === ">") && lines[lines.length - 1] === "---") {
      lines[lines.length - 1] = `--- ${body}`;
    } else
      lines.push(body);
  } else {
    lines.push(stringify(doc.contents, ctx));
  }
  if (doc.directives?.docEnd) {
    if (doc.comment) {
      const cs = commentString(doc.comment);
      if (cs.includes("\n")) {
        lines.push("...");
        lines.push(indentComment(cs, ""));
      } else {
        lines.push(`... ${cs}`);
      }
    } else {
      lines.push("...");
    }
  } else {
    let dc = doc.comment;
    if (dc && chompKeep)
      dc = dc.replace(/^\n+/, "");
    if (dc) {
      if ((!chompKeep || contentComment) && lines[lines.length - 1] !== "")
        lines.push("");
      lines.push(indentComment(commentString(dc), ""));
    }
  }
  return lines.join("\n") + "\n";
}
__name(stringifyDocument, "stringifyDocument");

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/doc/Document.js
var Document = class _Document {
  static {
    __name(this, "Document");
  }
  constructor(value, replacer, options) {
    this.commentBefore = null;
    this.comment = null;
    this.errors = [];
    this.warnings = [];
    Object.defineProperty(this, NODE_TYPE, { value: DOC });
    let _replacer = null;
    if (typeof replacer === "function" || Array.isArray(replacer)) {
      _replacer = replacer;
    } else if (options === void 0 && replacer) {
      options = replacer;
      replacer = void 0;
    }
    const opt = Object.assign({
      intAsBigInt: false,
      keepSourceTokens: false,
      logLevel: "warn",
      prettyErrors: true,
      strict: true,
      stringKeys: false,
      uniqueKeys: true,
      version: "1.2"
    }, options);
    this.options = opt;
    let { version } = opt;
    if (options?._directives) {
      this.directives = options._directives.atDocument();
      if (this.directives.yaml.explicit)
        version = this.directives.yaml.version;
    } else
      this.directives = new Directives({ version });
    this.setSchema(version, options);
    this.contents = value === void 0 ? null : this.createNode(value, _replacer, options);
  }
  /**
   * Create a deep copy of this Document and its contents.
   *
   * Custom Node values that inherit from `Object` still refer to their original instances.
   */
  clone() {
    const copy = Object.create(_Document.prototype, {
      [NODE_TYPE]: { value: DOC }
    });
    copy.commentBefore = this.commentBefore;
    copy.comment = this.comment;
    copy.errors = this.errors.slice();
    copy.warnings = this.warnings.slice();
    copy.options = Object.assign({}, this.options);
    if (this.directives)
      copy.directives = this.directives.clone();
    copy.schema = this.schema.clone();
    copy.contents = isNode(this.contents) ? this.contents.clone(copy.schema) : this.contents;
    if (this.range)
      copy.range = this.range.slice();
    return copy;
  }
  /** Adds a value to the document. */
  add(value) {
    if (assertCollection(this.contents))
      this.contents.add(value);
  }
  /** Adds a value to the document. */
  addIn(path, value) {
    if (assertCollection(this.contents))
      this.contents.addIn(path, value);
  }
  /**
   * Create a new `Alias` node, ensuring that the target `node` has the required anchor.
   *
   * If `node` already has an anchor, `name` is ignored.
   * Otherwise, the `node.anchor` value will be set to `name`,
   * or if an anchor with that name is already present in the document,
   * `name` will be used as a prefix for a new unique anchor.
   * If `name` is undefined, the generated anchor will use 'a' as a prefix.
   */
  createAlias(node, name) {
    if (!node.anchor) {
      const prev = anchorNames(this);
      node.anchor = // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
      !name || prev.has(name) ? findNewAnchor(name || "a", prev) : name;
    }
    return new Alias(node.anchor);
  }
  createNode(value, replacer, options) {
    let _replacer = void 0;
    if (typeof replacer === "function") {
      value = replacer.call({ "": value }, "", value);
      _replacer = replacer;
    } else if (Array.isArray(replacer)) {
      const keyToStr = /* @__PURE__ */ __name((v) => typeof v === "number" || v instanceof String || v instanceof Number, "keyToStr");
      const asStr = replacer.filter(keyToStr).map(String);
      if (asStr.length > 0)
        replacer = replacer.concat(asStr);
      _replacer = replacer;
    } else if (options === void 0 && replacer) {
      options = replacer;
      replacer = void 0;
    }
    const { aliasDuplicateObjects, anchorPrefix, flow, keepUndefined, onTagObj, tag } = options ?? {};
    const { onAnchor, setAnchors, sourceObjects } = createNodeAnchors(
      this,
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
      anchorPrefix || "a"
    );
    const ctx = {
      aliasDuplicateObjects: aliasDuplicateObjects ?? true,
      keepUndefined: keepUndefined ?? false,
      onAnchor,
      onTagObj,
      replacer: _replacer,
      schema: this.schema,
      sourceObjects
    };
    const node = createNode(value, tag, ctx);
    if (flow && isCollection(node))
      node.flow = true;
    setAnchors();
    return node;
  }
  /**
   * Convert a key and a value into a `Pair` using the current schema,
   * recursively wrapping all values as `Scalar` or `Collection` nodes.
   */
  createPair(key, value, options = {}) {
    const k = this.createNode(key, null, options);
    const v = this.createNode(value, null, options);
    return new Pair(k, v);
  }
  /**
   * Removes a value from the document.
   * @returns `true` if the item was found and removed.
   */
  delete(key) {
    return assertCollection(this.contents) ? this.contents.delete(key) : false;
  }
  /**
   * Removes a value from the document.
   * @returns `true` if the item was found and removed.
   */
  deleteIn(path) {
    if (isEmptyPath(path)) {
      if (this.contents == null)
        return false;
      this.contents = null;
      return true;
    }
    return assertCollection(this.contents) ? this.contents.deleteIn(path) : false;
  }
  /**
   * Returns item at `key`, or `undefined` if not found. By default unwraps
   * scalar values from their surrounding node; to disable set `keepScalar` to
   * `true` (collections are always returned intact).
   */
  get(key, keepScalar) {
    return isCollection(this.contents) ? this.contents.get(key, keepScalar) : void 0;
  }
  /**
   * Returns item at `path`, or `undefined` if not found. By default unwraps
   * scalar values from their surrounding node; to disable set `keepScalar` to
   * `true` (collections are always returned intact).
   */
  getIn(path, keepScalar) {
    if (isEmptyPath(path))
      return !keepScalar && isScalar(this.contents) ? this.contents.value : this.contents;
    return isCollection(this.contents) ? this.contents.getIn(path, keepScalar) : void 0;
  }
  /**
   * Checks if the document includes a value with the key `key`.
   */
  has(key) {
    return isCollection(this.contents) ? this.contents.has(key) : false;
  }
  /**
   * Checks if the document includes a value at `path`.
   */
  hasIn(path) {
    if (isEmptyPath(path))
      return this.contents !== void 0;
    return isCollection(this.contents) ? this.contents.hasIn(path) : false;
  }
  /**
   * Sets a value in this document. For `!!set`, `value` needs to be a
   * boolean to add/remove the item from the set.
   */
  set(key, value) {
    if (this.contents == null) {
      this.contents = collectionFromPath(this.schema, [key], value);
    } else if (assertCollection(this.contents)) {
      this.contents.set(key, value);
    }
  }
  /**
   * Sets a value in this document. For `!!set`, `value` needs to be a
   * boolean to add/remove the item from the set.
   */
  setIn(path, value) {
    if (isEmptyPath(path)) {
      this.contents = value;
    } else if (this.contents == null) {
      this.contents = collectionFromPath(this.schema, Array.from(path), value);
    } else if (assertCollection(this.contents)) {
      this.contents.setIn(path, value);
    }
  }
  /**
   * Change the YAML version and schema used by the document.
   * A `null` version disables support for directives, explicit tags, anchors, and aliases.
   * It also requires the `schema` option to be given as a `Schema` instance value.
   *
   * Overrides all previously set schema options.
   */
  setSchema(version, options = {}) {
    if (typeof version === "number")
      version = String(version);
    let opt;
    switch (version) {
      case "1.1":
        if (this.directives)
          this.directives.yaml.version = "1.1";
        else
          this.directives = new Directives({ version: "1.1" });
        opt = { resolveKnownTags: false, schema: "yaml-1.1" };
        break;
      case "1.2":
      case "next":
        if (this.directives)
          this.directives.yaml.version = version;
        else
          this.directives = new Directives({ version });
        opt = { resolveKnownTags: true, schema: "core" };
        break;
      case null:
        if (this.directives)
          delete this.directives;
        opt = null;
        break;
      default: {
        const sv = JSON.stringify(version);
        throw new Error(`Expected '1.1', '1.2' or null as first argument, but found: ${sv}`);
      }
    }
    if (options.schema instanceof Object)
      this.schema = options.schema;
    else if (opt)
      this.schema = new Schema(Object.assign(opt, options));
    else
      throw new Error(`With a null YAML version, the { schema: Schema } option is required`);
  }
  // json & jsonArg are only used from toJSON()
  toJS({ json, jsonArg, mapAsMap, maxAliasCount, onAnchor, reviver } = {}) {
    const ctx = {
      anchors: /* @__PURE__ */ new Map(),
      doc: this,
      keep: !json,
      mapAsMap: mapAsMap === true,
      mapKeyWarned: false,
      maxAliasCount: typeof maxAliasCount === "number" ? maxAliasCount : 100
    };
    const res = toJS(this.contents, jsonArg ?? "", ctx);
    if (typeof onAnchor === "function")
      for (const { count, res: res2 } of ctx.anchors.values())
        onAnchor(res2, count);
    return typeof reviver === "function" ? applyReviver(reviver, { "": res }, "", res) : res;
  }
  /**
   * A JSON representation of the document `contents`.
   *
   * @param jsonArg Used by `JSON.stringify` to indicate the array index or
   *   property name.
   */
  toJSON(jsonArg, onAnchor) {
    return this.toJS({ json: true, jsonArg, mapAsMap: false, onAnchor });
  }
  /** A YAML representation of the document. */
  toString(options = {}) {
    if (this.errors.length > 0)
      throw new Error("Document with errors cannot be stringified");
    if ("indent" in options && (!Number.isInteger(options.indent) || Number(options.indent) <= 0)) {
      const s = JSON.stringify(options.indent);
      throw new Error(`"indent" option must be a positive integer, not ${s}`);
    }
    return stringifyDocument(this, options);
  }
};
function assertCollection(contents) {
  if (isCollection(contents))
    return true;
  throw new Error("Expected a YAML collection as document contents");
}
__name(assertCollection, "assertCollection");

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/errors.js
var YAMLError = class extends Error {
  static {
    __name(this, "YAMLError");
  }
  constructor(name, pos, code, message) {
    super();
    this.name = name;
    this.code = code;
    this.message = message;
    this.pos = pos;
  }
};
var YAMLParseError = class extends YAMLError {
  static {
    __name(this, "YAMLParseError");
  }
  constructor(pos, code, message) {
    super("YAMLParseError", pos, code, message);
  }
};
var YAMLWarning = class extends YAMLError {
  static {
    __name(this, "YAMLWarning");
  }
  constructor(pos, code, message) {
    super("YAMLWarning", pos, code, message);
  }
};
var prettifyError = /* @__PURE__ */ __name((src, lc) => (error) => {
  if (error.pos[0] === -1)
    return;
  error.linePos = error.pos.map((pos) => lc.linePos(pos));
  const { line, col } = error.linePos[0];
  error.message += ` at line ${line}, column ${col}`;
  let ci = col - 1;
  let lineStr = src.substring(lc.lineStarts[line - 1], lc.lineStarts[line]).replace(/[\n\r]+$/, "");
  if (ci >= 60 && lineStr.length > 80) {
    const trimStart = Math.min(ci - 39, lineStr.length - 79);
    lineStr = "\u2026" + lineStr.substring(trimStart);
    ci -= trimStart - 1;
  }
  if (lineStr.length > 80)
    lineStr = lineStr.substring(0, 79) + "\u2026";
  if (line > 1 && /^ *$/.test(lineStr.substring(0, ci))) {
    let prev = src.substring(lc.lineStarts[line - 2], lc.lineStarts[line - 1]);
    if (prev.length > 80)
      prev = prev.substring(0, 79) + "\u2026\n";
    lineStr = prev + lineStr;
  }
  if (/[^ ]/.test(lineStr)) {
    let count = 1;
    const end = error.linePos[1];
    if (end && end.line === line && end.col > col) {
      count = Math.max(1, Math.min(end.col - col, 80 - ci));
    }
    const pointer = " ".repeat(ci) + "^".repeat(count);
    error.message += `:

${lineStr}
${pointer}
`;
  }
}, "prettifyError");

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/compose/resolve-props.js
function resolveProps(tokens, { flow, indicator, next, offset, onError, parentIndent, startOnNewline }) {
  let spaceBefore = false;
  let atNewline = startOnNewline;
  let hasSpace = startOnNewline;
  let comment = "";
  let commentSep = "";
  let hasNewline = false;
  let reqSpace = false;
  let tab = null;
  let anchor = null;
  let tag = null;
  let newlineAfterProp = null;
  let comma = null;
  let found = null;
  let start = null;
  for (const token of tokens) {
    if (reqSpace) {
      if (token.type !== "space" && token.type !== "newline" && token.type !== "comma")
        onError(token.offset, "MISSING_CHAR", "Tags and anchors must be separated from the next token by white space");
      reqSpace = false;
    }
    if (tab) {
      if (atNewline && token.type !== "comment" && token.type !== "newline") {
        onError(tab, "TAB_AS_INDENT", "Tabs are not allowed as indentation");
      }
      tab = null;
    }
    switch (token.type) {
      case "space":
        if (!flow && (indicator !== "doc-start" || next?.type !== "flow-collection") && token.source.includes("	")) {
          tab = token;
        }
        hasSpace = true;
        break;
      case "comment": {
        if (!hasSpace)
          onError(token, "MISSING_CHAR", "Comments must be separated from other tokens by white space characters");
        const cb = token.source.substring(1) || " ";
        if (!comment)
          comment = cb;
        else
          comment += commentSep + cb;
        commentSep = "";
        atNewline = false;
        break;
      }
      case "newline":
        if (atNewline) {
          if (comment)
            comment += token.source;
          else if (!found || indicator !== "seq-item-ind")
            spaceBefore = true;
        } else
          commentSep += token.source;
        atNewline = true;
        hasNewline = true;
        if (anchor || tag)
          newlineAfterProp = token;
        hasSpace = true;
        break;
      case "anchor":
        if (anchor)
          onError(token, "MULTIPLE_ANCHORS", "A node can have at most one anchor");
        if (token.source.endsWith(":"))
          onError(token.offset + token.source.length - 1, "BAD_ALIAS", "Anchor ending in : is ambiguous", true);
        anchor = token;
        if (start === null)
          start = token.offset;
        atNewline = false;
        hasSpace = false;
        reqSpace = true;
        break;
      case "tag": {
        if (tag)
          onError(token, "MULTIPLE_TAGS", "A node can have at most one tag");
        tag = token;
        if (start === null)
          start = token.offset;
        atNewline = false;
        hasSpace = false;
        reqSpace = true;
        break;
      }
      case indicator:
        if (anchor || tag)
          onError(token, "BAD_PROP_ORDER", `Anchors and tags must be after the ${token.source} indicator`);
        if (found)
          onError(token, "UNEXPECTED_TOKEN", `Unexpected ${token.source} in ${flow ?? "collection"}`);
        found = token;
        atNewline = indicator === "seq-item-ind" || indicator === "explicit-key-ind";
        hasSpace = false;
        break;
      case "comma":
        if (flow) {
          if (comma)
            onError(token, "UNEXPECTED_TOKEN", `Unexpected , in ${flow}`);
          comma = token;
          atNewline = false;
          hasSpace = false;
          break;
        }
      // else fallthrough
      default:
        onError(token, "UNEXPECTED_TOKEN", `Unexpected ${token.type} token`);
        atNewline = false;
        hasSpace = false;
    }
  }
  const last = tokens[tokens.length - 1];
  const end = last ? last.offset + last.source.length : offset;
  if (reqSpace && next && next.type !== "space" && next.type !== "newline" && next.type !== "comma" && (next.type !== "scalar" || next.source !== "")) {
    onError(next.offset, "MISSING_CHAR", "Tags and anchors must be separated from the next token by white space");
  }
  if (tab && (atNewline && tab.indent <= parentIndent || next?.type === "block-map" || next?.type === "block-seq"))
    onError(tab, "TAB_AS_INDENT", "Tabs are not allowed as indentation");
  return {
    comma,
    found,
    spaceBefore,
    comment,
    hasNewline,
    anchor,
    tag,
    newlineAfterProp,
    end,
    start: start ?? end
  };
}
__name(resolveProps, "resolveProps");

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/compose/util-contains-newline.js
function containsNewline(key) {
  if (!key)
    return null;
  switch (key.type) {
    case "alias":
    case "scalar":
    case "double-quoted-scalar":
    case "single-quoted-scalar":
      if (key.source.includes("\n"))
        return true;
      if (key.end) {
        for (const st of key.end)
          if (st.type === "newline")
            return true;
      }
      return false;
    case "flow-collection":
      for (const it of key.items) {
        for (const st of it.start)
          if (st.type === "newline")
            return true;
        if (it.sep) {
          for (const st of it.sep)
            if (st.type === "newline")
              return true;
        }
        if (containsNewline(it.key) || containsNewline(it.value))
          return true;
      }
      return false;
    default:
      return true;
  }
}
__name(containsNewline, "containsNewline");

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/compose/util-flow-indent-check.js
function flowIndentCheck(indent, fc, onError) {
  if (fc?.type === "flow-collection") {
    const end = fc.end[0];
    if (end.indent === indent && (end.source === "]" || end.source === "}") && containsNewline(fc)) {
      const msg = "Flow end indicator should be more indented than parent";
      onError(end, "BAD_INDENT", msg, true);
    }
  }
}
__name(flowIndentCheck, "flowIndentCheck");

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/compose/util-map-includes.js
function mapIncludes(ctx, items, search) {
  const { uniqueKeys } = ctx.options;
  if (uniqueKeys === false)
    return false;
  const isEqual = typeof uniqueKeys === "function" ? uniqueKeys : (a, b) => a === b || isScalar(a) && isScalar(b) && a.value === b.value;
  return items.some((pair) => isEqual(pair.key, search));
}
__name(mapIncludes, "mapIncludes");

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/compose/resolve-block-map.js
var startColMsg = "All mapping items must start at the same column";
function resolveBlockMap({ composeNode: composeNode2, composeEmptyNode: composeEmptyNode2 }, ctx, bm, onError, tag) {
  const NodeClass = tag?.nodeClass ?? YAMLMap;
  const map2 = new NodeClass(ctx.schema);
  if (ctx.atRoot)
    ctx.atRoot = false;
  let offset = bm.offset;
  let commentEnd = null;
  for (const collItem of bm.items) {
    const { start, key, sep, value } = collItem;
    const keyProps = resolveProps(start, {
      indicator: "explicit-key-ind",
      next: key ?? sep?.[0],
      offset,
      onError,
      parentIndent: bm.indent,
      startOnNewline: true
    });
    const implicitKey = !keyProps.found;
    if (implicitKey) {
      if (key) {
        if (key.type === "block-seq")
          onError(offset, "BLOCK_AS_IMPLICIT_KEY", "A block sequence may not be used as an implicit map key");
        else if ("indent" in key && key.indent !== bm.indent)
          onError(offset, "BAD_INDENT", startColMsg);
      }
      if (!keyProps.anchor && !keyProps.tag && !sep) {
        commentEnd = keyProps.end;
        if (keyProps.comment) {
          if (map2.comment)
            map2.comment += "\n" + keyProps.comment;
          else
            map2.comment = keyProps.comment;
        }
        continue;
      }
      if (keyProps.newlineAfterProp || containsNewline(key)) {
        onError(key ?? start[start.length - 1], "MULTILINE_IMPLICIT_KEY", "Implicit keys need to be on a single line");
      }
    } else if (keyProps.found?.indent !== bm.indent) {
      onError(offset, "BAD_INDENT", startColMsg);
    }
    ctx.atKey = true;
    const keyStart = keyProps.end;
    const keyNode = key ? composeNode2(ctx, key, keyProps, onError) : composeEmptyNode2(ctx, keyStart, start, null, keyProps, onError);
    if (ctx.schema.compat)
      flowIndentCheck(bm.indent, key, onError);
    ctx.atKey = false;
    if (mapIncludes(ctx, map2.items, keyNode))
      onError(keyStart, "DUPLICATE_KEY", "Map keys must be unique");
    const valueProps = resolveProps(sep ?? [], {
      indicator: "map-value-ind",
      next: value,
      offset: keyNode.range[2],
      onError,
      parentIndent: bm.indent,
      startOnNewline: !key || key.type === "block-scalar"
    });
    offset = valueProps.end;
    if (valueProps.found) {
      if (implicitKey) {
        if (value?.type === "block-map" && !valueProps.hasNewline)
          onError(offset, "BLOCK_AS_IMPLICIT_KEY", "Nested mappings are not allowed in compact mappings");
        if (ctx.options.strict && keyProps.start < valueProps.found.offset - 1024)
          onError(keyNode.range, "KEY_OVER_1024_CHARS", "The : indicator must be at most 1024 chars after the start of an implicit block mapping key");
      }
      const valueNode = value ? composeNode2(ctx, value, valueProps, onError) : composeEmptyNode2(ctx, offset, sep, null, valueProps, onError);
      if (ctx.schema.compat)
        flowIndentCheck(bm.indent, value, onError);
      offset = valueNode.range[2];
      const pair = new Pair(keyNode, valueNode);
      if (ctx.options.keepSourceTokens)
        pair.srcToken = collItem;
      map2.items.push(pair);
    } else {
      if (implicitKey)
        onError(keyNode.range, "MISSING_CHAR", "Implicit map keys need to be followed by map values");
      if (valueProps.comment) {
        if (keyNode.comment)
          keyNode.comment += "\n" + valueProps.comment;
        else
          keyNode.comment = valueProps.comment;
      }
      const pair = new Pair(keyNode);
      if (ctx.options.keepSourceTokens)
        pair.srcToken = collItem;
      map2.items.push(pair);
    }
  }
  if (commentEnd && commentEnd < offset)
    onError(commentEnd, "IMPOSSIBLE", "Map comment with trailing content");
  map2.range = [bm.offset, offset, commentEnd ?? offset];
  return map2;
}
__name(resolveBlockMap, "resolveBlockMap");

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/compose/resolve-block-seq.js
function resolveBlockSeq({ composeNode: composeNode2, composeEmptyNode: composeEmptyNode2 }, ctx, bs, onError, tag) {
  const NodeClass = tag?.nodeClass ?? YAMLSeq;
  const seq2 = new NodeClass(ctx.schema);
  if (ctx.atRoot)
    ctx.atRoot = false;
  if (ctx.atKey)
    ctx.atKey = false;
  let offset = bs.offset;
  let commentEnd = null;
  for (const { start, value } of bs.items) {
    const props = resolveProps(start, {
      indicator: "seq-item-ind",
      next: value,
      offset,
      onError,
      parentIndent: bs.indent,
      startOnNewline: true
    });
    if (!props.found) {
      if (props.anchor || props.tag || value) {
        if (value && value.type === "block-seq")
          onError(props.end, "BAD_INDENT", "All sequence items must start at the same column");
        else
          onError(offset, "MISSING_CHAR", "Sequence item without - indicator");
      } else {
        commentEnd = props.end;
        if (props.comment)
          seq2.comment = props.comment;
        continue;
      }
    }
    const node = value ? composeNode2(ctx, value, props, onError) : composeEmptyNode2(ctx, props.end, start, null, props, onError);
    if (ctx.schema.compat)
      flowIndentCheck(bs.indent, value, onError);
    offset = node.range[2];
    seq2.items.push(node);
  }
  seq2.range = [bs.offset, offset, commentEnd ?? offset];
  return seq2;
}
__name(resolveBlockSeq, "resolveBlockSeq");

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/compose/resolve-end.js
function resolveEnd(end, offset, reqSpace, onError) {
  let comment = "";
  if (end) {
    let hasSpace = false;
    let sep = "";
    for (const token of end) {
      const { source, type } = token;
      switch (type) {
        case "space":
          hasSpace = true;
          break;
        case "comment": {
          if (reqSpace && !hasSpace)
            onError(token, "MISSING_CHAR", "Comments must be separated from other tokens by white space characters");
          const cb = source.substring(1) || " ";
          if (!comment)
            comment = cb;
          else
            comment += sep + cb;
          sep = "";
          break;
        }
        case "newline":
          if (comment)
            sep += source;
          hasSpace = true;
          break;
        default:
          onError(token, "UNEXPECTED_TOKEN", `Unexpected ${type} at node end`);
      }
      offset += source.length;
    }
  }
  return { comment, offset };
}
__name(resolveEnd, "resolveEnd");

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/compose/resolve-flow-collection.js
var blockMsg = "Block collections are not allowed within flow collections";
var isBlock = /* @__PURE__ */ __name((token) => token && (token.type === "block-map" || token.type === "block-seq"), "isBlock");
function resolveFlowCollection({ composeNode: composeNode2, composeEmptyNode: composeEmptyNode2 }, ctx, fc, onError, tag) {
  const isMap2 = fc.start.source === "{";
  const fcName = isMap2 ? "flow map" : "flow sequence";
  const NodeClass = tag?.nodeClass ?? (isMap2 ? YAMLMap : YAMLSeq);
  const coll = new NodeClass(ctx.schema);
  coll.flow = true;
  const atRoot = ctx.atRoot;
  if (atRoot)
    ctx.atRoot = false;
  if (ctx.atKey)
    ctx.atKey = false;
  let offset = fc.offset + fc.start.source.length;
  for (let i = 0; i < fc.items.length; ++i) {
    const collItem = fc.items[i];
    const { start, key, sep, value } = collItem;
    const props = resolveProps(start, {
      flow: fcName,
      indicator: "explicit-key-ind",
      next: key ?? sep?.[0],
      offset,
      onError,
      parentIndent: fc.indent,
      startOnNewline: false
    });
    if (!props.found) {
      if (!props.anchor && !props.tag && !sep && !value) {
        if (i === 0 && props.comma)
          onError(props.comma, "UNEXPECTED_TOKEN", `Unexpected , in ${fcName}`);
        else if (i < fc.items.length - 1)
          onError(props.start, "UNEXPECTED_TOKEN", `Unexpected empty item in ${fcName}`);
        if (props.comment) {
          if (coll.comment)
            coll.comment += "\n" + props.comment;
          else
            coll.comment = props.comment;
        }
        offset = props.end;
        continue;
      }
      if (!isMap2 && ctx.options.strict && containsNewline(key))
        onError(
          key,
          // checked by containsNewline()
          "MULTILINE_IMPLICIT_KEY",
          "Implicit keys of flow sequence pairs need to be on a single line"
        );
    }
    if (i === 0) {
      if (props.comma)
        onError(props.comma, "UNEXPECTED_TOKEN", `Unexpected , in ${fcName}`);
    } else {
      if (!props.comma)
        onError(props.start, "MISSING_CHAR", `Missing , between ${fcName} items`);
      if (props.comment) {
        let prevItemComment = "";
        loop: for (const st of start) {
          switch (st.type) {
            case "comma":
            case "space":
              break;
            case "comment":
              prevItemComment = st.source.substring(1);
              break loop;
            default:
              break loop;
          }
        }
        if (prevItemComment) {
          let prev = coll.items[coll.items.length - 1];
          if (isPair(prev))
            prev = prev.value ?? prev.key;
          if (prev.comment)
            prev.comment += "\n" + prevItemComment;
          else
            prev.comment = prevItemComment;
          props.comment = props.comment.substring(prevItemComment.length + 1);
        }
      }
    }
    if (!isMap2 && !sep && !props.found) {
      const valueNode = value ? composeNode2(ctx, value, props, onError) : composeEmptyNode2(ctx, props.end, sep, null, props, onError);
      coll.items.push(valueNode);
      offset = valueNode.range[2];
      if (isBlock(value))
        onError(valueNode.range, "BLOCK_IN_FLOW", blockMsg);
    } else {
      ctx.atKey = true;
      const keyStart = props.end;
      const keyNode = key ? composeNode2(ctx, key, props, onError) : composeEmptyNode2(ctx, keyStart, start, null, props, onError);
      if (isBlock(key))
        onError(keyNode.range, "BLOCK_IN_FLOW", blockMsg);
      ctx.atKey = false;
      const valueProps = resolveProps(sep ?? [], {
        flow: fcName,
        indicator: "map-value-ind",
        next: value,
        offset: keyNode.range[2],
        onError,
        parentIndent: fc.indent,
        startOnNewline: false
      });
      if (valueProps.found) {
        if (!isMap2 && !props.found && ctx.options.strict) {
          if (sep)
            for (const st of sep) {
              if (st === valueProps.found)
                break;
              if (st.type === "newline") {
                onError(st, "MULTILINE_IMPLICIT_KEY", "Implicit keys of flow sequence pairs need to be on a single line");
                break;
              }
            }
          if (props.start < valueProps.found.offset - 1024)
            onError(valueProps.found, "KEY_OVER_1024_CHARS", "The : indicator must be at most 1024 chars after the start of an implicit flow sequence key");
        }
      } else if (value) {
        if ("source" in value && value.source && value.source[0] === ":")
          onError(value, "MISSING_CHAR", `Missing space after : in ${fcName}`);
        else
          onError(valueProps.start, "MISSING_CHAR", `Missing , or : between ${fcName} items`);
      }
      const valueNode = value ? composeNode2(ctx, value, valueProps, onError) : valueProps.found ? composeEmptyNode2(ctx, valueProps.end, sep, null, valueProps, onError) : null;
      if (valueNode) {
        if (isBlock(value))
          onError(valueNode.range, "BLOCK_IN_FLOW", blockMsg);
      } else if (valueProps.comment) {
        if (keyNode.comment)
          keyNode.comment += "\n" + valueProps.comment;
        else
          keyNode.comment = valueProps.comment;
      }
      const pair = new Pair(keyNode, valueNode);
      if (ctx.options.keepSourceTokens)
        pair.srcToken = collItem;
      if (isMap2) {
        const map2 = coll;
        if (mapIncludes(ctx, map2.items, keyNode))
          onError(keyStart, "DUPLICATE_KEY", "Map keys must be unique");
        map2.items.push(pair);
      } else {
        const map2 = new YAMLMap(ctx.schema);
        map2.flow = true;
        map2.items.push(pair);
        const endRange = (valueNode ?? keyNode).range;
        map2.range = [keyNode.range[0], endRange[1], endRange[2]];
        coll.items.push(map2);
      }
      offset = valueNode ? valueNode.range[2] : valueProps.end;
    }
  }
  const expectedEnd = isMap2 ? "}" : "]";
  const [ce, ...ee] = fc.end;
  let cePos = offset;
  if (ce && ce.source === expectedEnd)
    cePos = ce.offset + ce.source.length;
  else {
    const name = fcName[0].toUpperCase() + fcName.substring(1);
    const msg = atRoot ? `${name} must end with a ${expectedEnd}` : `${name} in block collection must be sufficiently indented and end with a ${expectedEnd}`;
    onError(offset, atRoot ? "MISSING_CHAR" : "BAD_INDENT", msg);
    if (ce && ce.source.length !== 1)
      ee.unshift(ce);
  }
  if (ee.length > 0) {
    const end = resolveEnd(ee, cePos, ctx.options.strict, onError);
    if (end.comment) {
      if (coll.comment)
        coll.comment += "\n" + end.comment;
      else
        coll.comment = end.comment;
    }
    coll.range = [fc.offset, cePos, end.offset];
  } else {
    coll.range = [fc.offset, cePos, cePos];
  }
  return coll;
}
__name(resolveFlowCollection, "resolveFlowCollection");

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/compose/compose-collection.js
function resolveCollection(CN2, ctx, token, onError, tagName, tag) {
  const coll = token.type === "block-map" ? resolveBlockMap(CN2, ctx, token, onError, tag) : token.type === "block-seq" ? resolveBlockSeq(CN2, ctx, token, onError, tag) : resolveFlowCollection(CN2, ctx, token, onError, tag);
  const Coll = coll.constructor;
  if (tagName === "!" || tagName === Coll.tagName) {
    coll.tag = Coll.tagName;
    return coll;
  }
  if (tagName)
    coll.tag = tagName;
  return coll;
}
__name(resolveCollection, "resolveCollection");
function composeCollection(CN2, ctx, token, props, onError) {
  const tagToken = props.tag;
  const tagName = !tagToken ? null : ctx.directives.tagName(tagToken.source, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg));
  if (token.type === "block-seq") {
    const { anchor, newlineAfterProp: nl } = props;
    const lastProp = anchor && tagToken ? anchor.offset > tagToken.offset ? anchor : tagToken : anchor ?? tagToken;
    if (lastProp && (!nl || nl.offset < lastProp.offset)) {
      const message = "Missing newline after block sequence props";
      onError(lastProp, "MISSING_CHAR", message);
    }
  }
  const expType = token.type === "block-map" ? "map" : token.type === "block-seq" ? "seq" : token.start.source === "{" ? "map" : "seq";
  if (!tagToken || !tagName || tagName === "!" || tagName === YAMLMap.tagName && expType === "map" || tagName === YAMLSeq.tagName && expType === "seq") {
    return resolveCollection(CN2, ctx, token, onError, tagName);
  }
  let tag = ctx.schema.tags.find((t) => t.tag === tagName && t.collection === expType);
  if (!tag) {
    const kt = ctx.schema.knownTags[tagName];
    if (kt && kt.collection === expType) {
      ctx.schema.tags.push(Object.assign({}, kt, { default: false }));
      tag = kt;
    } else {
      if (kt) {
        onError(tagToken, "BAD_COLLECTION_TYPE", `${kt.tag} used for ${expType} collection, but expects ${kt.collection ?? "scalar"}`, true);
      } else {
        onError(tagToken, "TAG_RESOLVE_FAILED", `Unresolved tag: ${tagName}`, true);
      }
      return resolveCollection(CN2, ctx, token, onError, tagName);
    }
  }
  const coll = resolveCollection(CN2, ctx, token, onError, tagName, tag);
  const res = tag.resolve?.(coll, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg), ctx.options) ?? coll;
  const node = isNode(res) ? res : new Scalar(res);
  node.range = coll.range;
  node.tag = tagName;
  if (tag?.format)
    node.format = tag.format;
  return node;
}
__name(composeCollection, "composeCollection");

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/compose/resolve-block-scalar.js
function resolveBlockScalar(ctx, scalar, onError) {
  const start = scalar.offset;
  const header = parseBlockScalarHeader(scalar, ctx.options.strict, onError);
  if (!header)
    return { value: "", type: null, comment: "", range: [start, start, start] };
  const type = header.mode === ">" ? Scalar.BLOCK_FOLDED : Scalar.BLOCK_LITERAL;
  const lines = scalar.source ? splitLines(scalar.source) : [];
  let chompStart = lines.length;
  for (let i = lines.length - 1; i >= 0; --i) {
    const content = lines[i][1];
    if (content === "" || content === "\r")
      chompStart = i;
    else
      break;
  }
  if (chompStart === 0) {
    const value2 = header.chomp === "+" && lines.length > 0 ? "\n".repeat(Math.max(1, lines.length - 1)) : "";
    let end2 = start + header.length;
    if (scalar.source)
      end2 += scalar.source.length;
    return { value: value2, type, comment: header.comment, range: [start, end2, end2] };
  }
  let trimIndent = scalar.indent + header.indent;
  let offset = scalar.offset + header.length;
  let contentStart = 0;
  for (let i = 0; i < chompStart; ++i) {
    const [indent, content] = lines[i];
    if (content === "" || content === "\r") {
      if (header.indent === 0 && indent.length > trimIndent)
        trimIndent = indent.length;
    } else {
      if (indent.length < trimIndent) {
        const message = "Block scalars with more-indented leading empty lines must use an explicit indentation indicator";
        onError(offset + indent.length, "MISSING_CHAR", message);
      }
      if (header.indent === 0)
        trimIndent = indent.length;
      contentStart = i;
      if (trimIndent === 0 && !ctx.atRoot) {
        const message = "Block scalar values in collections must be indented";
        onError(offset, "BAD_INDENT", message);
      }
      break;
    }
    offset += indent.length + content.length + 1;
  }
  for (let i = lines.length - 1; i >= chompStart; --i) {
    if (lines[i][0].length > trimIndent)
      chompStart = i + 1;
  }
  let value = "";
  let sep = "";
  let prevMoreIndented = false;
  for (let i = 0; i < contentStart; ++i)
    value += lines[i][0].slice(trimIndent) + "\n";
  for (let i = contentStart; i < chompStart; ++i) {
    let [indent, content] = lines[i];
    offset += indent.length + content.length + 1;
    const crlf = content[content.length - 1] === "\r";
    if (crlf)
      content = content.slice(0, -1);
    if (content && indent.length < trimIndent) {
      const src = header.indent ? "explicit indentation indicator" : "first line";
      const message = `Block scalar lines must not be less indented than their ${src}`;
      onError(offset - content.length - (crlf ? 2 : 1), "BAD_INDENT", message);
      indent = "";
    }
    if (type === Scalar.BLOCK_LITERAL) {
      value += sep + indent.slice(trimIndent) + content;
      sep = "\n";
    } else if (indent.length > trimIndent || content[0] === "	") {
      if (sep === " ")
        sep = "\n";
      else if (!prevMoreIndented && sep === "\n")
        sep = "\n\n";
      value += sep + indent.slice(trimIndent) + content;
      sep = "\n";
      prevMoreIndented = true;
    } else if (content === "") {
      if (sep === "\n")
        value += "\n";
      else
        sep = "\n";
    } else {
      value += sep + content;
      sep = " ";
      prevMoreIndented = false;
    }
  }
  switch (header.chomp) {
    case "-":
      break;
    case "+":
      for (let i = chompStart; i < lines.length; ++i)
        value += "\n" + lines[i][0].slice(trimIndent);
      if (value[value.length - 1] !== "\n")
        value += "\n";
      break;
    default:
      value += "\n";
  }
  const end = start + header.length + scalar.source.length;
  return { value, type, comment: header.comment, range: [start, end, end] };
}
__name(resolveBlockScalar, "resolveBlockScalar");
function parseBlockScalarHeader({ offset, props }, strict, onError) {
  if (props[0].type !== "block-scalar-header") {
    onError(props[0], "IMPOSSIBLE", "Block scalar header not found");
    return null;
  }
  const { source } = props[0];
  const mode = source[0];
  let indent = 0;
  let chomp = "";
  let error = -1;
  for (let i = 1; i < source.length; ++i) {
    const ch = source[i];
    if (!chomp && (ch === "-" || ch === "+"))
      chomp = ch;
    else {
      const n = Number(ch);
      if (!indent && n)
        indent = n;
      else if (error === -1)
        error = offset + i;
    }
  }
  if (error !== -1)
    onError(error, "UNEXPECTED_TOKEN", `Block scalar header includes extra characters: ${source}`);
  let hasSpace = false;
  let comment = "";
  let length = source.length;
  for (let i = 1; i < props.length; ++i) {
    const token = props[i];
    switch (token.type) {
      case "space":
        hasSpace = true;
      // fallthrough
      case "newline":
        length += token.source.length;
        break;
      case "comment":
        if (strict && !hasSpace) {
          const message = "Comments must be separated from other tokens by white space characters";
          onError(token, "MISSING_CHAR", message);
        }
        length += token.source.length;
        comment = token.source.substring(1);
        break;
      case "error":
        onError(token, "UNEXPECTED_TOKEN", token.message);
        length += token.source.length;
        break;
      /* istanbul ignore next should not happen */
      default: {
        const message = `Unexpected token in block scalar header: ${token.type}`;
        onError(token, "UNEXPECTED_TOKEN", message);
        const ts = token.source;
        if (ts && typeof ts === "string")
          length += ts.length;
      }
    }
  }
  return { mode, indent, chomp, comment, length };
}
__name(parseBlockScalarHeader, "parseBlockScalarHeader");
function splitLines(source) {
  const split = source.split(/\n( *)/);
  const first = split[0];
  const m = first.match(/^( *)/);
  const line0 = m?.[1] ? [m[1], first.slice(m[1].length)] : ["", first];
  const lines = [line0];
  for (let i = 1; i < split.length; i += 2)
    lines.push([split[i], split[i + 1]]);
  return lines;
}
__name(splitLines, "splitLines");

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/compose/resolve-flow-scalar.js
function resolveFlowScalar(scalar, strict, onError) {
  const { offset, type, source, end } = scalar;
  let _type;
  let value;
  const _onError = /* @__PURE__ */ __name((rel, code, msg) => onError(offset + rel, code, msg), "_onError");
  switch (type) {
    case "scalar":
      _type = Scalar.PLAIN;
      value = plainValue(source, _onError);
      break;
    case "single-quoted-scalar":
      _type = Scalar.QUOTE_SINGLE;
      value = singleQuotedValue(source, _onError);
      break;
    case "double-quoted-scalar":
      _type = Scalar.QUOTE_DOUBLE;
      value = doubleQuotedValue(source, _onError);
      break;
    /* istanbul ignore next should not happen */
    default:
      onError(scalar, "UNEXPECTED_TOKEN", `Expected a flow scalar value, but found: ${type}`);
      return {
        value: "",
        type: null,
        comment: "",
        range: [offset, offset + source.length, offset + source.length]
      };
  }
  const valueEnd = offset + source.length;
  const re = resolveEnd(end, valueEnd, strict, onError);
  return {
    value,
    type: _type,
    comment: re.comment,
    range: [offset, valueEnd, re.offset]
  };
}
__name(resolveFlowScalar, "resolveFlowScalar");
function plainValue(source, onError) {
  let badChar = "";
  switch (source[0]) {
    /* istanbul ignore next should not happen */
    case "	":
      badChar = "a tab character";
      break;
    case ",":
      badChar = "flow indicator character ,";
      break;
    case "%":
      badChar = "directive indicator character %";
      break;
    case "|":
    case ">": {
      badChar = `block scalar indicator ${source[0]}`;
      break;
    }
    case "@":
    case "`": {
      badChar = `reserved character ${source[0]}`;
      break;
    }
  }
  if (badChar)
    onError(0, "BAD_SCALAR_START", `Plain value cannot start with ${badChar}`);
  return foldLines(source);
}
__name(plainValue, "plainValue");
function singleQuotedValue(source, onError) {
  if (source[source.length - 1] !== "'" || source.length === 1)
    onError(source.length, "MISSING_CHAR", "Missing closing 'quote");
  return foldLines(source.slice(1, -1)).replace(/''/g, "'");
}
__name(singleQuotedValue, "singleQuotedValue");
function foldLines(source) {
  let first, line;
  try {
    first = new RegExp("(.*?)(?<![ 	])[ 	]*\r?\n", "sy");
    line = new RegExp("[ 	]*(.*?)(?:(?<![ 	])[ 	]*)?\r?\n", "sy");
  } catch {
    first = /(.*?)[ \t]*\r?\n/sy;
    line = /[ \t]*(.*?)[ \t]*\r?\n/sy;
  }
  let match2 = first.exec(source);
  if (!match2)
    return source;
  let res = match2[1];
  let sep = " ";
  let pos = first.lastIndex;
  line.lastIndex = pos;
  while (match2 = line.exec(source)) {
    if (match2[1] === "") {
      if (sep === "\n")
        res += sep;
      else
        sep = "\n";
    } else {
      res += sep + match2[1];
      sep = " ";
    }
    pos = line.lastIndex;
  }
  const last = /[ \t]*(.*)/sy;
  last.lastIndex = pos;
  match2 = last.exec(source);
  return res + sep + (match2?.[1] ?? "");
}
__name(foldLines, "foldLines");
function doubleQuotedValue(source, onError) {
  let res = "";
  for (let i = 1; i < source.length - 1; ++i) {
    const ch = source[i];
    if (ch === "\r" && source[i + 1] === "\n")
      continue;
    if (ch === "\n") {
      const { fold, offset } = foldNewline(source, i);
      res += fold;
      i = offset;
    } else if (ch === "\\") {
      let next = source[++i];
      const cc = escapeCodes[next];
      if (cc)
        res += cc;
      else if (next === "\n") {
        next = source[i + 1];
        while (next === " " || next === "	")
          next = source[++i + 1];
      } else if (next === "\r" && source[i + 1] === "\n") {
        next = source[++i + 1];
        while (next === " " || next === "	")
          next = source[++i + 1];
      } else if (next === "x" || next === "u" || next === "U") {
        const length = { x: 2, u: 4, U: 8 }[next];
        res += parseCharCode(source, i + 1, length, onError);
        i += length;
      } else {
        const raw2 = source.substr(i - 1, 2);
        onError(i - 1, "BAD_DQ_ESCAPE", `Invalid escape sequence ${raw2}`);
        res += raw2;
      }
    } else if (ch === " " || ch === "	") {
      const wsStart = i;
      let next = source[i + 1];
      while (next === " " || next === "	")
        next = source[++i + 1];
      if (next !== "\n" && !(next === "\r" && source[i + 2] === "\n"))
        res += i > wsStart ? source.slice(wsStart, i + 1) : ch;
    } else {
      res += ch;
    }
  }
  if (source[source.length - 1] !== '"' || source.length === 1)
    onError(source.length, "MISSING_CHAR", 'Missing closing "quote');
  return res;
}
__name(doubleQuotedValue, "doubleQuotedValue");
function foldNewline(source, offset) {
  let fold = "";
  let ch = source[offset + 1];
  while (ch === " " || ch === "	" || ch === "\n" || ch === "\r") {
    if (ch === "\r" && source[offset + 2] !== "\n")
      break;
    if (ch === "\n")
      fold += "\n";
    offset += 1;
    ch = source[offset + 1];
  }
  if (!fold)
    fold = " ";
  return { fold, offset };
}
__name(foldNewline, "foldNewline");
var escapeCodes = {
  "0": "\0",
  // null character
  a: "\x07",
  // bell character
  b: "\b",
  // backspace
  e: "\x1B",
  // escape character
  f: "\f",
  // form feed
  n: "\n",
  // line feed
  r: "\r",
  // carriage return
  t: "	",
  // horizontal tab
  v: "\v",
  // vertical tab
  N: "\x85",
  // Unicode next line
  _: "\xA0",
  // Unicode non-breaking space
  L: "\u2028",
  // Unicode line separator
  P: "\u2029",
  // Unicode paragraph separator
  " ": " ",
  '"': '"',
  "/": "/",
  "\\": "\\",
  "	": "	"
};
function parseCharCode(source, offset, length, onError) {
  const cc = source.substr(offset, length);
  const ok = cc.length === length && /^[0-9a-fA-F]+$/.test(cc);
  const code = ok ? parseInt(cc, 16) : NaN;
  if (isNaN(code)) {
    const raw2 = source.substr(offset - 2, length + 2);
    onError(offset - 2, "BAD_DQ_ESCAPE", `Invalid escape sequence ${raw2}`);
    return raw2;
  }
  return String.fromCodePoint(code);
}
__name(parseCharCode, "parseCharCode");

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/compose/compose-scalar.js
function composeScalar(ctx, token, tagToken, onError) {
  const { value, type, comment, range } = token.type === "block-scalar" ? resolveBlockScalar(ctx, token, onError) : resolveFlowScalar(token, ctx.options.strict, onError);
  const tagName = tagToken ? ctx.directives.tagName(tagToken.source, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg)) : null;
  let tag;
  if (ctx.options.stringKeys && ctx.atKey) {
    tag = ctx.schema[SCALAR];
  } else if (tagName)
    tag = findScalarTagByName(ctx.schema, value, tagName, tagToken, onError);
  else if (token.type === "scalar")
    tag = findScalarTagByTest(ctx, value, token, onError);
  else
    tag = ctx.schema[SCALAR];
  let scalar;
  try {
    const res = tag.resolve(value, (msg) => onError(tagToken ?? token, "TAG_RESOLVE_FAILED", msg), ctx.options);
    scalar = isScalar(res) ? res : new Scalar(res);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    onError(tagToken ?? token, "TAG_RESOLVE_FAILED", msg);
    scalar = new Scalar(value);
  }
  scalar.range = range;
  scalar.source = value;
  if (type)
    scalar.type = type;
  if (tagName)
    scalar.tag = tagName;
  if (tag.format)
    scalar.format = tag.format;
  if (comment)
    scalar.comment = comment;
  return scalar;
}
__name(composeScalar, "composeScalar");
function findScalarTagByName(schema4, value, tagName, tagToken, onError) {
  if (tagName === "!")
    return schema4[SCALAR];
  const matchWithTest = [];
  for (const tag of schema4.tags) {
    if (!tag.collection && tag.tag === tagName) {
      if (tag.default && tag.test)
        matchWithTest.push(tag);
      else
        return tag;
    }
  }
  for (const tag of matchWithTest)
    if (tag.test?.test(value))
      return tag;
  const kt = schema4.knownTags[tagName];
  if (kt && !kt.collection) {
    schema4.tags.push(Object.assign({}, kt, { default: false, test: void 0 }));
    return kt;
  }
  onError(tagToken, "TAG_RESOLVE_FAILED", `Unresolved tag: ${tagName}`, tagName !== "tag:yaml.org,2002:str");
  return schema4[SCALAR];
}
__name(findScalarTagByName, "findScalarTagByName");
function findScalarTagByTest({ atKey, directives, schema: schema4 }, value, token, onError) {
  const tag = schema4.tags.find((tag2) => (tag2.default === true || atKey && tag2.default === "key") && tag2.test?.test(value)) || schema4[SCALAR];
  if (schema4.compat) {
    const compat = schema4.compat.find((tag2) => tag2.default && tag2.test?.test(value)) ?? schema4[SCALAR];
    if (tag.tag !== compat.tag) {
      const ts = directives.tagString(tag.tag);
      const cs = directives.tagString(compat.tag);
      const msg = `Value may be parsed as either ${ts} or ${cs}`;
      onError(token, "TAG_RESOLVE_FAILED", msg, true);
    }
  }
  return tag;
}
__name(findScalarTagByTest, "findScalarTagByTest");

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/compose/util-empty-scalar-position.js
function emptyScalarPosition(offset, before, pos) {
  if (before) {
    if (pos === null)
      pos = before.length;
    for (let i = pos - 1; i >= 0; --i) {
      let st = before[i];
      switch (st.type) {
        case "space":
        case "comment":
        case "newline":
          offset -= st.source.length;
          continue;
      }
      st = before[++i];
      while (st?.type === "space") {
        offset += st.source.length;
        st = before[++i];
      }
      break;
    }
  }
  return offset;
}
__name(emptyScalarPosition, "emptyScalarPosition");

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/compose/compose-node.js
var CN = { composeNode, composeEmptyNode };
function composeNode(ctx, token, props, onError) {
  const atKey = ctx.atKey;
  const { spaceBefore, comment, anchor, tag } = props;
  let node;
  let isSrcToken = true;
  switch (token.type) {
    case "alias":
      node = composeAlias(ctx, token, onError);
      if (anchor || tag)
        onError(token, "ALIAS_PROPS", "An alias node must not specify any properties");
      break;
    case "scalar":
    case "single-quoted-scalar":
    case "double-quoted-scalar":
    case "block-scalar":
      node = composeScalar(ctx, token, tag, onError);
      if (anchor)
        node.anchor = anchor.source.substring(1);
      break;
    case "block-map":
    case "block-seq":
    case "flow-collection":
      node = composeCollection(CN, ctx, token, props, onError);
      if (anchor)
        node.anchor = anchor.source.substring(1);
      break;
    default: {
      const message = token.type === "error" ? token.message : `Unsupported token (type: ${token.type})`;
      onError(token, "UNEXPECTED_TOKEN", message);
      node = composeEmptyNode(ctx, token.offset, void 0, null, props, onError);
      isSrcToken = false;
    }
  }
  if (anchor && node.anchor === "")
    onError(anchor, "BAD_ALIAS", "Anchor cannot be an empty string");
  if (atKey && ctx.options.stringKeys && (!isScalar(node) || typeof node.value !== "string" || node.tag && node.tag !== "tag:yaml.org,2002:str")) {
    const msg = "With stringKeys, all keys must be strings";
    onError(tag ?? token, "NON_STRING_KEY", msg);
  }
  if (spaceBefore)
    node.spaceBefore = true;
  if (comment) {
    if (token.type === "scalar" && token.source === "")
      node.comment = comment;
    else
      node.commentBefore = comment;
  }
  if (ctx.options.keepSourceTokens && isSrcToken)
    node.srcToken = token;
  return node;
}
__name(composeNode, "composeNode");
function composeEmptyNode(ctx, offset, before, pos, { spaceBefore, comment, anchor, tag, end }, onError) {
  const token = {
    type: "scalar",
    offset: emptyScalarPosition(offset, before, pos),
    indent: -1,
    source: ""
  };
  const node = composeScalar(ctx, token, tag, onError);
  if (anchor) {
    node.anchor = anchor.source.substring(1);
    if (node.anchor === "")
      onError(anchor, "BAD_ALIAS", "Anchor cannot be an empty string");
  }
  if (spaceBefore)
    node.spaceBefore = true;
  if (comment) {
    node.comment = comment;
    node.range[2] = end;
  }
  return node;
}
__name(composeEmptyNode, "composeEmptyNode");
function composeAlias({ options }, { offset, source, end }, onError) {
  const alias = new Alias(source.substring(1));
  if (alias.source === "")
    onError(offset, "BAD_ALIAS", "Alias cannot be an empty string");
  if (alias.source.endsWith(":"))
    onError(offset + source.length - 1, "BAD_ALIAS", "Alias ending in : is ambiguous", true);
  const valueEnd = offset + source.length;
  const re = resolveEnd(end, valueEnd, options.strict, onError);
  alias.range = [offset, valueEnd, re.offset];
  if (re.comment)
    alias.comment = re.comment;
  return alias;
}
__name(composeAlias, "composeAlias");

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/compose/compose-doc.js
function composeDoc(options, directives, { offset, start, value, end }, onError) {
  const opts = Object.assign({ _directives: directives }, options);
  const doc = new Document(void 0, opts);
  const ctx = {
    atKey: false,
    atRoot: true,
    directives: doc.directives,
    options: doc.options,
    schema: doc.schema
  };
  const props = resolveProps(start, {
    indicator: "doc-start",
    next: value ?? end?.[0],
    offset,
    onError,
    parentIndent: 0,
    startOnNewline: true
  });
  if (props.found) {
    doc.directives.docStart = true;
    if (value && (value.type === "block-map" || value.type === "block-seq") && !props.hasNewline)
      onError(props.end, "MISSING_CHAR", "Block collection cannot start on same line with directives-end marker");
  }
  doc.contents = value ? composeNode(ctx, value, props, onError) : composeEmptyNode(ctx, props.end, start, null, props, onError);
  const contentEnd = doc.contents.range[2];
  const re = resolveEnd(end, contentEnd, false, onError);
  if (re.comment)
    doc.comment = re.comment;
  doc.range = [offset, contentEnd, re.offset];
  return doc;
}
__name(composeDoc, "composeDoc");

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/compose/composer.js
function getErrorPos(src) {
  if (typeof src === "number")
    return [src, src + 1];
  if (Array.isArray(src))
    return src.length === 2 ? src : [src[0], src[1]];
  const { offset, source } = src;
  return [offset, offset + (typeof source === "string" ? source.length : 1)];
}
__name(getErrorPos, "getErrorPos");
function parsePrelude(prelude) {
  let comment = "";
  let atComment = false;
  let afterEmptyLine = false;
  for (let i = 0; i < prelude.length; ++i) {
    const source = prelude[i];
    switch (source[0]) {
      case "#":
        comment += (comment === "" ? "" : afterEmptyLine ? "\n\n" : "\n") + (source.substring(1) || " ");
        atComment = true;
        afterEmptyLine = false;
        break;
      case "%":
        if (prelude[i + 1]?.[0] !== "#")
          i += 1;
        atComment = false;
        break;
      default:
        if (!atComment)
          afterEmptyLine = true;
        atComment = false;
    }
  }
  return { comment, afterEmptyLine };
}
__name(parsePrelude, "parsePrelude");
var Composer = class {
  static {
    __name(this, "Composer");
  }
  constructor(options = {}) {
    this.doc = null;
    this.atDirectives = false;
    this.prelude = [];
    this.errors = [];
    this.warnings = [];
    this.onError = (source, code, message, warning) => {
      const pos = getErrorPos(source);
      if (warning)
        this.warnings.push(new YAMLWarning(pos, code, message));
      else
        this.errors.push(new YAMLParseError(pos, code, message));
    };
    this.directives = new Directives({ version: options.version || "1.2" });
    this.options = options;
  }
  decorate(doc, afterDoc) {
    const { comment, afterEmptyLine } = parsePrelude(this.prelude);
    if (comment) {
      const dc = doc.contents;
      if (afterDoc) {
        doc.comment = doc.comment ? `${doc.comment}
${comment}` : comment;
      } else if (afterEmptyLine || doc.directives.docStart || !dc) {
        doc.commentBefore = comment;
      } else if (isCollection(dc) && !dc.flow && dc.items.length > 0) {
        let it = dc.items[0];
        if (isPair(it))
          it = it.key;
        const cb = it.commentBefore;
        it.commentBefore = cb ? `${comment}
${cb}` : comment;
      } else {
        const cb = dc.commentBefore;
        dc.commentBefore = cb ? `${comment}
${cb}` : comment;
      }
    }
    if (afterDoc) {
      Array.prototype.push.apply(doc.errors, this.errors);
      Array.prototype.push.apply(doc.warnings, this.warnings);
    } else {
      doc.errors = this.errors;
      doc.warnings = this.warnings;
    }
    this.prelude = [];
    this.errors = [];
    this.warnings = [];
  }
  /**
   * Current stream status information.
   *
   * Mostly useful at the end of input for an empty stream.
   */
  streamInfo() {
    return {
      comment: parsePrelude(this.prelude).comment,
      directives: this.directives,
      errors: this.errors,
      warnings: this.warnings
    };
  }
  /**
   * Compose tokens into documents.
   *
   * @param forceDoc - If the stream contains no document, still emit a final document including any comments and directives that would be applied to a subsequent document.
   * @param endOffset - Should be set if `forceDoc` is also set, to set the document range end and to indicate errors correctly.
   */
  *compose(tokens, forceDoc = false, endOffset = -1) {
    for (const token of tokens)
      yield* this.next(token);
    yield* this.end(forceDoc, endOffset);
  }
  /** Advance the composer by one CST token. */
  *next(token) {
    switch (token.type) {
      case "directive":
        this.directives.add(token.source, (offset, message, warning) => {
          const pos = getErrorPos(token);
          pos[0] += offset;
          this.onError(pos, "BAD_DIRECTIVE", message, warning);
        });
        this.prelude.push(token.source);
        this.atDirectives = true;
        break;
      case "document": {
        const doc = composeDoc(this.options, this.directives, token, this.onError);
        if (this.atDirectives && !doc.directives.docStart)
          this.onError(token, "MISSING_CHAR", "Missing directives-end/doc-start indicator line");
        this.decorate(doc, false);
        if (this.doc)
          yield this.doc;
        this.doc = doc;
        this.atDirectives = false;
        break;
      }
      case "byte-order-mark":
      case "space":
        break;
      case "comment":
      case "newline":
        this.prelude.push(token.source);
        break;
      case "error": {
        const msg = token.source ? `${token.message}: ${JSON.stringify(token.source)}` : token.message;
        const error = new YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", msg);
        if (this.atDirectives || !this.doc)
          this.errors.push(error);
        else
          this.doc.errors.push(error);
        break;
      }
      case "doc-end": {
        if (!this.doc) {
          const msg = "Unexpected doc-end without preceding document";
          this.errors.push(new YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", msg));
          break;
        }
        this.doc.directives.docEnd = true;
        const end = resolveEnd(token.end, token.offset + token.source.length, this.doc.options.strict, this.onError);
        this.decorate(this.doc, true);
        if (end.comment) {
          const dc = this.doc.comment;
          this.doc.comment = dc ? `${dc}
${end.comment}` : end.comment;
        }
        this.doc.range[2] = end.offset;
        break;
      }
      default:
        this.errors.push(new YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", `Unsupported token ${token.type}`));
    }
  }
  /**
   * Call at end of input to yield any remaining document.
   *
   * @param forceDoc - If the stream contains no document, still emit a final document including any comments and directives that would be applied to a subsequent document.
   * @param endOffset - Should be set if `forceDoc` is also set, to set the document range end and to indicate errors correctly.
   */
  *end(forceDoc = false, endOffset = -1) {
    if (this.doc) {
      this.decorate(this.doc, true);
      yield this.doc;
      this.doc = null;
    } else if (forceDoc) {
      const opts = Object.assign({ _directives: this.directives }, this.options);
      const doc = new Document(void 0, opts);
      if (this.atDirectives)
        this.onError(endOffset, "MISSING_CHAR", "Missing directives-end indicator line");
      doc.range = [0, endOffset, endOffset];
      this.decorate(doc, false);
      yield doc;
    }
  }
};

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/parse/cst-visit.js
var BREAK2 = /* @__PURE__ */ Symbol("break visit");
var SKIP2 = /* @__PURE__ */ Symbol("skip children");
var REMOVE2 = /* @__PURE__ */ Symbol("remove item");
function visit2(cst, visitor) {
  if ("type" in cst && cst.type === "document")
    cst = { start: cst.start, value: cst.value };
  _visit(Object.freeze([]), cst, visitor);
}
__name(visit2, "visit");
visit2.BREAK = BREAK2;
visit2.SKIP = SKIP2;
visit2.REMOVE = REMOVE2;
visit2.itemAtPath = (cst, path) => {
  let item = cst;
  for (const [field, index] of path) {
    const tok = item?.[field];
    if (tok && "items" in tok) {
      item = tok.items[index];
    } else
      return void 0;
  }
  return item;
};
visit2.parentCollection = (cst, path) => {
  const parent = visit2.itemAtPath(cst, path.slice(0, -1));
  const field = path[path.length - 1][0];
  const coll = parent?.[field];
  if (coll && "items" in coll)
    return coll;
  throw new Error("Parent collection not found");
};
function _visit(path, item, visitor) {
  let ctrl = visitor(item, path);
  if (typeof ctrl === "symbol")
    return ctrl;
  for (const field of ["key", "value"]) {
    const token = item[field];
    if (token && "items" in token) {
      for (let i = 0; i < token.items.length; ++i) {
        const ci = _visit(Object.freeze(path.concat([[field, i]])), token.items[i], visitor);
        if (typeof ci === "number")
          i = ci - 1;
        else if (ci === BREAK2)
          return BREAK2;
        else if (ci === REMOVE2) {
          token.items.splice(i, 1);
          i -= 1;
        }
      }
      if (typeof ctrl === "function" && field === "key")
        ctrl = ctrl(item, path);
    }
  }
  return typeof ctrl === "function" ? ctrl(item, path) : ctrl;
}
__name(_visit, "_visit");

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/parse/cst.js
var BOM = "\uFEFF";
var DOCUMENT = "";
var FLOW_END = "";
var SCALAR2 = "";
function tokenType(source) {
  switch (source) {
    case BOM:
      return "byte-order-mark";
    case DOCUMENT:
      return "doc-mode";
    case FLOW_END:
      return "flow-error-end";
    case SCALAR2:
      return "scalar";
    case "---":
      return "doc-start";
    case "...":
      return "doc-end";
    case "":
    case "\n":
    case "\r\n":
      return "newline";
    case "-":
      return "seq-item-ind";
    case "?":
      return "explicit-key-ind";
    case ":":
      return "map-value-ind";
    case "{":
      return "flow-map-start";
    case "}":
      return "flow-map-end";
    case "[":
      return "flow-seq-start";
    case "]":
      return "flow-seq-end";
    case ",":
      return "comma";
  }
  switch (source[0]) {
    case " ":
    case "	":
      return "space";
    case "#":
      return "comment";
    case "%":
      return "directive-line";
    case "*":
      return "alias";
    case "&":
      return "anchor";
    case "!":
      return "tag";
    case "'":
      return "single-quoted-scalar";
    case '"':
      return "double-quoted-scalar";
    case "|":
    case ">":
      return "block-scalar-header";
  }
  return null;
}
__name(tokenType, "tokenType");

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/parse/lexer.js
function isEmpty(ch) {
  switch (ch) {
    case void 0:
    case " ":
    case "\n":
    case "\r":
    case "	":
      return true;
    default:
      return false;
  }
}
__name(isEmpty, "isEmpty");
var hexDigits = new Set("0123456789ABCDEFabcdef");
var tagChars = new Set("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-#;/?:@&=+$_.!~*'()");
var flowIndicatorChars = new Set(",[]{}");
var invalidAnchorChars = new Set(" ,[]{}\n\r	");
var isNotAnchorChar = /* @__PURE__ */ __name((ch) => !ch || invalidAnchorChars.has(ch), "isNotAnchorChar");
var Lexer = class {
  static {
    __name(this, "Lexer");
  }
  constructor() {
    this.atEnd = false;
    this.blockScalarIndent = -1;
    this.blockScalarKeep = false;
    this.buffer = "";
    this.flowKey = false;
    this.flowLevel = 0;
    this.indentNext = 0;
    this.indentValue = 0;
    this.lineEndPos = null;
    this.next = null;
    this.pos = 0;
  }
  /**
   * Generate YAML tokens from the `source` string. If `incomplete`,
   * a part of the last line may be left as a buffer for the next call.
   *
   * @returns A generator of lexical tokens
   */
  *lex(source, incomplete = false) {
    if (source) {
      if (typeof source !== "string")
        throw TypeError("source is not a string");
      this.buffer = this.buffer ? this.buffer + source : source;
      this.lineEndPos = null;
    }
    this.atEnd = !incomplete;
    let next = this.next ?? "stream";
    while (next && (incomplete || this.hasChars(1)))
      next = yield* this.parseNext(next);
  }
  atLineEnd() {
    let i = this.pos;
    let ch = this.buffer[i];
    while (ch === " " || ch === "	")
      ch = this.buffer[++i];
    if (!ch || ch === "#" || ch === "\n")
      return true;
    if (ch === "\r")
      return this.buffer[i + 1] === "\n";
    return false;
  }
  charAt(n) {
    return this.buffer[this.pos + n];
  }
  continueScalar(offset) {
    let ch = this.buffer[offset];
    if (this.indentNext > 0) {
      let indent = 0;
      while (ch === " ")
        ch = this.buffer[++indent + offset];
      if (ch === "\r") {
        const next = this.buffer[indent + offset + 1];
        if (next === "\n" || !next && !this.atEnd)
          return offset + indent + 1;
      }
      return ch === "\n" || indent >= this.indentNext || !ch && !this.atEnd ? offset + indent : -1;
    }
    if (ch === "-" || ch === ".") {
      const dt = this.buffer.substr(offset, 3);
      if ((dt === "---" || dt === "...") && isEmpty(this.buffer[offset + 3]))
        return -1;
    }
    return offset;
  }
  getLine() {
    let end = this.lineEndPos;
    if (typeof end !== "number" || end !== -1 && end < this.pos) {
      end = this.buffer.indexOf("\n", this.pos);
      this.lineEndPos = end;
    }
    if (end === -1)
      return this.atEnd ? this.buffer.substring(this.pos) : null;
    if (this.buffer[end - 1] === "\r")
      end -= 1;
    return this.buffer.substring(this.pos, end);
  }
  hasChars(n) {
    return this.pos + n <= this.buffer.length;
  }
  setNext(state) {
    this.buffer = this.buffer.substring(this.pos);
    this.pos = 0;
    this.lineEndPos = null;
    this.next = state;
    return null;
  }
  peek(n) {
    return this.buffer.substr(this.pos, n);
  }
  *parseNext(next) {
    switch (next) {
      case "stream":
        return yield* this.parseStream();
      case "line-start":
        return yield* this.parseLineStart();
      case "block-start":
        return yield* this.parseBlockStart();
      case "doc":
        return yield* this.parseDocument();
      case "flow":
        return yield* this.parseFlowCollection();
      case "quoted-scalar":
        return yield* this.parseQuotedScalar();
      case "block-scalar":
        return yield* this.parseBlockScalar();
      case "plain-scalar":
        return yield* this.parsePlainScalar();
    }
  }
  *parseStream() {
    let line = this.getLine();
    if (line === null)
      return this.setNext("stream");
    if (line[0] === BOM) {
      yield* this.pushCount(1);
      line = line.substring(1);
    }
    if (line[0] === "%") {
      let dirEnd = line.length;
      let cs = line.indexOf("#");
      while (cs !== -1) {
        const ch = line[cs - 1];
        if (ch === " " || ch === "	") {
          dirEnd = cs - 1;
          break;
        } else {
          cs = line.indexOf("#", cs + 1);
        }
      }
      while (true) {
        const ch = line[dirEnd - 1];
        if (ch === " " || ch === "	")
          dirEnd -= 1;
        else
          break;
      }
      const n = (yield* this.pushCount(dirEnd)) + (yield* this.pushSpaces(true));
      yield* this.pushCount(line.length - n);
      this.pushNewline();
      return "stream";
    }
    if (this.atLineEnd()) {
      const sp = yield* this.pushSpaces(true);
      yield* this.pushCount(line.length - sp);
      yield* this.pushNewline();
      return "stream";
    }
    yield DOCUMENT;
    return yield* this.parseLineStart();
  }
  *parseLineStart() {
    const ch = this.charAt(0);
    if (!ch && !this.atEnd)
      return this.setNext("line-start");
    if (ch === "-" || ch === ".") {
      if (!this.atEnd && !this.hasChars(4))
        return this.setNext("line-start");
      const s = this.peek(3);
      if ((s === "---" || s === "...") && isEmpty(this.charAt(3))) {
        yield* this.pushCount(3);
        this.indentValue = 0;
        this.indentNext = 0;
        return s === "---" ? "doc" : "stream";
      }
    }
    this.indentValue = yield* this.pushSpaces(false);
    if (this.indentNext > this.indentValue && !isEmpty(this.charAt(1)))
      this.indentNext = this.indentValue;
    return yield* this.parseBlockStart();
  }
  *parseBlockStart() {
    const [ch0, ch1] = this.peek(2);
    if (!ch1 && !this.atEnd)
      return this.setNext("block-start");
    if ((ch0 === "-" || ch0 === "?" || ch0 === ":") && isEmpty(ch1)) {
      const n = (yield* this.pushCount(1)) + (yield* this.pushSpaces(true));
      this.indentNext = this.indentValue + 1;
      this.indentValue += n;
      return yield* this.parseBlockStart();
    }
    return "doc";
  }
  *parseDocument() {
    yield* this.pushSpaces(true);
    const line = this.getLine();
    if (line === null)
      return this.setNext("doc");
    let n = yield* this.pushIndicators();
    switch (line[n]) {
      case "#":
        yield* this.pushCount(line.length - n);
      // fallthrough
      case void 0:
        yield* this.pushNewline();
        return yield* this.parseLineStart();
      case "{":
      case "[":
        yield* this.pushCount(1);
        this.flowKey = false;
        this.flowLevel = 1;
        return "flow";
      case "}":
      case "]":
        yield* this.pushCount(1);
        return "doc";
      case "*":
        yield* this.pushUntil(isNotAnchorChar);
        return "doc";
      case '"':
      case "'":
        return yield* this.parseQuotedScalar();
      case "|":
      case ">":
        n += yield* this.parseBlockScalarHeader();
        n += yield* this.pushSpaces(true);
        yield* this.pushCount(line.length - n);
        yield* this.pushNewline();
        return yield* this.parseBlockScalar();
      default:
        return yield* this.parsePlainScalar();
    }
  }
  *parseFlowCollection() {
    let nl, sp;
    let indent = -1;
    do {
      nl = yield* this.pushNewline();
      if (nl > 0) {
        sp = yield* this.pushSpaces(false);
        this.indentValue = indent = sp;
      } else {
        sp = 0;
      }
      sp += yield* this.pushSpaces(true);
    } while (nl + sp > 0);
    const line = this.getLine();
    if (line === null)
      return this.setNext("flow");
    if (indent !== -1 && indent < this.indentNext && line[0] !== "#" || indent === 0 && (line.startsWith("---") || line.startsWith("...")) && isEmpty(line[3])) {
      const atFlowEndMarker = indent === this.indentNext - 1 && this.flowLevel === 1 && (line[0] === "]" || line[0] === "}");
      if (!atFlowEndMarker) {
        this.flowLevel = 0;
        yield FLOW_END;
        return yield* this.parseLineStart();
      }
    }
    let n = 0;
    while (line[n] === ",") {
      n += yield* this.pushCount(1);
      n += yield* this.pushSpaces(true);
      this.flowKey = false;
    }
    n += yield* this.pushIndicators();
    switch (line[n]) {
      case void 0:
        return "flow";
      case "#":
        yield* this.pushCount(line.length - n);
        return "flow";
      case "{":
      case "[":
        yield* this.pushCount(1);
        this.flowKey = false;
        this.flowLevel += 1;
        return "flow";
      case "}":
      case "]":
        yield* this.pushCount(1);
        this.flowKey = true;
        this.flowLevel -= 1;
        return this.flowLevel ? "flow" : "doc";
      case "*":
        yield* this.pushUntil(isNotAnchorChar);
        return "flow";
      case '"':
      case "'":
        this.flowKey = true;
        return yield* this.parseQuotedScalar();
      case ":": {
        const next = this.charAt(1);
        if (this.flowKey || isEmpty(next) || next === ",") {
          this.flowKey = false;
          yield* this.pushCount(1);
          yield* this.pushSpaces(true);
          return "flow";
        }
      }
      // fallthrough
      default:
        this.flowKey = false;
        return yield* this.parsePlainScalar();
    }
  }
  *parseQuotedScalar() {
    const quote = this.charAt(0);
    let end = this.buffer.indexOf(quote, this.pos + 1);
    if (quote === "'") {
      while (end !== -1 && this.buffer[end + 1] === "'")
        end = this.buffer.indexOf("'", end + 2);
    } else {
      while (end !== -1) {
        let n = 0;
        while (this.buffer[end - 1 - n] === "\\")
          n += 1;
        if (n % 2 === 0)
          break;
        end = this.buffer.indexOf('"', end + 1);
      }
    }
    const qb = this.buffer.substring(0, end);
    let nl = qb.indexOf("\n", this.pos);
    if (nl !== -1) {
      while (nl !== -1) {
        const cs = this.continueScalar(nl + 1);
        if (cs === -1)
          break;
        nl = qb.indexOf("\n", cs);
      }
      if (nl !== -1) {
        end = nl - (qb[nl - 1] === "\r" ? 2 : 1);
      }
    }
    if (end === -1) {
      if (!this.atEnd)
        return this.setNext("quoted-scalar");
      end = this.buffer.length;
    }
    yield* this.pushToIndex(end + 1, false);
    return this.flowLevel ? "flow" : "doc";
  }
  *parseBlockScalarHeader() {
    this.blockScalarIndent = -1;
    this.blockScalarKeep = false;
    let i = this.pos;
    while (true) {
      const ch = this.buffer[++i];
      if (ch === "+")
        this.blockScalarKeep = true;
      else if (ch > "0" && ch <= "9")
        this.blockScalarIndent = Number(ch) - 1;
      else if (ch !== "-")
        break;
    }
    return yield* this.pushUntil((ch) => isEmpty(ch) || ch === "#");
  }
  *parseBlockScalar() {
    let nl = this.pos - 1;
    let indent = 0;
    let ch;
    loop: for (let i2 = this.pos; ch = this.buffer[i2]; ++i2) {
      switch (ch) {
        case " ":
          indent += 1;
          break;
        case "\n":
          nl = i2;
          indent = 0;
          break;
        case "\r": {
          const next = this.buffer[i2 + 1];
          if (!next && !this.atEnd)
            return this.setNext("block-scalar");
          if (next === "\n")
            break;
        }
        // fallthrough
        default:
          break loop;
      }
    }
    if (!ch && !this.atEnd)
      return this.setNext("block-scalar");
    if (indent >= this.indentNext) {
      if (this.blockScalarIndent === -1)
        this.indentNext = indent;
      else {
        this.indentNext = this.blockScalarIndent + (this.indentNext === 0 ? 1 : this.indentNext);
      }
      do {
        const cs = this.continueScalar(nl + 1);
        if (cs === -1)
          break;
        nl = this.buffer.indexOf("\n", cs);
      } while (nl !== -1);
      if (nl === -1) {
        if (!this.atEnd)
          return this.setNext("block-scalar");
        nl = this.buffer.length;
      }
    }
    let i = nl + 1;
    ch = this.buffer[i];
    while (ch === " ")
      ch = this.buffer[++i];
    if (ch === "	") {
      while (ch === "	" || ch === " " || ch === "\r" || ch === "\n")
        ch = this.buffer[++i];
      nl = i - 1;
    } else if (!this.blockScalarKeep) {
      do {
        let i2 = nl - 1;
        let ch2 = this.buffer[i2];
        if (ch2 === "\r")
          ch2 = this.buffer[--i2];
        const lastChar = i2;
        while (ch2 === " ")
          ch2 = this.buffer[--i2];
        if (ch2 === "\n" && i2 >= this.pos && i2 + 1 + indent > lastChar)
          nl = i2;
        else
          break;
      } while (true);
    }
    yield SCALAR2;
    yield* this.pushToIndex(nl + 1, true);
    return yield* this.parseLineStart();
  }
  *parsePlainScalar() {
    const inFlow = this.flowLevel > 0;
    let end = this.pos - 1;
    let i = this.pos - 1;
    let ch;
    while (ch = this.buffer[++i]) {
      if (ch === ":") {
        const next = this.buffer[i + 1];
        if (isEmpty(next) || inFlow && flowIndicatorChars.has(next))
          break;
        end = i;
      } else if (isEmpty(ch)) {
        let next = this.buffer[i + 1];
        if (ch === "\r") {
          if (next === "\n") {
            i += 1;
            ch = "\n";
            next = this.buffer[i + 1];
          } else
            end = i;
        }
        if (next === "#" || inFlow && flowIndicatorChars.has(next))
          break;
        if (ch === "\n") {
          const cs = this.continueScalar(i + 1);
          if (cs === -1)
            break;
          i = Math.max(i, cs - 2);
        }
      } else {
        if (inFlow && flowIndicatorChars.has(ch))
          break;
        end = i;
      }
    }
    if (!ch && !this.atEnd)
      return this.setNext("plain-scalar");
    yield SCALAR2;
    yield* this.pushToIndex(end + 1, true);
    return inFlow ? "flow" : "doc";
  }
  *pushCount(n) {
    if (n > 0) {
      yield this.buffer.substr(this.pos, n);
      this.pos += n;
      return n;
    }
    return 0;
  }
  *pushToIndex(i, allowEmpty) {
    const s = this.buffer.slice(this.pos, i);
    if (s) {
      yield s;
      this.pos += s.length;
      return s.length;
    } else if (allowEmpty)
      yield "";
    return 0;
  }
  *pushIndicators() {
    switch (this.charAt(0)) {
      case "!":
        return (yield* this.pushTag()) + (yield* this.pushSpaces(true)) + (yield* this.pushIndicators());
      case "&":
        return (yield* this.pushUntil(isNotAnchorChar)) + (yield* this.pushSpaces(true)) + (yield* this.pushIndicators());
      case "-":
      // this is an error
      case "?":
      // this is an error outside flow collections
      case ":": {
        const inFlow = this.flowLevel > 0;
        const ch1 = this.charAt(1);
        if (isEmpty(ch1) || inFlow && flowIndicatorChars.has(ch1)) {
          if (!inFlow)
            this.indentNext = this.indentValue + 1;
          else if (this.flowKey)
            this.flowKey = false;
          return (yield* this.pushCount(1)) + (yield* this.pushSpaces(true)) + (yield* this.pushIndicators());
        }
      }
    }
    return 0;
  }
  *pushTag() {
    if (this.charAt(1) === "<") {
      let i = this.pos + 2;
      let ch = this.buffer[i];
      while (!isEmpty(ch) && ch !== ">")
        ch = this.buffer[++i];
      return yield* this.pushToIndex(ch === ">" ? i + 1 : i, false);
    } else {
      let i = this.pos + 1;
      let ch = this.buffer[i];
      while (ch) {
        if (tagChars.has(ch))
          ch = this.buffer[++i];
        else if (ch === "%" && hexDigits.has(this.buffer[i + 1]) && hexDigits.has(this.buffer[i + 2])) {
          ch = this.buffer[i += 3];
        } else
          break;
      }
      return yield* this.pushToIndex(i, false);
    }
  }
  *pushNewline() {
    const ch = this.buffer[this.pos];
    if (ch === "\n")
      return yield* this.pushCount(1);
    else if (ch === "\r" && this.charAt(1) === "\n")
      return yield* this.pushCount(2);
    else
      return 0;
  }
  *pushSpaces(allowTabs) {
    let i = this.pos - 1;
    let ch;
    do {
      ch = this.buffer[++i];
    } while (ch === " " || allowTabs && ch === "	");
    const n = i - this.pos;
    if (n > 0) {
      yield this.buffer.substr(this.pos, n);
      this.pos = i;
    }
    return n;
  }
  *pushUntil(test) {
    let i = this.pos;
    let ch = this.buffer[i];
    while (!test(ch))
      ch = this.buffer[++i];
    return yield* this.pushToIndex(i, false);
  }
};

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/parse/line-counter.js
var LineCounter = class {
  static {
    __name(this, "LineCounter");
  }
  constructor() {
    this.lineStarts = [];
    this.addNewLine = (offset) => this.lineStarts.push(offset);
    this.linePos = (offset) => {
      let low = 0;
      let high = this.lineStarts.length;
      while (low < high) {
        const mid = low + high >> 1;
        if (this.lineStarts[mid] < offset)
          low = mid + 1;
        else
          high = mid;
      }
      if (this.lineStarts[low] === offset)
        return { line: low + 1, col: 1 };
      if (low === 0)
        return { line: 0, col: offset };
      const start = this.lineStarts[low - 1];
      return { line: low, col: offset - start + 1 };
    };
  }
};

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/parse/parser.js
function includesToken(list, type) {
  for (let i = 0; i < list.length; ++i)
    if (list[i].type === type)
      return true;
  return false;
}
__name(includesToken, "includesToken");
function findNonEmptyIndex(list) {
  for (let i = 0; i < list.length; ++i) {
    switch (list[i].type) {
      case "space":
      case "comment":
      case "newline":
        break;
      default:
        return i;
    }
  }
  return -1;
}
__name(findNonEmptyIndex, "findNonEmptyIndex");
function isFlowToken(token) {
  switch (token?.type) {
    case "alias":
    case "scalar":
    case "single-quoted-scalar":
    case "double-quoted-scalar":
    case "flow-collection":
      return true;
    default:
      return false;
  }
}
__name(isFlowToken, "isFlowToken");
function getPrevProps(parent) {
  switch (parent.type) {
    case "document":
      return parent.start;
    case "block-map": {
      const it = parent.items[parent.items.length - 1];
      return it.sep ?? it.start;
    }
    case "block-seq":
      return parent.items[parent.items.length - 1].start;
    /* istanbul ignore next should not happen */
    default:
      return [];
  }
}
__name(getPrevProps, "getPrevProps");
function getFirstKeyStartProps(prev) {
  if (prev.length === 0)
    return [];
  let i = prev.length;
  loop: while (--i >= 0) {
    switch (prev[i].type) {
      case "doc-start":
      case "explicit-key-ind":
      case "map-value-ind":
      case "seq-item-ind":
      case "newline":
        break loop;
    }
  }
  while (prev[++i]?.type === "space") {
  }
  return prev.splice(i, prev.length);
}
__name(getFirstKeyStartProps, "getFirstKeyStartProps");
function fixFlowSeqItems(fc) {
  if (fc.start.type === "flow-seq-start") {
    for (const it of fc.items) {
      if (it.sep && !it.value && !includesToken(it.start, "explicit-key-ind") && !includesToken(it.sep, "map-value-ind")) {
        if (it.key)
          it.value = it.key;
        delete it.key;
        if (isFlowToken(it.value)) {
          if (it.value.end)
            Array.prototype.push.apply(it.value.end, it.sep);
          else
            it.value.end = it.sep;
        } else
          Array.prototype.push.apply(it.start, it.sep);
        delete it.sep;
      }
    }
  }
}
__name(fixFlowSeqItems, "fixFlowSeqItems");
var Parser = class {
  static {
    __name(this, "Parser");
  }
  /**
   * @param onNewLine - If defined, called separately with the start position of
   *   each new line (in `parse()`, including the start of input).
   */
  constructor(onNewLine) {
    this.atNewLine = true;
    this.atScalar = false;
    this.indent = 0;
    this.offset = 0;
    this.onKeyLine = false;
    this.stack = [];
    this.source = "";
    this.type = "";
    this.lexer = new Lexer();
    this.onNewLine = onNewLine;
  }
  /**
   * Parse `source` as a YAML stream.
   * If `incomplete`, a part of the last line may be left as a buffer for the next call.
   *
   * Errors are not thrown, but yielded as `{ type: 'error', message }` tokens.
   *
   * @returns A generator of tokens representing each directive, document, and other structure.
   */
  *parse(source, incomplete = false) {
    if (this.onNewLine && this.offset === 0)
      this.onNewLine(0);
    for (const lexeme of this.lexer.lex(source, incomplete))
      yield* this.next(lexeme);
    if (!incomplete)
      yield* this.end();
  }
  /**
   * Advance the parser by the `source` of one lexical token.
   */
  *next(source) {
    this.source = source;
    if (this.atScalar) {
      this.atScalar = false;
      yield* this.step();
      this.offset += source.length;
      return;
    }
    const type = tokenType(source);
    if (!type) {
      const message = `Not a YAML token: ${source}`;
      yield* this.pop({ type: "error", offset: this.offset, message, source });
      this.offset += source.length;
    } else if (type === "scalar") {
      this.atNewLine = false;
      this.atScalar = true;
      this.type = "scalar";
    } else {
      this.type = type;
      yield* this.step();
      switch (type) {
        case "newline":
          this.atNewLine = true;
          this.indent = 0;
          if (this.onNewLine)
            this.onNewLine(this.offset + source.length);
          break;
        case "space":
          if (this.atNewLine && source[0] === " ")
            this.indent += source.length;
          break;
        case "explicit-key-ind":
        case "map-value-ind":
        case "seq-item-ind":
          if (this.atNewLine)
            this.indent += source.length;
          break;
        case "doc-mode":
        case "flow-error-end":
          return;
        default:
          this.atNewLine = false;
      }
      this.offset += source.length;
    }
  }
  /** Call at end of input to push out any remaining constructions */
  *end() {
    while (this.stack.length > 0)
      yield* this.pop();
  }
  get sourceToken() {
    const st = {
      type: this.type,
      offset: this.offset,
      indent: this.indent,
      source: this.source
    };
    return st;
  }
  *step() {
    const top = this.peek(1);
    if (this.type === "doc-end" && (!top || top.type !== "doc-end")) {
      while (this.stack.length > 0)
        yield* this.pop();
      this.stack.push({
        type: "doc-end",
        offset: this.offset,
        source: this.source
      });
      return;
    }
    if (!top)
      return yield* this.stream();
    switch (top.type) {
      case "document":
        return yield* this.document(top);
      case "alias":
      case "scalar":
      case "single-quoted-scalar":
      case "double-quoted-scalar":
        return yield* this.scalar(top);
      case "block-scalar":
        return yield* this.blockScalar(top);
      case "block-map":
        return yield* this.blockMap(top);
      case "block-seq":
        return yield* this.blockSequence(top);
      case "flow-collection":
        return yield* this.flowCollection(top);
      case "doc-end":
        return yield* this.documentEnd(top);
    }
    yield* this.pop();
  }
  peek(n) {
    return this.stack[this.stack.length - n];
  }
  *pop(error) {
    const token = error ?? this.stack.pop();
    if (!token) {
      const message = "Tried to pop an empty stack";
      yield { type: "error", offset: this.offset, source: "", message };
    } else if (this.stack.length === 0) {
      yield token;
    } else {
      const top = this.peek(1);
      if (token.type === "block-scalar") {
        token.indent = "indent" in top ? top.indent : 0;
      } else if (token.type === "flow-collection" && top.type === "document") {
        token.indent = 0;
      }
      if (token.type === "flow-collection")
        fixFlowSeqItems(token);
      switch (top.type) {
        case "document":
          top.value = token;
          break;
        case "block-scalar":
          top.props.push(token);
          break;
        case "block-map": {
          const it = top.items[top.items.length - 1];
          if (it.value) {
            top.items.push({ start: [], key: token, sep: [] });
            this.onKeyLine = true;
            return;
          } else if (it.sep) {
            it.value = token;
          } else {
            Object.assign(it, { key: token, sep: [] });
            this.onKeyLine = !it.explicitKey;
            return;
          }
          break;
        }
        case "block-seq": {
          const it = top.items[top.items.length - 1];
          if (it.value)
            top.items.push({ start: [], value: token });
          else
            it.value = token;
          break;
        }
        case "flow-collection": {
          const it = top.items[top.items.length - 1];
          if (!it || it.value)
            top.items.push({ start: [], key: token, sep: [] });
          else if (it.sep)
            it.value = token;
          else
            Object.assign(it, { key: token, sep: [] });
          return;
        }
        /* istanbul ignore next should not happen */
        default:
          yield* this.pop();
          yield* this.pop(token);
      }
      if ((top.type === "document" || top.type === "block-map" || top.type === "block-seq") && (token.type === "block-map" || token.type === "block-seq")) {
        const last = token.items[token.items.length - 1];
        if (last && !last.sep && !last.value && last.start.length > 0 && findNonEmptyIndex(last.start) === -1 && (token.indent === 0 || last.start.every((st) => st.type !== "comment" || st.indent < token.indent))) {
          if (top.type === "document")
            top.end = last.start;
          else
            top.items.push({ start: last.start });
          token.items.splice(-1, 1);
        }
      }
    }
  }
  *stream() {
    switch (this.type) {
      case "directive-line":
        yield { type: "directive", offset: this.offset, source: this.source };
        return;
      case "byte-order-mark":
      case "space":
      case "comment":
      case "newline":
        yield this.sourceToken;
        return;
      case "doc-mode":
      case "doc-start": {
        const doc = {
          type: "document",
          offset: this.offset,
          start: []
        };
        if (this.type === "doc-start")
          doc.start.push(this.sourceToken);
        this.stack.push(doc);
        return;
      }
    }
    yield {
      type: "error",
      offset: this.offset,
      message: `Unexpected ${this.type} token in YAML stream`,
      source: this.source
    };
  }
  *document(doc) {
    if (doc.value)
      return yield* this.lineEnd(doc);
    switch (this.type) {
      case "doc-start": {
        if (findNonEmptyIndex(doc.start) !== -1) {
          yield* this.pop();
          yield* this.step();
        } else
          doc.start.push(this.sourceToken);
        return;
      }
      case "anchor":
      case "tag":
      case "space":
      case "comment":
      case "newline":
        doc.start.push(this.sourceToken);
        return;
    }
    const bv = this.startBlockValue(doc);
    if (bv)
      this.stack.push(bv);
    else {
      yield {
        type: "error",
        offset: this.offset,
        message: `Unexpected ${this.type} token in YAML document`,
        source: this.source
      };
    }
  }
  *scalar(scalar) {
    if (this.type === "map-value-ind") {
      const prev = getPrevProps(this.peek(2));
      const start = getFirstKeyStartProps(prev);
      let sep;
      if (scalar.end) {
        sep = scalar.end;
        sep.push(this.sourceToken);
        delete scalar.end;
      } else
        sep = [this.sourceToken];
      const map2 = {
        type: "block-map",
        offset: scalar.offset,
        indent: scalar.indent,
        items: [{ start, key: scalar, sep }]
      };
      this.onKeyLine = true;
      this.stack[this.stack.length - 1] = map2;
    } else
      yield* this.lineEnd(scalar);
  }
  *blockScalar(scalar) {
    switch (this.type) {
      case "space":
      case "comment":
      case "newline":
        scalar.props.push(this.sourceToken);
        return;
      case "scalar":
        scalar.source = this.source;
        this.atNewLine = true;
        this.indent = 0;
        if (this.onNewLine) {
          let nl = this.source.indexOf("\n") + 1;
          while (nl !== 0) {
            this.onNewLine(this.offset + nl);
            nl = this.source.indexOf("\n", nl) + 1;
          }
        }
        yield* this.pop();
        break;
      /* istanbul ignore next should not happen */
      default:
        yield* this.pop();
        yield* this.step();
    }
  }
  *blockMap(map2) {
    const it = map2.items[map2.items.length - 1];
    switch (this.type) {
      case "newline":
        this.onKeyLine = false;
        if (it.value) {
          const end = "end" in it.value ? it.value.end : void 0;
          const last = Array.isArray(end) ? end[end.length - 1] : void 0;
          if (last?.type === "comment")
            end?.push(this.sourceToken);
          else
            map2.items.push({ start: [this.sourceToken] });
        } else if (it.sep) {
          it.sep.push(this.sourceToken);
        } else {
          it.start.push(this.sourceToken);
        }
        return;
      case "space":
      case "comment":
        if (it.value) {
          map2.items.push({ start: [this.sourceToken] });
        } else if (it.sep) {
          it.sep.push(this.sourceToken);
        } else {
          if (this.atIndentedComment(it.start, map2.indent)) {
            const prev = map2.items[map2.items.length - 2];
            const end = prev?.value?.end;
            if (Array.isArray(end)) {
              Array.prototype.push.apply(end, it.start);
              end.push(this.sourceToken);
              map2.items.pop();
              return;
            }
          }
          it.start.push(this.sourceToken);
        }
        return;
    }
    if (this.indent >= map2.indent) {
      const atMapIndent = !this.onKeyLine && this.indent === map2.indent;
      const atNextItem = atMapIndent && (it.sep || it.explicitKey) && this.type !== "seq-item-ind";
      let start = [];
      if (atNextItem && it.sep && !it.value) {
        const nl = [];
        for (let i = 0; i < it.sep.length; ++i) {
          const st = it.sep[i];
          switch (st.type) {
            case "newline":
              nl.push(i);
              break;
            case "space":
              break;
            case "comment":
              if (st.indent > map2.indent)
                nl.length = 0;
              break;
            default:
              nl.length = 0;
          }
        }
        if (nl.length >= 2)
          start = it.sep.splice(nl[1]);
      }
      switch (this.type) {
        case "anchor":
        case "tag":
          if (atNextItem || it.value) {
            start.push(this.sourceToken);
            map2.items.push({ start });
            this.onKeyLine = true;
          } else if (it.sep) {
            it.sep.push(this.sourceToken);
          } else {
            it.start.push(this.sourceToken);
          }
          return;
        case "explicit-key-ind":
          if (!it.sep && !it.explicitKey) {
            it.start.push(this.sourceToken);
            it.explicitKey = true;
          } else if (atNextItem || it.value) {
            start.push(this.sourceToken);
            map2.items.push({ start, explicitKey: true });
          } else {
            this.stack.push({
              type: "block-map",
              offset: this.offset,
              indent: this.indent,
              items: [{ start: [this.sourceToken], explicitKey: true }]
            });
          }
          this.onKeyLine = true;
          return;
        case "map-value-ind":
          if (it.explicitKey) {
            if (!it.sep) {
              if (includesToken(it.start, "newline")) {
                Object.assign(it, { key: null, sep: [this.sourceToken] });
              } else {
                const start2 = getFirstKeyStartProps(it.start);
                this.stack.push({
                  type: "block-map",
                  offset: this.offset,
                  indent: this.indent,
                  items: [{ start: start2, key: null, sep: [this.sourceToken] }]
                });
              }
            } else if (it.value) {
              map2.items.push({ start: [], key: null, sep: [this.sourceToken] });
            } else if (includesToken(it.sep, "map-value-ind")) {
              this.stack.push({
                type: "block-map",
                offset: this.offset,
                indent: this.indent,
                items: [{ start, key: null, sep: [this.sourceToken] }]
              });
            } else if (isFlowToken(it.key) && !includesToken(it.sep, "newline")) {
              const start2 = getFirstKeyStartProps(it.start);
              const key = it.key;
              const sep = it.sep;
              sep.push(this.sourceToken);
              delete it.key;
              delete it.sep;
              this.stack.push({
                type: "block-map",
                offset: this.offset,
                indent: this.indent,
                items: [{ start: start2, key, sep }]
              });
            } else if (start.length > 0) {
              it.sep = it.sep.concat(start, this.sourceToken);
            } else {
              it.sep.push(this.sourceToken);
            }
          } else {
            if (!it.sep) {
              Object.assign(it, { key: null, sep: [this.sourceToken] });
            } else if (it.value || atNextItem) {
              map2.items.push({ start, key: null, sep: [this.sourceToken] });
            } else if (includesToken(it.sep, "map-value-ind")) {
              this.stack.push({
                type: "block-map",
                offset: this.offset,
                indent: this.indent,
                items: [{ start: [], key: null, sep: [this.sourceToken] }]
              });
            } else {
              it.sep.push(this.sourceToken);
            }
          }
          this.onKeyLine = true;
          return;
        case "alias":
        case "scalar":
        case "single-quoted-scalar":
        case "double-quoted-scalar": {
          const fs = this.flowScalar(this.type);
          if (atNextItem || it.value) {
            map2.items.push({ start, key: fs, sep: [] });
            this.onKeyLine = true;
          } else if (it.sep) {
            this.stack.push(fs);
          } else {
            Object.assign(it, { key: fs, sep: [] });
            this.onKeyLine = true;
          }
          return;
        }
        default: {
          const bv = this.startBlockValue(map2);
          if (bv) {
            if (bv.type === "block-seq") {
              if (!it.explicitKey && it.sep && !includesToken(it.sep, "newline")) {
                yield* this.pop({
                  type: "error",
                  offset: this.offset,
                  message: "Unexpected block-seq-ind on same line with key",
                  source: this.source
                });
                return;
              }
            } else if (atMapIndent) {
              map2.items.push({ start });
            }
            this.stack.push(bv);
            return;
          }
        }
      }
    }
    yield* this.pop();
    yield* this.step();
  }
  *blockSequence(seq2) {
    const it = seq2.items[seq2.items.length - 1];
    switch (this.type) {
      case "newline":
        if (it.value) {
          const end = "end" in it.value ? it.value.end : void 0;
          const last = Array.isArray(end) ? end[end.length - 1] : void 0;
          if (last?.type === "comment")
            end?.push(this.sourceToken);
          else
            seq2.items.push({ start: [this.sourceToken] });
        } else
          it.start.push(this.sourceToken);
        return;
      case "space":
      case "comment":
        if (it.value)
          seq2.items.push({ start: [this.sourceToken] });
        else {
          if (this.atIndentedComment(it.start, seq2.indent)) {
            const prev = seq2.items[seq2.items.length - 2];
            const end = prev?.value?.end;
            if (Array.isArray(end)) {
              Array.prototype.push.apply(end, it.start);
              end.push(this.sourceToken);
              seq2.items.pop();
              return;
            }
          }
          it.start.push(this.sourceToken);
        }
        return;
      case "anchor":
      case "tag":
        if (it.value || this.indent <= seq2.indent)
          break;
        it.start.push(this.sourceToken);
        return;
      case "seq-item-ind":
        if (this.indent !== seq2.indent)
          break;
        if (it.value || includesToken(it.start, "seq-item-ind"))
          seq2.items.push({ start: [this.sourceToken] });
        else
          it.start.push(this.sourceToken);
        return;
    }
    if (this.indent > seq2.indent) {
      const bv = this.startBlockValue(seq2);
      if (bv) {
        this.stack.push(bv);
        return;
      }
    }
    yield* this.pop();
    yield* this.step();
  }
  *flowCollection(fc) {
    const it = fc.items[fc.items.length - 1];
    if (this.type === "flow-error-end") {
      let top;
      do {
        yield* this.pop();
        top = this.peek(1);
      } while (top && top.type === "flow-collection");
    } else if (fc.end.length === 0) {
      switch (this.type) {
        case "comma":
        case "explicit-key-ind":
          if (!it || it.sep)
            fc.items.push({ start: [this.sourceToken] });
          else
            it.start.push(this.sourceToken);
          return;
        case "map-value-ind":
          if (!it || it.value)
            fc.items.push({ start: [], key: null, sep: [this.sourceToken] });
          else if (it.sep)
            it.sep.push(this.sourceToken);
          else
            Object.assign(it, { key: null, sep: [this.sourceToken] });
          return;
        case "space":
        case "comment":
        case "newline":
        case "anchor":
        case "tag":
          if (!it || it.value)
            fc.items.push({ start: [this.sourceToken] });
          else if (it.sep)
            it.sep.push(this.sourceToken);
          else
            it.start.push(this.sourceToken);
          return;
        case "alias":
        case "scalar":
        case "single-quoted-scalar":
        case "double-quoted-scalar": {
          const fs = this.flowScalar(this.type);
          if (!it || it.value)
            fc.items.push({ start: [], key: fs, sep: [] });
          else if (it.sep)
            this.stack.push(fs);
          else
            Object.assign(it, { key: fs, sep: [] });
          return;
        }
        case "flow-map-end":
        case "flow-seq-end":
          fc.end.push(this.sourceToken);
          return;
      }
      const bv = this.startBlockValue(fc);
      if (bv)
        this.stack.push(bv);
      else {
        yield* this.pop();
        yield* this.step();
      }
    } else {
      const parent = this.peek(2);
      if (parent.type === "block-map" && (this.type === "map-value-ind" && parent.indent === fc.indent || this.type === "newline" && !parent.items[parent.items.length - 1].sep)) {
        yield* this.pop();
        yield* this.step();
      } else if (this.type === "map-value-ind" && parent.type !== "flow-collection") {
        const prev = getPrevProps(parent);
        const start = getFirstKeyStartProps(prev);
        fixFlowSeqItems(fc);
        const sep = fc.end.splice(1, fc.end.length);
        sep.push(this.sourceToken);
        const map2 = {
          type: "block-map",
          offset: fc.offset,
          indent: fc.indent,
          items: [{ start, key: fc, sep }]
        };
        this.onKeyLine = true;
        this.stack[this.stack.length - 1] = map2;
      } else {
        yield* this.lineEnd(fc);
      }
    }
  }
  flowScalar(type) {
    if (this.onNewLine) {
      let nl = this.source.indexOf("\n") + 1;
      while (nl !== 0) {
        this.onNewLine(this.offset + nl);
        nl = this.source.indexOf("\n", nl) + 1;
      }
    }
    return {
      type,
      offset: this.offset,
      indent: this.indent,
      source: this.source
    };
  }
  startBlockValue(parent) {
    switch (this.type) {
      case "alias":
      case "scalar":
      case "single-quoted-scalar":
      case "double-quoted-scalar":
        return this.flowScalar(this.type);
      case "block-scalar-header":
        return {
          type: "block-scalar",
          offset: this.offset,
          indent: this.indent,
          props: [this.sourceToken],
          source: ""
        };
      case "flow-map-start":
      case "flow-seq-start":
        return {
          type: "flow-collection",
          offset: this.offset,
          indent: this.indent,
          start: this.sourceToken,
          items: [],
          end: []
        };
      case "seq-item-ind":
        return {
          type: "block-seq",
          offset: this.offset,
          indent: this.indent,
          items: [{ start: [this.sourceToken] }]
        };
      case "explicit-key-ind": {
        this.onKeyLine = true;
        const prev = getPrevProps(parent);
        const start = getFirstKeyStartProps(prev);
        start.push(this.sourceToken);
        return {
          type: "block-map",
          offset: this.offset,
          indent: this.indent,
          items: [{ start, explicitKey: true }]
        };
      }
      case "map-value-ind": {
        this.onKeyLine = true;
        const prev = getPrevProps(parent);
        const start = getFirstKeyStartProps(prev);
        return {
          type: "block-map",
          offset: this.offset,
          indent: this.indent,
          items: [{ start, key: null, sep: [this.sourceToken] }]
        };
      }
    }
    return null;
  }
  atIndentedComment(start, indent) {
    if (this.type !== "comment")
      return false;
    if (this.indent <= indent)
      return false;
    return start.every((st) => st.type === "newline" || st.type === "space");
  }
  *documentEnd(docEnd) {
    if (this.type !== "doc-mode") {
      if (docEnd.end)
        docEnd.end.push(this.sourceToken);
      else
        docEnd.end = [this.sourceToken];
      if (this.type === "newline")
        yield* this.pop();
    }
  }
  *lineEnd(token) {
    switch (this.type) {
      case "comma":
      case "doc-start":
      case "doc-end":
      case "flow-seq-end":
      case "flow-map-end":
      case "map-value-ind":
        yield* this.pop();
        yield* this.step();
        break;
      case "newline":
        this.onKeyLine = false;
      // fallthrough
      case "space":
      case "comment":
      default:
        if (token.end)
          token.end.push(this.sourceToken);
        else
          token.end = [this.sourceToken];
        if (this.type === "newline")
          yield* this.pop();
    }
  }
};

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/public-api.js
function parseOptions(options) {
  const prettyErrors = options.prettyErrors !== false;
  const lineCounter = options.lineCounter || prettyErrors && new LineCounter() || null;
  return { lineCounter, prettyErrors };
}
__name(parseOptions, "parseOptions");
function parseDocument(source, options = {}) {
  const { lineCounter, prettyErrors } = parseOptions(options);
  const parser = new Parser(lineCounter?.addNewLine);
  const composer = new Composer(options);
  let doc = null;
  for (const _doc of composer.compose(parser.parse(source), true, source.length)) {
    if (!doc)
      doc = _doc;
    else if (doc.options.logLevel !== "silent") {
      doc.errors.push(new YAMLParseError(_doc.range.slice(0, 2), "MULTIPLE_DOCS", "Source contains multiple documents; please use YAML.parseAllDocuments()"));
      break;
    }
  }
  if (prettyErrors && lineCounter) {
    doc.errors.forEach(prettifyError(source, lineCounter));
    doc.warnings.forEach(prettifyError(source, lineCounter));
  }
  return doc;
}
__name(parseDocument, "parseDocument");

// src/config/parser.ts
var ENV_REF_PATTERN = /^\$([A-Za-z_][A-Za-z0-9_]*)$/u;
var ALLOWED_TRACKER_TYPES = /* @__PURE__ */ new Set(["", "internal", "local", "linear", "github"]);
var ALLOWED_LINEAR_SYNC_MODES = /* @__PURE__ */ new Set(["", "reply_thread", "top_level"]);
var ALLOWED_WORKER_MODES = /* @__PURE__ */ new Set(["", "tmux", "goroutine"]);
function parseWorkflowConfig(content, options = {}) {
  const split = splitFrontMatter(content);
  const promptTemplate = split.prompt.trim();
  if (!split.hasFrontMatter) {
    return { promptTemplate, frontMatter: {} };
  }
  if (split.frontMatter.trim() === "") {
    if (!split.terminated) {
      throw configParseError([{ path: "$", message: "unterminated front matter" }]);
    }
    return { promptTemplate, frontMatter: {} };
  }
  const document = parseDocument(split.frontMatter, { prettyErrors: false });
  if (document.errors.length > 0) {
    throw configParseError(document.errors.map((error) => ({
      path: "$",
      message: `invalid workflow yaml: ${error.message}`
    })));
  }
  if (!isMap(document.contents)) {
    throw configParseError([{ path: "$", message: "workflow front matter must be a map" }]);
  }
  const frontMatter = getRecord(document.toJSON());
  if (frontMatter === void 0) {
    throw configParseError([{ path: "$", message: "workflow front matter must be a map" }]);
  }
  const details = validateWorkflowConfig(frontMatter, options);
  if (!split.terminated) {
    details.push({ path: "$", message: "unterminated front matter" });
  }
  if (details.length > 0) {
    throw configParseError(details);
  }
  return { promptTemplate, frontMatter };
}
__name(parseWorkflowConfig, "parseWorkflowConfig");
function configParseError(details) {
  const error = new Error("config_invalid");
  error.details = details;
  return error;
}
__name(configParseError, "configParseError");
function isConfigParseError(error) {
  const details = getErrorDetails(error);
  return error instanceof Error && details !== void 0 && details.every(isValidationDetail);
}
__name(isConfigParseError, "isConfigParseError");
function splitFrontMatter(content) {
  if (!content.startsWith("---")) {
    return { frontMatter: "", prompt: content, hasFrontMatter: false, terminated: false };
  }
  if (content.length > 3) {
    const next = content.charAt(3);
    if (next !== "\n" && next !== "\r") {
      return { frontMatter: "", prompt: content, hasFrontMatter: false, terminated: false };
    }
  }
  const startOffset = content.startsWith("---\r\n") ? 5 : 4;
  if (content.length <= startOffset) {
    return { frontMatter: "", prompt: "", hasFrontMatter: true, terminated: true };
  }
  const remainder = content.slice(startOffset);
  const lines = remainder.match(/[^\n]*\n|[^\n]+/gu) ?? [];
  let offset = 0;
  let frontMatter = "";
  for (const line of lines) {
    offset += line.length;
    if (line.replace(/[\r\n]+$/u, "") === "---") {
      return {
        frontMatter,
        prompt: remainder.slice(offset),
        hasFrontMatter: true,
        terminated: true
      };
    }
    frontMatter += line;
  }
  return { frontMatter, prompt: "", hasFrontMatter: true, terminated: false };
}
__name(splitFrontMatter, "splitFrontMatter");
function validateWorkflowConfig(frontMatter, options) {
  const details = [];
  const tracker = getRecord(frontMatter.tracker);
  const trackerType = getString(tracker?.type)?.trim().toLowerCase() ?? "";
  const boundSecrets = new Set(options.boundSecrets ?? []);
  if (!ALLOWED_TRACKER_TYPES.has(trackerType)) {
    details.push({ path: "tracker.type", message: `unknown tracker type: ${String(tracker?.type)}` });
  }
  const tokenSecret = getEnvReference(getString(tracker?.token));
  if (tokenSecret !== void 0 && !boundSecrets.has(tokenSecret)) {
    details.push({ path: `tracker.${trackerType === "" ? "token" : `${trackerType}.token`}`, message: `secret not bound: ${tokenSecret}` });
  }
  const linear = getRecord(frontMatter.linear);
  const syncComments = getRecord(linear?.sync_comments);
  const syncEnabled = syncComments?.enabled === true;
  const mode = getString(syncComments?.mode)?.trim().toLowerCase() ?? "";
  if (trackerType === "linear" && syncEnabled && !ALLOWED_LINEAR_SYNC_MODES.has(mode)) {
    details.push({ path: "linear.sync_comments.mode", message: "invalid linear.sync_comments.mode" });
  }
  const team = getRecord(frontMatter.team);
  const workerMode = getString(team?.worker_mode)?.trim().toLowerCase() ?? "";
  if (!ALLOWED_WORKER_MODES.has(workerMode)) {
    details.push({ path: "team.worker_mode", message: `unknown worker_mode: ${String(team?.worker_mode)} (valid values: goroutine, tmux)` });
  }
  return details;
}
__name(validateWorkflowConfig, "validateWorkflowConfig");
function getRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
__name(getRecord, "getRecord");
function getString(value) {
  return typeof value === "string" ? value : void 0;
}
__name(getString, "getString");
function getEnvReference(value) {
  if (value === void 0) {
    return void 0;
  }
  return ENV_REF_PATTERN.exec(value)?.[1];
}
__name(getEnvReference, "getEnvReference");
function isValidationDetail(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value;
  return typeof record.path === "string" && typeof record.message === "string";
}
__name(isValidationDetail, "isValidationDetail");
function getErrorDetails(error) {
  if (error === null || typeof error !== "object" || Array.isArray(error)) {
    return void 0;
  }
  const details = error.details;
  return Array.isArray(details) ? details : void 0;
}
__name(getErrorDetails, "getErrorDetails");

// src/workerproto/v1/index.ts
var PROTOCOL_VERSION_CURRENT = "1.0.0";

// src/worker/index.ts
var DASHBOARD_SESSION_COOKIE_NAME = "contrabass_session";
var SESSION_TOKEN_TTL_MS = 60 * 60 * 1e3;
var REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1e3;
var HEARTBEAT_INTERVAL_SEC = 20;
var LEASE_SEC = 60;
var SUPPORTED_PROTOCOL_VERSIONS = [PROTOCOL_VERSION_CURRENT];
var API_VERSION_HEADER = "X-Contrabass-Api-Version";
var workerRouter = new Hono2();
workerRouter.use("*", apiVersionHeaderMiddleware());
workerRouter.use("/v1/*", authMiddleware());
workerRouter.get("/v1/teams/:teamId/board", (context) => {
  return forwardTeamCoordinatorRequest(context, "/board");
});
workerRouter.post("/v1/teams/:teamId/board/*", forwardTeamCoordinatorBoardPostRequest);
workerRouter.post("/v1/teams/:teamId/config", createTeamConfig);
workerRouter.post("/v1/workers/register", registerWorker);
workerRouter.post("/v1/workers/refresh", refreshWorkerSession);
workerRouter.post("/v1/workers/enroll", enrollWorker);
workerRouter.post("/v1/runs/:runId/ack", (context) => {
  return forwardIssueRunRequest(context, "/ack");
});
workerRouter.post("/v1/runs/:runId/heartbeat", (context) => {
  return forwardIssueRunRequest(context, "/heartbeat");
});
workerRouter.post("/v1/runs/:runId/events", (context) => {
  return forwardIssueRunRequest(context, "/events");
});
workerRouter.post("/v1/runs/:runId/complete", (context) => {
  return forwardIssueRunRequest(context, "/complete");
});
workerRouter.get("/v1/workers/:workerId/dispatch", longPollWorkerDispatch);
workerRouter.get("/v1/workers/:workerId/dispatch-ws", websocketWorkerDispatch);
workerRouter.get("/v1/teams/:teamId/subscribe", (context) => {
  return forwardTeamCoordinatorRequest(context, "/subscribe");
});
workerRouter.notFound(() => {
  return errorResponse("not_found", 404);
});
async function handleWorkerRequest(request, env) {
  return workerRouter.fetch(request, env);
}
__name(handleWorkerRequest, "handleWorkerRequest");
function apiVersionHeaderMiddleware() {
  return async (context, next) => {
    await next();
    context.header(API_VERSION_HEADER, PROTOCOL_VERSION_CURRENT);
  };
}
__name(apiVersionHeaderMiddleware, "apiVersionHeaderMiddleware");
function authMiddleware() {
  return async (context, next) => {
    if (isPublicWorkerAuthRoute(context.req.raw)) {
      await next();
      return;
    }
    const principal = await validateAuthPrincipal(context.req.raw, context.env);
    if (principal === void 0) {
      return errorResponse("unauthorized", 401);
    }
    context.set("principal", principal);
    await next();
  };
}
__name(authMiddleware, "authMiddleware");
async function validateAuthPrincipal(request, env) {
  const bearerToken = extractBearerToken(request.headers.get("authorization"));
  const issuedSession = bearerToken === void 0 ? void 0 : await validateIssuedSessionToken(bearerToken, env);
  if (bearerToken !== void 0 && issuedSession !== void 0) {
    return {
      kind: "bearer",
      token: bearerToken,
      teamId: issuedSession.teamId,
      workerId: issuedSession.workerId,
      issued: true
    };
  }
  if (bearerToken !== void 0 && isConfiguredToken(bearerToken, env.CONTRABASS_WORKER_SESSION_TOKENS)) {
    return { kind: "bearer", token: bearerToken };
  }
  const sessionToken = extractDashboardSessionCookie(request.headers.get("cookie"));
  if (sessionToken !== void 0 && isConfiguredToken(sessionToken, env.CONTRABASS_DASHBOARD_SESSION_TOKENS)) {
    return { kind: "dashboard-session", token: sessionToken };
  }
  return void 0;
}
__name(validateAuthPrincipal, "validateAuthPrincipal");
async function registerWorker(context) {
  const body = await readObjectBody3(context.req.raw);
  const request = parseRegisterRequest(body);
  if (request === void 0) {
    return errorResponse("invalid_request", 400);
  }
  if (!request.supported_protocol_versions.includes(PROTOCOL_VERSION_CURRENT)) {
    return protocolVersionUnsupportedResponse();
  }
  if (!await teamExists(context.env, request.teamId)) {
    return errorResponse("team_forbidden", 403);
  }
  if (workerTokenSigningSecret(context.env) === void 0) {
    return workerTokenConfigErrorResponse();
  }
  const coordinatorResponse = await forwardWorkerRegistration(context, request);
  if (!coordinatorResponse.ok) {
    return normalizeForwardedErrorResponse(coordinatorResponse);
  }
  const now = Date.now();
  const sessionTokenExpiresAt = now + SESSION_TOKEN_TTL_MS;
  const [sessionToken, refreshToken] = await Promise.all([
    issueSessionToken(context.env, request.teamId, request.workerId, sessionTokenExpiresAt),
    randomBearerToken("cbr")
  ]);
  await persistRefreshToken(context.env, request, refreshToken, now + REFRESH_TOKEN_TTL_MS);
  return jsonResponse3({
    sessionToken,
    sessionTokenExpiresAt,
    refreshToken,
    dispatchChannel: dispatchChannel(context.req.raw, request.workerId),
    heartbeatIntervalSec: HEARTBEAT_INTERVAL_SEC,
    leaseSec: LEASE_SEC,
    protocol_version: PROTOCOL_VERSION_CURRENT
  }, 200);
}
__name(registerWorker, "registerWorker");
async function refreshWorkerSession(context) {
  const body = await readObjectBody3(context.req.raw);
  const request = parseRefreshRequest(body);
  if (request === void 0) {
    return errorResponse("refresh_invalid", 401);
  }
  const enrollment = await findEnrollmentByRefreshToken(context.env, request.refreshToken);
  if (enrollment === void 0) {
    return errorResponse("refresh_invalid", 401);
  }
  if (enrollment.revoked_at !== null) {
    return errorResponse("refresh_revoked", 401);
  }
  if (enrollment.refresh_token_expires_at === null || isPastIsoTime(enrollment.refresh_token_expires_at)) {
    return errorResponse("refresh_expired", 401);
  }
  if (enrollment.worker_id === null) {
    return errorResponse("refresh_invalid", 401);
  }
  if (workerTokenSigningSecret(context.env) === void 0) {
    return workerTokenConfigErrorResponse();
  }
  await context.env.CONTROL_PLANE_DB?.prepare(
    "UPDATE worker_enrollments SET last_refreshed_at = ? WHERE enrollment_id = ?"
  ).bind((/* @__PURE__ */ new Date()).toISOString(), enrollment.enrollment_id).run();
  const expiresAt = Date.now() + SESSION_TOKEN_TTL_MS;
  const sessionToken = await issueSessionToken(context.env, enrollment.team_id, enrollment.worker_id, expiresAt);
  return jsonResponse3({
    sessionToken,
    expiresAt,
    protocol_version: PROTOCOL_VERSION_CURRENT
  }, 200);
}
__name(refreshWorkerSession, "refreshWorkerSession");
async function enrollWorker(context) {
  const body = await readObjectBody3(context.req.raw);
  if (body === void 0) {
    return errorResponse("enrollment_invalid", 401);
  }
  const code = getStringField3(body, "code");
  if (code === void 0) {
    return errorResponse("enrollment_invalid", 401);
  }
  const enrollment = await findEnrollmentByCode(context.env, code);
  if (enrollment === void 0 || enrollment.revoked_at !== null || enrollment.redeemed_at !== null || isPastIsoTime(enrollment.expires_at)) {
    return errorResponse("enrollment_invalid", 401);
  }
  const workerId = getStringField3(body, "workerId") ?? getStringField3(body, "worker_id") ?? enrollment.worker_id ?? `worker_${await randomTokenPart(12)}`;
  const refreshToken = await randomBearerToken("cbr");
  const refreshTokenHash = await sha256Hex(refreshToken);
  const refreshTokenExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS).toISOString();
  const redeemedAt = (/* @__PURE__ */ new Date()).toISOString();
  const updateResult = await context.env.CONTROL_PLANE_DB?.prepare(`
    UPDATE worker_enrollments
    SET worker_id = ?, refresh_token_hash = ?, redeemed_at = ?, refresh_token_expires_at = ?, last_refreshed_at = ?
    WHERE enrollment_id = ? AND redeemed_at IS NULL AND revoked_at IS NULL AND expires_at > ?
  `).bind(
    workerId,
    refreshTokenHash,
    redeemedAt,
    refreshTokenExpiresAt,
    redeemedAt,
    enrollment.enrollment_id,
    redeemedAt
  ).run();
  if (updateResult?.meta.changes !== 1) {
    return errorResponse("enrollment_invalid", 401);
  }
  return jsonResponse3({
    teamId: enrollment.team_id,
    workerId,
    refreshToken,
    protocol_version: PROTOCOL_VERSION_CURRENT
  }, 200);
}
__name(enrollWorker, "enrollWorker");
async function createTeamConfig(context) {
  const teamId = (context.req.param("teamId") ?? "").trim();
  if (teamId === "") {
    return errorResponse("invalid_team_id", 400);
  }
  const principal = context.get("principal");
  if ("issued" in principal && principal.teamId !== teamId) {
    return errorResponse("team_forbidden", 403);
  }
  if (context.env.CONTROL_PLANE_DB === void 0) {
    return errorResponse("config_store_unavailable", 500);
  }
  const body = await readObjectBody3(context.req.raw);
  const request = parseCreateConfigRequest(body);
  if (request === void 0) {
    return errorResponse("invalid_request", 400);
  }
  try {
    parseWorkflowConfig(request.contentYaml, { boundSecrets: parseConfiguredTokens(context.env.CONTRABASS_CONFIG_BOUND_SECRETS) });
  } catch (error) {
    if (isConfigParseError(error)) {
      return configInvalidResponse(error.details);
    }
    return configInvalidResponse([{ path: "$", message: "invalid workflow config" }]);
  }
  const contentHash = await sha256Hex(request.contentYaml);
  const existing = await context.env.CONTROL_PLANE_DB.prepare(`
    SELECT version, content_hash
    FROM team_configs
    WHERE team_id = ? AND content_hash = ?
    LIMIT 1
  `).bind(teamId, contentHash).first();
  if (existing !== null) {
    return jsonResponse3({
      teamId,
      version: existing.version,
      contentHash: existing.content_hash,
      unchanged: true,
      protocol_version: PROTOCOL_VERSION_CURRENT
    }, 200);
  }
  const next = await context.env.CONTROL_PLANE_DB.prepare(
    "SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM team_configs WHERE team_id = ?"
  ).bind(teamId).first();
  const version = next?.next_version ?? 1;
  const createdBy = request.createdBy ?? defaultConfigActor(principal);
  const createdAt = (/* @__PURE__ */ new Date()).toISOString();
  await context.env.CONTROL_PLANE_DB.prepare(`
    INSERT INTO team_configs (team_id, version, content_hash, content_yaml, created_by, created_at, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(teamId, version, contentHash, request.contentYaml, createdBy, createdAt, request.notes ?? "").run();
  return jsonResponse3({
    teamId,
    version,
    contentHash,
    unchanged: false,
    protocol_version: PROTOCOL_VERSION_CURRENT
  }, 201);
}
__name(createTeamConfig, "createTeamConfig");
function extractBearerToken(authorization) {
  if (authorization === null) {
    return void 0;
  }
  const match2 = /^Bearer\s+(.+)$/iu.exec(authorization.trim());
  const token = match2?.[1]?.trim();
  return token === void 0 || token.length === 0 ? void 0 : token;
}
__name(extractBearerToken, "extractBearerToken");
function extractDashboardSessionCookie(cookieHeader) {
  if (cookieHeader === null) {
    return void 0;
  }
  for (const segment of cookieHeader.split(";")) {
    const [rawName, ...rawValueParts] = segment.trim().split("=");
    const value = rawValueParts.join("=").trim();
    if (rawName === DASHBOARD_SESSION_COOKIE_NAME && value.length > 0) {
      try {
        return decodeURIComponent(value);
      } catch {
        return void 0;
      }
    }
  }
  return void 0;
}
__name(extractDashboardSessionCookie, "extractDashboardSessionCookie");
function isConfiguredToken(token, configuredTokens) {
  return parseConfiguredTokens(configuredTokens).some((configuredToken) => timingSafeEqual(token, configuredToken));
}
__name(isConfiguredToken, "isConfiguredToken");
function parseConfiguredTokens(configuredTokens) {
  const raw2 = configuredTokens?.trim();
  if (raw2 === void 0 || raw2.length === 0) {
    return [];
  }
  if (raw2.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw2);
      if (Array.isArray(parsed) && parsed.every((token) => typeof token === "string")) {
        return parsed.map((token) => token.trim()).filter((token) => token.length > 0);
      }
    } catch {
      return [];
    }
    return [];
  }
  return raw2.split(/[\s,]+/u).map((token) => token.trim()).filter((token) => token.length > 0);
}
__name(parseConfiguredTokens, "parseConfiguredTokens");
function timingSafeEqual(actual, expected) {
  const maxLength = Math.max(actual.length, expected.length);
  let diff = actual.length ^ expected.length;
  for (let index = 0; index < maxLength; index += 1) {
    diff |= (actual.charCodeAt(index) || 0) ^ (expected.charCodeAt(index) || 0);
  }
  return diff === 0;
}
__name(timingSafeEqual, "timingSafeEqual");
function isPublicWorkerAuthRoute(request) {
  const url = new URL(request.url);
  return request.method === "POST" && (url.pathname === "/v1/workers/refresh" || url.pathname === "/v1/workers/enroll");
}
__name(isPublicWorkerAuthRoute, "isPublicWorkerAuthRoute");
async function forwardWorkerRegistration(context, request) {
  const headers = new Headers(context.req.raw.headers);
  headers.set("content-type", "application/json");
  headers.set("x-contrabass-team-id", request.teamId);
  const id = context.env.TEAM_COORDINATOR.idFromName(request.teamId);
  const stub = context.env.TEAM_COORDINATOR.get(id);
  return stub.fetch(new Request("https://team-coordinator.internal/workers/register", {
    method: "POST",
    headers,
    body: JSON.stringify({
      ...request,
      kind: request.kind ?? "local"
    })
  }));
}
__name(forwardWorkerRegistration, "forwardWorkerRegistration");
async function teamExists(env, teamId) {
  if (env.CONTROL_PLANE_DB === void 0) {
    return true;
  }
  const row = await env.CONTROL_PLANE_DB.prepare(
    "SELECT team_id FROM team_configs_active WHERE team_id = ? LIMIT 1"
  ).bind(teamId).first();
  return row !== null;
}
__name(teamExists, "teamExists");
async function persistRefreshToken(env, request, refreshToken, expiresAt) {
  if (env.CONTROL_PLANE_DB === void 0) {
    return;
  }
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const enrollmentId = `register_${request.teamId}_${request.workerId}_${await randomTokenPart(8)}`;
  await env.CONTROL_PLANE_DB.prepare(`
    INSERT INTO worker_enrollments (
      enrollment_id,
      team_id,
      worker_id,
      code_hash,
      refresh_token_hash,
      created_by,
      expires_at,
      redeemed_at,
      refresh_token_expires_at,
      capabilities,
      worker_version,
      last_refreshed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    enrollmentId,
    request.teamId,
    request.workerId,
    await sha256Hex(`register:${enrollmentId}`),
    await sha256Hex(refreshToken),
    `worker:${request.workerId}`,
    new Date(expiresAt).toISOString(),
    now,
    new Date(expiresAt).toISOString(),
    JSON.stringify(request.capabilities),
    request.version,
    now
  ).run();
}
__name(persistRefreshToken, "persistRefreshToken");
function parseRegisterRequest(body) {
  if (body === void 0) {
    return void 0;
  }
  const teamId = getStringField3(body, "teamId");
  const workerId = getStringField3(body, "workerId");
  const capabilities = getStringArrayField2(body, "capabilities");
  const maxConcurrency = getPositiveIntegerField2(body, "maxConcurrency");
  const version = getStringField3(body, "version");
  const supportedProtocolVersions = getStringArrayField2(body, "supported_protocol_versions");
  const protocolVersion = body.protocol_version;
  const kind = getWorkerKindField3(body);
  if (teamId === void 0 || workerId === void 0 || capabilities === void 0 || capabilities.length === 0 || maxConcurrency === void 0 || version === void 0 || supportedProtocolVersions === void 0 || supportedProtocolVersions.length === 0 || protocolVersion !== PROTOCOL_VERSION_CURRENT) {
    return void 0;
  }
  return {
    teamId,
    workerId,
    capabilities,
    maxConcurrency,
    version,
    supported_protocol_versions: supportedProtocolVersions,
    protocol_version: PROTOCOL_VERSION_CURRENT,
    ...kind === void 0 ? {} : { kind }
  };
}
__name(parseRegisterRequest, "parseRegisterRequest");
function parseRefreshRequest(body) {
  if (body === void 0) {
    return void 0;
  }
  const refreshToken = getStringField3(body, "refreshToken");
  if (refreshToken === void 0 || body.protocol_version !== PROTOCOL_VERSION_CURRENT) {
    return void 0;
  }
  return {
    refreshToken,
    protocol_version: PROTOCOL_VERSION_CURRENT
  };
}
__name(parseRefreshRequest, "parseRefreshRequest");
function parseCreateConfigRequest(body) {
  if (body === void 0) {
    return void 0;
  }
  const contentYaml = getStringField3(body, "content_yaml") ?? getStringField3(body, "contentYaml");
  if (contentYaml === void 0) {
    return void 0;
  }
  return {
    contentYaml,
    createdBy: getStringField3(body, "created_by") ?? getStringField3(body, "createdBy"),
    notes: getStringField3(body, "notes")
  };
}
__name(parseCreateConfigRequest, "parseCreateConfigRequest");
async function findEnrollmentByCode(env, code) {
  if (env.CONTROL_PLANE_DB === void 0) {
    return void 0;
  }
  const row = await env.CONTROL_PLANE_DB.prepare(`
    SELECT enrollment_id, team_id, worker_id, expires_at, redeemed_at, refresh_token_expires_at, revoked_at
    FROM worker_enrollments
    WHERE code_hash = ?
    LIMIT 1
  `).bind(await sha256Hex(code)).first();
  return row ?? void 0;
}
__name(findEnrollmentByCode, "findEnrollmentByCode");
async function findEnrollmentByRefreshToken(env, refreshToken) {
  if (env.CONTROL_PLANE_DB === void 0) {
    return void 0;
  }
  const row = await env.CONTROL_PLANE_DB.prepare(`
    SELECT enrollment_id, team_id, worker_id, expires_at, redeemed_at, refresh_token_expires_at, revoked_at
    FROM worker_enrollments
    WHERE refresh_token_hash = ?
    LIMIT 1
  `).bind(await sha256Hex(refreshToken)).first();
  return row ?? void 0;
}
__name(findEnrollmentByRefreshToken, "findEnrollmentByRefreshToken");
function isPastIsoTime(value) {
  const parsed = Date.parse(value);
  return !Number.isFinite(parsed) || parsed <= Date.now();
}
__name(isPastIsoTime, "isPastIsoTime");
function dispatchChannel(request, workerId) {
  const url = new URL(request.url);
  const encodedWorkerId = encodeURIComponent(workerId);
  return {
    wsUrl: `${websocketOrigin(url)}/v1/workers/${encodedWorkerId}/dispatch-ws`,
    longPollUrl: `${url.origin}/v1/workers/${encodedWorkerId}/dispatch?wait=25s`
  };
}
__name(dispatchChannel, "dispatchChannel");
function websocketOrigin(url) {
  return `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}`;
}
__name(websocketOrigin, "websocketOrigin");
async function issueSessionToken(env, teamId, workerId, expiresAt) {
  const secret = workerTokenSigningSecret(env);
  if (secret === void 0) {
    throw new Error("CONTRABASS_WORKER_TOKEN_SECRET is required to issue worker session tokens");
  }
  const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify({
    teamId,
    workerId,
    exp: expiresAt,
    protocol_version: PROTOCOL_VERSION_CURRENT
  })));
  const signature = await hmacSha256Base64Url(secret, payload);
  return `cbs.${payload}.${signature}`;
}
__name(issueSessionToken, "issueSessionToken");
async function validateIssuedSessionToken(token, env) {
  const secret = workerTokenSigningSecret(env);
  if (secret === void 0) {
    return void 0;
  }
  const [prefix, payload, signature] = token.split(".");
  if (prefix !== "cbs" || payload === void 0 || signature === void 0) {
    return void 0;
  }
  const expected = await hmacSha256Base64Url(secret, payload);
  if (!timingSafeEqual(signature, expected)) {
    return void 0;
  }
  const parsed = parseSessionPayload(payload);
  return parsed !== void 0 && parsed.exp > Date.now() && parsed.protocol_version === PROTOCOL_VERSION_CURRENT ? parsed : void 0;
}
__name(validateIssuedSessionToken, "validateIssuedSessionToken");
function workerTokenSigningSecret(env) {
  const explicit = env.CONTRABASS_WORKER_TOKEN_SECRET?.trim();
  if (explicit !== void 0 && explicit.length > 0) {
    return explicit;
  }
  const configuredTokens = env.CONTRABASS_WORKER_SESSION_TOKENS?.trim();
  return configuredTokens === void 0 || configuredTokens.length === 0 ? void 0 : configuredTokens;
}
__name(workerTokenSigningSecret, "workerTokenSigningSecret");
function workerTokenConfigErrorResponse() {
  return jsonResponse3({
    error: "worker_token_secret_missing",
    protocol_version: PROTOCOL_VERSION_CURRENT
  }, 500);
}
__name(workerTokenConfigErrorResponse, "workerTokenConfigErrorResponse");
function configInvalidResponse(details) {
  return errorResponse("config_invalid", 400, { details });
}
__name(configInvalidResponse, "configInvalidResponse");
function defaultConfigActor(principal) {
  if ("issued" in principal) {
    return `worker:${principal.workerId}`;
  }
  return principal.kind === "dashboard-session" ? "dashboard" : "api";
}
__name(defaultConfigActor, "defaultConfigActor");
function parseSessionPayload(payload) {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload)));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return void 0;
    }
    const record = parsed;
    return typeof record.teamId === "string" && typeof record.workerId === "string" && typeof record.exp === "number" && typeof record.protocol_version === "string" ? {
      teamId: record.teamId,
      workerId: record.workerId,
      exp: record.exp,
      protocol_version: record.protocol_version
    } : void 0;
  } catch {
    return void 0;
  }
}
__name(parseSessionPayload, "parseSessionPayload");
async function hmacSha256Base64Url(secret, payload) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return base64UrlEncode(new Uint8Array(signature));
}
__name(hmacSha256Base64Url, "hmacSha256Base64Url");
async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
__name(sha256Hex, "sha256Hex");
async function randomBearerToken(prefix) {
  return `${prefix}_${await randomTokenPart(32)}`;
}
__name(randomBearerToken, "randomBearerToken");
async function randomTokenPart(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}
__name(randomTokenPart, "randomTokenPart");
function base64UrlEncode(bytes) {
  let binary2 = "";
  for (const byte of bytes) {
    binary2 += String.fromCharCode(byte);
  }
  return btoa(binary2).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}
__name(base64UrlEncode, "base64UrlEncode");
function base64UrlDecode(value) {
  const padded = value.replace(/-/gu, "+").replace(/_/gu, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary2 = atob(padded);
  const bytes = new Uint8Array(binary2.length);
  for (let index = 0; index < binary2.length; index += 1) {
    bytes[index] = binary2.charCodeAt(index);
  }
  return bytes;
}
__name(base64UrlDecode, "base64UrlDecode");
async function readObjectBody3(request) {
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
__name(readObjectBody3, "readObjectBody");
function getStringField3(body, key) {
  const value = body[key];
  return typeof value === "string" && value.trim() !== "" ? value : void 0;
}
__name(getStringField3, "getStringField");
function getStringArrayField2(body, key) {
  const value = body[key];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    return void 0;
  }
  return value;
}
__name(getStringArrayField2, "getStringArrayField");
function getPositiveIntegerField2(body, key) {
  const value = body[key];
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : void 0;
}
__name(getPositiveIntegerField2, "getPositiveIntegerField");
function getWorkerKindField3(body) {
  const value = body.kind;
  return value === "local" || value === "container" ? value : void 0;
}
__name(getWorkerKindField3, "getWorkerKindField");
async function forwardTeamCoordinatorRequest(context, coordinatorPath) {
  const teamId = (context.req.param("teamId") ?? "").trim();
  if (teamId === "") {
    return errorResponse("invalid_team_id", 400);
  }
  const principal = context.get("principal");
  if ("issued" in principal && principal.teamId !== teamId) {
    return errorResponse("team_forbidden", 403);
  }
  const id = context.env.TEAM_COORDINATOR.idFromName(teamId);
  const stub = context.env.TEAM_COORDINATOR.get(id);
  const request = context.req.raw;
  const headers = new Headers(request.headers);
  headers.set("x-contrabass-team-id", teamId);
  const body = request.method === "GET" || request.method === "HEAD" ? void 0 : await request.arrayBuffer();
  const targetUrl = new URL(`https://team-coordinator.internal${coordinatorPath}`);
  targetUrl.search = new URL(request.url).search;
  return normalizeForwardedErrorResponse(await stub.fetch(new Request(targetUrl, {
    method: request.method,
    headers,
    body
  })));
}
__name(forwardTeamCoordinatorRequest, "forwardTeamCoordinatorRequest");
function forwardTeamCoordinatorBoardPostRequest(context) {
  const coordinatorPath = teamCoordinatorBoardPostPath(context.req.raw);
  if (coordinatorPath === void 0) {
    return errorResponse("not_found", 404);
  }
  return forwardTeamCoordinatorRequest(context, coordinatorPath);
}
__name(forwardTeamCoordinatorBoardPostRequest, "forwardTeamCoordinatorBoardPostRequest");
function teamCoordinatorBoardPostPath(request) {
  const url = new URL(request.url);
  const match2 = /^\/v1\/teams\/[^/]+\/board\/(.+)$/u.exec(url.pathname);
  const actionPath = match2?.[1];
  if (actionPath === void 0 || actionPath.trim() === "") {
    return void 0;
  }
  return `/board/${actionPath}`;
}
__name(teamCoordinatorBoardPostPath, "teamCoordinatorBoardPostPath");
async function forwardIssueRunRequest(context, issueRunPath) {
  const runId = (context.req.param("runId") ?? "").trim();
  if (runId === "") {
    return errorResponse("invalid_run_id", 400);
  }
  const teamId = resolveRunForwardTeamId(context);
  if (teamId === void 0) {
    return errorResponse("invalid_team_id", 400);
  }
  if (teamId === false) {
    return errorResponse("team_forbidden", 403);
  }
  const principal = context.get("principal");
  const request = context.req.raw;
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  headers.set("x-contrabass-team-id", teamId);
  headers.set("x-contrabass-run-id", runId);
  if ("issued" in principal) {
    headers.set("x-contrabass-worker-id", principal.workerId);
  }
  const issueRef = await lookupIssueRefForRun(context, teamId, runId);
  if (issueRef === void 0) {
    return errorResponse("run_not_found", 404);
  }
  const body = issueRunPath === "/ack" && "issued" in principal ? await ackBodyWithWorkerId(request, principal.workerId) : await request.arrayBuffer();
  const id = context.env.ISSUE_RUN.idFromName(`${teamId}:${issueRef}`);
  const stub = context.env.ISSUE_RUN.get(id);
  return normalizeForwardedErrorResponse(await stub.fetch(new Request(`https://issue-run.internal${issueRunPath}`, {
    method: request.method,
    headers,
    body
  })));
}
__name(forwardIssueRunRequest, "forwardIssueRunRequest");
async function longPollWorkerDispatch(context) {
  const workerId = (context.req.param("workerId") ?? "").trim();
  if (workerId === "") {
    return errorResponse("invalid_worker_id", 400);
  }
  const teamId = resolveWorkerScopedTeamId(context, workerId);
  if (teamId === void 0) {
    return errorResponse("invalid_team_id", 400);
  }
  if (teamId === false) {
    return errorResponse("team_forbidden", 403);
  }
  const id = context.env.TEAM_COORDINATOR.idFromName(teamId);
  const stub = context.env.TEAM_COORDINATOR.get(id);
  const request = context.req.raw;
  const headers = new Headers(request.headers);
  headers.set("x-contrabass-team-id", teamId);
  headers.set("x-contrabass-worker-id", workerId);
  const sourceUrl = new URL(request.url);
  const targetUrl = new URL(`https://team-coordinator.internal/workers/${encodeURIComponent(workerId)}/dispatch`);
  targetUrl.search = sourceUrl.search;
  return normalizeForwardedErrorResponse(await stub.fetch(new Request(targetUrl, {
    method: "GET",
    headers
  })));
}
__name(longPollWorkerDispatch, "longPollWorkerDispatch");
async function websocketWorkerDispatch(context) {
  const workerId = (context.req.param("workerId") ?? "").trim();
  if (workerId === "") {
    return errorResponse("invalid_worker_id", 400);
  }
  const teamId = resolveWorkerScopedTeamId(context, workerId);
  if (teamId === void 0) {
    return errorResponse("invalid_team_id", 400);
  }
  if (teamId === false) {
    return errorResponse("team_forbidden", 403);
  }
  const id = context.env.TEAM_COORDINATOR.idFromName(teamId);
  const stub = context.env.TEAM_COORDINATOR.get(id);
  const request = context.req.raw;
  const headers = new Headers(request.headers);
  headers.set("x-contrabass-team-id", teamId);
  headers.set("x-contrabass-worker-id", workerId);
  const sourceUrl = new URL(request.url);
  const targetUrl = new URL("https://team-coordinator.internal/subscribe");
  targetUrl.search = sourceUrl.search;
  targetUrl.searchParams.set("workerId", workerId);
  return normalizeForwardedErrorResponse(await stub.fetch(new Request(targetUrl, {
    method: "GET",
    headers
  })));
}
__name(websocketWorkerDispatch, "websocketWorkerDispatch");
async function lookupIssueRefForRun(context, teamId, runId) {
  const id = context.env.TEAM_COORDINATOR.idFromName(teamId);
  const stub = context.env.TEAM_COORDINATOR.get(id);
  const headers = new Headers(context.req.raw.headers);
  headers.set("x-contrabass-team-id", teamId);
  const response = await stub.fetch(new Request("https://team-coordinator.internal/board", {
    method: "GET",
    headers
  }));
  if (!response.ok) {
    return void 0;
  }
  let body;
  try {
    body = await response.json();
  } catch {
    return void 0;
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return void 0;
  }
  const board = body.board;
  if (board === null || typeof board !== "object" || Array.isArray(board)) {
    return void 0;
  }
  for (const entries of Object.values(board)) {
    if (!Array.isArray(entries)) {
      continue;
    }
    for (const entry of entries) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }
      const record = entry;
      if (record.runId === runId && typeof record.issueRef === "string" && record.issueRef.trim() !== "") {
        return record.issueRef;
      }
    }
  }
  return void 0;
}
__name(lookupIssueRefForRun, "lookupIssueRefForRun");
function resolveRunForwardTeamId(context) {
  const principal = context.get("principal");
  const headerTeamId = context.req.raw.headers.get("x-contrabass-team-id")?.trim();
  if ("issued" in principal) {
    if (headerTeamId !== void 0 && headerTeamId.length > 0 && headerTeamId !== principal.teamId) {
      return false;
    }
    return principal.teamId;
  }
  return headerTeamId === void 0 || headerTeamId.length === 0 ? void 0 : headerTeamId;
}
__name(resolveRunForwardTeamId, "resolveRunForwardTeamId");
function resolveWorkerScopedTeamId(context, workerId) {
  const principal = context.get("principal");
  const headerTeamId = context.req.raw.headers.get("x-contrabass-team-id")?.trim();
  if ("issued" in principal) {
    if (workerId !== principal.workerId) {
      return false;
    }
    if (headerTeamId !== void 0 && headerTeamId.length > 0 && headerTeamId !== principal.teamId) {
      return false;
    }
    return principal.teamId;
  }
  return headerTeamId === void 0 || headerTeamId.length === 0 ? void 0 : headerTeamId;
}
__name(resolveWorkerScopedTeamId, "resolveWorkerScopedTeamId");
async function ackBodyWithWorkerId(request, workerId) {
  const body = await readObjectBody3(request);
  return JSON.stringify({
    ...body ?? {},
    workerId
  });
}
__name(ackBodyWithWorkerId, "ackBodyWithWorkerId");
function jsonResponse3(body, status) {
  return Response.json(body, { status });
}
__name(jsonResponse3, "jsonResponse");
function errorResponse(error, status, fields = {}) {
  return jsonResponse3({
    error,
    ...fields,
    protocol_version: PROTOCOL_VERSION_CURRENT
  }, status);
}
__name(errorResponse, "errorResponse");
function protocolVersionUnsupportedResponse() {
  return errorResponse("protocol_version_unsupported", 409, { supported: [...SUPPORTED_PROTOCOL_VERSIONS] });
}
__name(protocolVersionUnsupportedResponse, "protocolVersionUnsupportedResponse");
async function normalizeForwardedErrorResponse(response) {
  if (response.status < 400) {
    return response;
  }
  let body;
  try {
    body = await response.json();
  } catch {
    return errorResponse("upstream_error", response.status);
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return errorResponse("upstream_error", response.status);
  }
  const record = body;
  if (typeof record.error !== "string" || record.error.trim() === "") {
    return errorResponse("upstream_error", response.status);
  }
  return jsonResponse3({
    ...record,
    protocol_version: PROTOCOL_VERSION_CURRENT
  }, response.status);
}
__name(normalizeForwardedErrorResponse, "normalizeForwardedErrorResponse");

// src/index.ts
async function handleRequest(request, env) {
  if (request !== void 0 && env !== void 0) {
    return handleWorkerRequest(request, env);
  }
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
  fetch(request, env) {
    return handleRequest(request, env);
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
