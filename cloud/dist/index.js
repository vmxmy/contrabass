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
    emitIssueRunMetric(this.env, {
      event: "lease_revocation",
      teamId: record.teamId ?? "",
      runId: record.runId ?? "",
      workerId: record.leaseHolder,
      reason: "heartbeat_timeout",
      leaseSec: record.leaseSec
    });
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
    emitIssueRunMetric(this.env, {
      event: "event_ingest",
      teamId,
      runId,
      workerId: workerId ?? record.leaseHolder,
      acceptedCount: messages.length,
      durationMs: Date.now() - receivedAt
    });
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
function emitIssueRunMetric(env, metric) {
  try {
    env.OBSERVABILITY_METRICS?.writeDataPoint({
      indexes: [metric.teamId],
      doubles: [
        metric.durationMs ?? 0,
        metric.acceptedCount ?? 0,
        metric.leaseSec ?? 0,
        Date.now()
      ],
      blobs: [
        metric.event,
        metric.teamId,
        metric.runId,
        metric.workerId ?? "",
        metric.reason ?? ""
      ]
    });
  } catch (error) {
    console.warn(JSON.stringify({
      event: "issue_run_metrics_error",
      teamId: metric.teamId,
      runId: metric.runId,
      message: error instanceof Error ? error.message : String(error)
    }));
  }
}
__name(emitIssueRunMetric, "emitIssueRunMetric");

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
    const currentBoard = await this.ensureBoard();
    const openEntry = currentBoard.open.find((e) => e.issueRef === issueRef);
    const now = Date.now();
    const board = mergeBoard(currentBoard, boardWithEntries([
      {
        issueRef,
        runId,
        assignedWorkerId: worker2.workerId,
        phase: "claimed",
        lastUpdated: now
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
    if (record.teamId !== void 0) {
      emitDispatchMetric(this.env, {
        teamId: record.teamId,
        runId,
        workerId: worker2.workerId,
        workerKind: worker2.kind,
        dispatchLatencyMs: openEntry !== void 0 ? now - openEntry.lastUpdated : 0
      });
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
    const existingBoard = await this.ensureBoard();
    const issueStats = boardRefreshStats(existingBoard, refreshedBoard);
    const board = isFullBoardRefreshBody(body) ? refreshedBoard : mergeBoard(existingBoard, refreshedBoard);
    await this.state.storage.put(BOARD_KEY, board);
    await this.touchRecord(request);
    this.broadcast(boardUpdateFrame(board));
    return jsonResponse2({ board, issueStats });
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
    if (notification.type === "config-changed") {
      this.broadcastToAllWorkerSubscribers(frame);
    }
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
  broadcastToAllWorkerSubscribers(frame) {
    const message = JSON.stringify(frame);
    for (const [workerId, sockets] of this.workerDispatchSubscribers) {
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
    return new Promise((resolve2) => {
      const waiters = this.workerLongPollWaiters.get(workerId) ?? /* @__PURE__ */ new Set();
      const timeout = setTimeout(() => {
        waiters.delete(resolveOnce);
        if (waiters.size === 0) {
          this.workerLongPollWaiters.delete(workerId);
        }
        resolve2(void 0);
      }, waitMs);
      const resolveOnce = /* @__PURE__ */ __name((dispatch) => {
        clearTimeout(timeout);
        resolve2(dispatch);
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
function normalizeBoard(raw3) {
  return {
    open: normalizeBoardEntries(raw3.open, "open"),
    claimed: normalizeBoardEntries(raw3.claimed, "claimed"),
    running: normalizeBoardEntries(raw3.running, "running"),
    done: normalizeBoardEntries(raw3.done, "done")
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
function boardRefreshStats(existing, updates) {
  const updatedEntries = BOARD_PHASES.flatMap((phase) => updates[phase]);
  let issuesNew = 0;
  let issuesUpdated = 0;
  for (const update of updatedEntries) {
    const existingEntry = BOARD_PHASES.flatMap((phase) => existing[phase]).find((entry) => boardEntriesReferToSameIssue(entry, update));
    if (existingEntry === void 0) {
      issuesNew += 1;
    } else if (!boardEntriesEqual(existingEntry, update)) {
      issuesUpdated += 1;
    }
  }
  return { issuesNew, issuesUpdated };
}
__name(boardRefreshStats, "boardRefreshStats");
function boardEntriesEqual(left, right) {
  return left.issueRef === right.issueRef && left.externalId === right.externalId && left.runId === right.runId && left.assignedWorkerId === right.assignedWorkerId && left.phase === right.phase && left.lastUpdated === right.lastUpdated;
}
__name(boardEntriesEqual, "boardEntriesEqual");
function mergeBoard(existing, updates) {
  const updatedEntries = BOARD_PHASES.flatMap((phase) => updates[phase]);
  const merged = emptyBoard();
  for (const phase of BOARD_PHASES) {
    merged[phase] = existing[phase].filter((entry) => {
      return !updatedEntries.some((update) => boardEntriesReferToSameIssue(entry, update));
    });
  }
  for (const phase of BOARD_PHASES) {
    merged[phase].push(...updates[phase]);
  }
  return merged;
}
__name(mergeBoard, "mergeBoard");
function boardEntriesReferToSameIssue(existing, update) {
  if (existing.externalId !== void 0 && update.externalId !== void 0) {
    return existing.externalId === update.externalId;
  }
  return existing.issueRef === update.issueRef;
}
__name(boardEntriesReferToSameIssue, "boardEntriesReferToSameIssue");
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
  const externalId = getStringField2(entry, "externalId") ?? getStringField2(entry, "external_id");
  const phase = phaseFromUnknown(entry.phase) ?? defaultPhase ?? "open";
  const runId = getStringField2(entry, "runId") ?? getStringField2(entry, "run_id");
  const assignedWorkerId = getStringField2(entry, "assignedWorkerId") ?? getStringField2(entry, "assigned_worker_id") ?? getStringField2(entry, "workerId") ?? getStringField2(entry, "worker_id");
  return {
    issueRef,
    ...externalId === void 0 ? {} : { externalId },
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
  const last2 = notifications.at(-1);
  const lastEventId = last2 === void 0 ? 0 : Number.parseInt(last2.eventId, 10);
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
  const raw3 = new URL(request.url).searchParams.get("last_event_id");
  if (raw3 === null || raw3.trim() === "") {
    return void 0;
  }
  const eventId = Number.parseInt(raw3, 10);
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
function normalizeWorkerRegistry(raw3, now) {
  const registry = {};
  for (const [workerId, worker2] of Object.entries(raw3)) {
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
function emitDispatchMetric(env, metric) {
  try {
    env.OBSERVABILITY_METRICS?.writeDataPoint({
      indexes: [metric.teamId],
      doubles: [
        metric.dispatchLatencyMs,
        Date.now()
      ],
      blobs: [
        "dispatch_latency",
        metric.teamId,
        metric.runId,
        metric.workerId,
        metric.workerKind
      ]
    });
  } catch (error) {
    console.warn(JSON.stringify({
      event: "dispatch_metrics_error",
      teamId: metric.teamId,
      runId: metric.runId,
      message: error instanceof Error ? error.message : String(error)
    }));
  }
}
__name(emitDispatchMetric, "emitDispatchMetric");
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
    const { bodyCache, raw: raw3 } = this;
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
    return bodyCache[key] = raw3[key]();
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
      const map3 = handlerData[i][j]?.[1];
      if (!map3) {
        continue;
      }
      const keys = Object.keys(map3);
      for (let k = 0, len3 = keys.length; k < len3; k++) {
        map3[keys[k]] = paramReplacementMap[map3[keys[k]]];
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
              let offset2 = path[0] === "/" ? 1 : 0;
              for (let p = 0; p < len; p++) {
                partOffsets[p] = offset2;
                offset2 += parts[p].length + 1;
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

// ../node_modules/.bun/liquidjs@10.25.7/node_modules/liquidjs/dist/liquid.browser.mjs
var Token = class {
  static {
    __name(this, "Token");
  }
  constructor(kind, input, begin, end, file) {
    this.kind = kind;
    this.input = input;
    this.begin = begin;
    this.end = end;
    this.file = file;
  }
  getText() {
    return this.input.slice(this.begin, this.end);
  }
  getPosition() {
    let [row, col] = [1, 1];
    for (let i = 0; i < this.begin; i++) {
      if (this.input[i] === "\n") {
        row++;
        col = 1;
      } else
        col++;
    }
    return [row, col];
  }
  size() {
    return this.end - this.begin;
  }
};
var Drop = class {
  static {
    __name(this, "Drop");
  }
  liquidMethodMissing(key, context) {
    return void 0;
  }
};
var toString$1 = Object.prototype.toString;
var toLowerCase = String.prototype.toLowerCase;
var hasOwnProperty = Object.hasOwnProperty;
function isString(value) {
  return typeof value === "string";
}
__name(isString, "isString");
function isFunction(value) {
  return typeof value === "function";
}
__name(isFunction, "isFunction");
function isPromise(val) {
  return val && isFunction(val.then);
}
__name(isPromise, "isPromise");
function isIterator(val) {
  return val && isFunction(val.next) && isFunction(val.throw) && isFunction(val.return);
}
__name(isIterator, "isIterator");
function stringify(value) {
  value = toValue(value);
  if (isString(value))
    return value;
  if (isNil(value))
    return "";
  if (isArray(value))
    return value.map((x) => stringify(x)).join("");
  return String(value);
}
__name(stringify, "stringify");
function toEnumerable(val) {
  val = toValue(val);
  if (isArray(val))
    return val;
  if (isString(val) && val.length > 0)
    return [val];
  if (isIterable(val))
    return Array.from(val);
  if (isObject(val))
    return Object.keys(val).map((key) => [key, val[key]]);
  return [];
}
__name(toEnumerable, "toEnumerable");
function toArray(val) {
  val = toValue(val);
  if (isNil(val))
    return [];
  if (isArray(val))
    return val;
  return [val];
}
__name(toArray, "toArray");
function toValue(value) {
  return value instanceof Drop && isFunction(value.valueOf) ? value.valueOf() : value;
}
__name(toValue, "toValue");
function toNumber(value) {
  return +toValue(value) || 0;
}
__name(toNumber, "toNumber");
function isNumber(value) {
  return typeof value === "number";
}
__name(isNumber, "isNumber");
function toLiquid(value) {
  if (value && isFunction(value.toLiquid))
    return toLiquid(value.toLiquid());
  return value;
}
__name(toLiquid, "toLiquid");
function isNil(value) {
  return value == null;
}
__name(isNil, "isNil");
function isUndefined(value) {
  return value === void 0;
}
__name(isUndefined, "isUndefined");
function isArray(value) {
  return toString$1.call(value) === "[object Array]";
}
__name(isArray, "isArray");
function isArrayLike(value) {
  return value && isNumber(value.length);
}
__name(isArrayLike, "isArrayLike");
function isIterable(value) {
  return isObject(value) && Symbol.iterator in value;
}
__name(isIterable, "isIterable");
function forOwn(obj, iteratee) {
  obj = obj || {};
  for (const k in obj) {
    if (hasOwnProperty.call(obj, k)) {
      if (iteratee(obj[k], k, obj) === false)
        break;
    }
  }
  return obj;
}
__name(forOwn, "forOwn");
function last(arr) {
  return arr[arr.length - 1];
}
__name(last, "last");
function isObject(value) {
  const type = typeof value;
  return value !== null && (type === "object" || type === "function");
}
__name(isObject, "isObject");
function range(start, stop, step = 1) {
  const arr = [];
  for (let i = start; i < stop; i += step) {
    arr.push(i);
  }
  return arr;
}
__name(range, "range");
function padStart(str, length, ch = " ") {
  return pad(str, length, ch, (str2, ch2) => ch2 + str2);
}
__name(padStart, "padStart");
function padEnd(str, length, ch = " ") {
  return pad(str, length, ch, (str2, ch2) => str2 + ch2);
}
__name(padEnd, "padEnd");
function pad(str, length, ch, add) {
  str = String(str);
  let n = length - str.length;
  while (n-- > 0)
    str = add(str, ch);
  return str;
}
__name(pad, "pad");
function identify(val) {
  return val;
}
__name(identify, "identify");
function changeCase(str) {
  const hasLowerCase = [...str].some((ch) => ch >= "a" && ch <= "z");
  return hasLowerCase ? str.toUpperCase() : str.toLowerCase();
}
__name(changeCase, "changeCase");
function ellipsis(str, N) {
  return str.length > N ? str.slice(0, N - 3) + "..." : str;
}
__name(ellipsis, "ellipsis");
function orderedCompare(a, b) {
  if (isNil(a) && isNil(b))
    return 0;
  if (isNil(a))
    return 1;
  if (isNil(b))
    return -1;
  if (a < b)
    return -1;
  if (a > b)
    return 1;
  return 0;
}
__name(orderedCompare, "orderedCompare");
function caseInsensitiveCompare(a, b) {
  if (isNil(a) && isNil(b))
    return 0;
  if (isNil(a))
    return 1;
  if (isNil(b))
    return -1;
  a = toLowerCase.call(a);
  b = toLowerCase.call(b);
  if (a < b)
    return -1;
  if (a > b)
    return 1;
  return 0;
}
__name(caseInsensitiveCompare, "caseInsensitiveCompare");
function argumentsToValue(fn) {
  return function(...args) {
    return fn.call(this, ...args.map(toValue));
  };
}
__name(argumentsToValue, "argumentsToValue");
function argumentsToNumber(fn) {
  return function(...args) {
    return fn.call(this, ...args.map(toNumber));
  };
}
__name(argumentsToNumber, "argumentsToNumber");
function* strictUniq(array) {
  const seen = /* @__PURE__ */ new Set();
  for (const element of array) {
    const key = JSON.stringify(element);
    if (!seen.has(key)) {
      seen.add(key);
      yield element;
    }
  }
}
__name(strictUniq, "strictUniq");
var TRAIT = "__liquidClass__";
var LiquidError = class extends Error {
  static {
    __name(this, "LiquidError");
  }
  constructor(err, token) {
    super(typeof err === "string" ? err : err.message);
    this.context = "";
    if (typeof err !== "string")
      Object.defineProperty(this, "originalError", { value: err, enumerable: false });
    Object.defineProperty(this, "token", { value: token, enumerable: false });
    Object.defineProperty(this, TRAIT, { value: "LiquidError", enumerable: false });
  }
  update() {
    Object.defineProperty(this, "context", { value: mkContext(this.token), enumerable: false });
    this.message = mkMessage(this.message, this.token);
    this.stack = this.message + "\n" + this.context + "\n" + this.stack;
    if (this.originalError)
      this.stack += "\nFrom " + this.originalError.stack;
  }
  static is(obj) {
    return (obj === null || obj === void 0 ? void 0 : obj[TRAIT]) === "LiquidError";
  }
};
var TokenizationError = class extends LiquidError {
  static {
    __name(this, "TokenizationError");
  }
  constructor(message, token) {
    super(message, token);
    this.name = "TokenizationError";
    super.update();
  }
};
var ParseError = class extends LiquidError {
  static {
    __name(this, "ParseError");
  }
  constructor(err, token) {
    super(err, token);
    this.name = "ParseError";
    this.message = err.message;
    super.update();
  }
};
var RenderError = class extends LiquidError {
  static {
    __name(this, "RenderError");
  }
  constructor(err, tpl) {
    super(err, tpl.token);
    this.name = "RenderError";
    this.message = err.message;
    super.update();
  }
  static is(obj) {
    return obj.name === "RenderError";
  }
};
var LiquidErrors = class extends LiquidError {
  static {
    __name(this, "LiquidErrors");
  }
  constructor(errors) {
    super(errors[0], errors[0].token);
    this.errors = errors;
    this.name = "LiquidErrors";
    const s = errors.length > 1 ? "s" : "";
    this.message = `${errors.length} error${s} found`;
    super.update();
  }
  static is(obj) {
    return obj.name === "LiquidErrors";
  }
};
var UndefinedVariableError = class extends LiquidError {
  static {
    __name(this, "UndefinedVariableError");
  }
  constructor(err, token) {
    super(err, token);
    this.name = "UndefinedVariableError";
    this.message = err.message;
    super.update();
  }
};
var InternalUndefinedVariableError = class extends Error {
  static {
    __name(this, "InternalUndefinedVariableError");
  }
  constructor(variableName) {
    super(`undefined variable: ${variableName}`);
    this.name = "InternalUndefinedVariableError";
    this.variableName = variableName;
  }
};
var AssertionError = class extends Error {
  static {
    __name(this, "AssertionError");
  }
  constructor(message) {
    super(message);
    this.name = "AssertionError";
    this.message = message + "";
  }
};
function mkContext(token) {
  const [line, col] = token.getPosition();
  const lines = token.input.split("\n");
  const begin = Math.max(line - 2, 1);
  const end = Math.min(line + 3, lines.length);
  const context = range(begin, end + 1).map((lineNumber) => {
    const rowIndicator = lineNumber === line ? ">> " : "   ";
    const num = padStart(String(lineNumber), String(end).length);
    let text = `${rowIndicator}${num}| `;
    const colIndicator = lineNumber === line ? "\n" + padStart("^", col + text.length) : "";
    text += lines[lineNumber - 1];
    text += colIndicator;
    return text;
  }).join("\n");
  return context;
}
__name(mkContext, "mkContext");
function mkMessage(msg, token) {
  if (token.file)
    msg += `, file:${token.file}`;
  const [line, col] = token.getPosition();
  msg += `, line:${line}, col:${col}`;
  return msg;
}
__name(mkMessage, "mkMessage");
var TYPES = [0, 0, 0, 0, 0, 0, 0, 0, 0, 20, 4, 4, 4, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 20, 2, 8, 0, 0, 0, 0, 8, 0, 0, 0, 64, 0, 65, 0, 0, 33, 33, 33, 33, 33, 33, 33, 33, 33, 33, 0, 0, 2, 2, 2, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0];
var WORD = 1;
var BLANK = 4;
var QUOTE = 8;
var INLINE_BLANK = 16;
var NUMBER = 32;
var SIGN = 64;
var PUNCTUATION = 128;
function isWord(char) {
  const code = char.charCodeAt(0);
  return code >= 128 ? !TYPES[code] : !!(TYPES[code] & WORD);
}
__name(isWord, "isWord");
TYPES[160] = TYPES[5760] = TYPES[6158] = TYPES[8192] = TYPES[8193] = TYPES[8194] = TYPES[8195] = TYPES[8196] = TYPES[8197] = TYPES[8198] = TYPES[8199] = TYPES[8200] = TYPES[8201] = TYPES[8202] = TYPES[8232] = TYPES[8233] = TYPES[8239] = TYPES[8287] = TYPES[12288] = BLANK;
TYPES[8220] = TYPES[8221] = PUNCTUATION;
function assert(predicate, message) {
  if (!predicate) {
    const msg = typeof message === "function" ? message() : message || `expect ${predicate} to be true`;
    throw new AssertionError(msg);
  }
}
__name(assert, "assert");
function assertEmpty(predicate, message = `unexpected ${JSON.stringify(predicate)}`) {
  assert(!predicate, message);
}
__name(assertEmpty, "assertEmpty");
var NullDrop = class extends Drop {
  static {
    __name(this, "NullDrop");
  }
  equals(value) {
    return isNil(toValue(value));
  }
  gt() {
    return false;
  }
  geq() {
    return false;
  }
  lt() {
    return false;
  }
  leq() {
    return false;
  }
  valueOf() {
    return null;
  }
};
var EmptyDrop = class _EmptyDrop extends Drop {
  static {
    __name(this, "EmptyDrop");
  }
  equals(value) {
    if (value instanceof _EmptyDrop)
      return false;
    value = toValue(value);
    if (isString(value) || isArray(value))
      return value.length === 0;
    if (isObject(value))
      return Object.keys(value).length === 0;
    return false;
  }
  gt() {
    return false;
  }
  geq() {
    return false;
  }
  lt() {
    return false;
  }
  leq() {
    return false;
  }
  valueOf() {
    return "";
  }
  static is(value) {
    return value instanceof _EmptyDrop;
  }
};
var BlankDrop = class _BlankDrop extends EmptyDrop {
  static {
    __name(this, "BlankDrop");
  }
  equals(value) {
    if (value === false)
      return true;
    if (isNil(toValue(value)))
      return true;
    if (isString(value))
      return /^\s*$/.test(value);
    return super.equals(value);
  }
  static is(value) {
    return value instanceof _BlankDrop;
  }
};
var ForloopDrop = class extends Drop {
  static {
    __name(this, "ForloopDrop");
  }
  constructor(length, collection, variable) {
    super();
    this.i = 0;
    this.length = length;
    this.name = `${variable}-${collection}`;
  }
  next() {
    this.i++;
  }
  index0() {
    return this.i;
  }
  index() {
    return this.i + 1;
  }
  first() {
    return this.i === 0;
  }
  last() {
    return this.i === this.length - 1;
  }
  rindex() {
    return this.length - this.i;
  }
  rindex0() {
    return this.length - this.i - 1;
  }
  valueOf() {
    return JSON.stringify(this);
  }
};
var SimpleEmitter = class {
  static {
    __name(this, "SimpleEmitter");
  }
  constructor() {
    this.buffer = "";
  }
  write(html) {
    this.buffer += stringify(html);
  }
};
var StreamedEmitter = class {
  static {
    __name(this, "StreamedEmitter");
  }
  constructor() {
    this.buffer = "";
    this.stream = null;
    throw new Error("streaming not supported in browser");
  }
};
var KeepingTypeEmitter = class {
  static {
    __name(this, "KeepingTypeEmitter");
  }
  constructor() {
    this.buffer = "";
  }
  write(html) {
    html = toValue(html);
    if (typeof html !== "string" && this.buffer === "") {
      this.buffer = html;
    } else {
      this.buffer = stringify(this.buffer) + stringify(html);
    }
  }
};
var BlockDrop = class extends Drop {
  static {
    __name(this, "BlockDrop");
  }
  constructor(superBlockRender = () => "") {
    super();
    this.superBlockRender = superBlockRender;
  }
  /**
   * Provide parent access in child block by
   * {{ block.super }}
   */
  *super() {
    const emitter = new SimpleEmitter();
    yield this.superBlockRender(emitter);
    return emitter.buffer;
  }
};
function isComparable(arg) {
  return arg && isFunction(arg.equals) && isFunction(arg.gt) && isFunction(arg.geq) && isFunction(arg.lt) && isFunction(arg.leq);
}
__name(isComparable, "isComparable");
var nil = new NullDrop();
var literalValues = {
  "true": true,
  "false": false,
  "nil": nil,
  "null": nil,
  "empty": new EmptyDrop(),
  "blank": new BlankDrop()
};
function createTrie(input) {
  const trie = {};
  for (const [name, data] of Object.entries(input)) {
    let node = trie;
    for (let i = 0; i < name.length; i++) {
      const c = name[i];
      node[c] = node[c] || {};
      if (i === name.length - 1 && isWord(name[i])) {
        node[c].needBoundary = true;
      }
      node = node[c];
    }
    node.data = data;
    node.end = true;
  }
  return trie;
}
__name(createTrie, "createTrie");
var __assign = /* @__PURE__ */ __name(function() {
  __assign = Object.assign || /* @__PURE__ */ __name(function __assign2(t) {
    for (var s, i = 1, n = arguments.length; i < n; i++) {
      s = arguments[i];
      for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p)) t[p] = s[p];
    }
    return t;
  }, "__assign");
  return __assign.apply(this, arguments);
}, "__assign");
function __awaiter(thisArg, _arguments, P, generator) {
  function adopt(value) {
    return value instanceof P ? value : new P(function(resolve2) {
      resolve2(value);
    });
  }
  __name(adopt, "adopt");
  return new (P || (P = Promise))(function(resolve2, reject2) {
    function fulfilled(value) {
      try {
        step(generator.next(value));
      } catch (e) {
        reject2(e);
      }
    }
    __name(fulfilled, "fulfilled");
    function rejected(value) {
      try {
        step(generator["throw"](value));
      } catch (e) {
        reject2(e);
      }
    }
    __name(rejected, "rejected");
    function step(result) {
      result.done ? resolve2(result.value) : adopt(result.value).then(fulfilled, rejected);
    }
    __name(step, "step");
    step((generator = generator.apply(thisArg, _arguments || [])).next());
  });
}
__name(__awaiter, "__awaiter");
function toLiquidAsync(asyncFn, syncFn) {
  const syncImpl = syncFn || asyncFn;
  return (sync, ...args) => {
    return sync ? syncImpl(...args) : asyncFn(...args);
  };
}
__name(toLiquidAsync, "toLiquidAsync");
function toPromise(val) {
  return __awaiter(this, void 0, void 0, function* () {
    if (!isIterator(val))
      return val;
    let value;
    let done = false;
    let next = "next";
    do {
      const state = val[next](value);
      done = state.done;
      value = state.value;
      next = "next";
      try {
        if (isIterator(value))
          value = toPromise(value);
        if (isPromise(value))
          value = yield value;
      } catch (err) {
        next = "throw";
        value = err;
      }
    } while (!done);
    return value;
  });
}
__name(toPromise, "toPromise");
function toValueSync(val) {
  if (!isIterator(val))
    return val;
  let value;
  let done = false;
  let next = "next";
  do {
    const state = val[next](value);
    done = state.done;
    value = state.value;
    next = "next";
    if (isIterator(value)) {
      try {
        value = toValueSync(value);
      } catch (err) {
        next = "throw";
        value = err;
      }
    }
  } while (!done);
  return value;
}
__name(toValueSync, "toValueSync");
var rFormat = /%([-_0^#:]+)?(\d+)?([EO])?(.)/;
function daysInMonth(d) {
  const feb = isLeapYear(d) ? 29 : 28;
  return [31, feb, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
}
__name(daysInMonth, "daysInMonth");
function getDayOfYear(d) {
  let num = 0;
  for (let i = 0; i < d.getMonth(); ++i) {
    num += daysInMonth(d)[i];
  }
  return num + d.getDate();
}
__name(getDayOfYear, "getDayOfYear");
function getWeekOfYear(d, startDay) {
  const now = getDayOfYear(d) + (startDay - d.getDay());
  const jan1 = new Date(d.getFullYear(), 0, 1);
  const then = 7 - jan1.getDay() + startDay;
  return String(Math.floor((now - then) / 7) + 1);
}
__name(getWeekOfYear, "getWeekOfYear");
function isLeapYear(d) {
  const year = d.getFullYear();
  return !!((year & 3) === 0 && (year % 100 || year % 400 === 0 && year));
}
__name(isLeapYear, "isLeapYear");
function ordinal(d) {
  const date2 = d.getDate();
  if ([11, 12, 13].includes(date2))
    return "th";
  switch (date2 % 10) {
    case 1:
      return "st";
    case 2:
      return "nd";
    case 3:
      return "rd";
    default:
      return "th";
  }
}
__name(ordinal, "ordinal");
function century(d) {
  return parseInt(d.getFullYear().toString().substring(0, 2), 10);
}
__name(century, "century");
var padWidths = {
  d: 2,
  e: 2,
  H: 2,
  I: 2,
  j: 3,
  k: 2,
  l: 2,
  L: 3,
  m: 2,
  M: 2,
  S: 2,
  U: 2,
  W: 2
};
var padSpaceChars = new Set("aAbBceklpP");
function getTimezoneOffset(d, opts) {
  const nOffset = Math.abs(d.getTimezoneOffset());
  const h = Math.floor(nOffset / 60);
  const m = nOffset % 60;
  return (d.getTimezoneOffset() > 0 ? "-" : "+") + padStart(h, 2, "0") + (opts.flags[":"] ? ":" : "") + padStart(m, 2, "0");
}
__name(getTimezoneOffset, "getTimezoneOffset");
var formatCodes = {
  a: /* @__PURE__ */ __name((d) => d.getShortWeekdayName(), "a"),
  A: /* @__PURE__ */ __name((d) => d.getLongWeekdayName(), "A"),
  b: /* @__PURE__ */ __name((d) => d.getShortMonthName(), "b"),
  B: /* @__PURE__ */ __name((d) => d.getLongMonthName(), "B"),
  c: /* @__PURE__ */ __name((d) => d.toLocaleString(), "c"),
  C: /* @__PURE__ */ __name((d) => century(d), "C"),
  d: /* @__PURE__ */ __name((d) => d.getDate(), "d"),
  e: /* @__PURE__ */ __name((d) => d.getDate(), "e"),
  H: /* @__PURE__ */ __name((d) => d.getHours(), "H"),
  I: /* @__PURE__ */ __name((d) => String(d.getHours() % 12 || 12), "I"),
  j: /* @__PURE__ */ __name((d) => getDayOfYear(d), "j"),
  k: /* @__PURE__ */ __name((d) => d.getHours(), "k"),
  l: /* @__PURE__ */ __name((d) => String(d.getHours() % 12 || 12), "l"),
  L: /* @__PURE__ */ __name((d) => d.getMilliseconds(), "L"),
  m: /* @__PURE__ */ __name((d) => d.getMonth() + 1, "m"),
  M: /* @__PURE__ */ __name((d) => d.getMinutes(), "M"),
  N: /* @__PURE__ */ __name((d, opts) => {
    const width = Number(opts.width) || 9;
    const str = String(d.getMilliseconds()).slice(0, width);
    return padEnd(str, width, "0");
  }, "N"),
  p: /* @__PURE__ */ __name((d) => d.getHours() < 12 ? "AM" : "PM", "p"),
  P: /* @__PURE__ */ __name((d) => d.getHours() < 12 ? "am" : "pm", "P"),
  q: /* @__PURE__ */ __name((d) => ordinal(d), "q"),
  s: /* @__PURE__ */ __name((d) => Math.round(d.getTime() / 1e3), "s"),
  S: /* @__PURE__ */ __name((d) => d.getSeconds(), "S"),
  u: /* @__PURE__ */ __name((d) => d.getDay() || 7, "u"),
  U: /* @__PURE__ */ __name((d) => getWeekOfYear(d, 0), "U"),
  w: /* @__PURE__ */ __name((d) => d.getDay(), "w"),
  W: /* @__PURE__ */ __name((d) => getWeekOfYear(d, 1), "W"),
  x: /* @__PURE__ */ __name((d) => d.toLocaleDateString(), "x"),
  X: /* @__PURE__ */ __name((d) => d.toLocaleTimeString(), "X"),
  y: /* @__PURE__ */ __name((d) => d.getFullYear().toString().slice(2, 4), "y"),
  Y: /* @__PURE__ */ __name((d) => d.getFullYear(), "Y"),
  z: getTimezoneOffset,
  Z: /* @__PURE__ */ __name((d, opts) => d.getTimeZoneName() || getTimezoneOffset(d, opts), "Z"),
  "t": /* @__PURE__ */ __name(() => "	", "t"),
  "n": /* @__PURE__ */ __name(() => "\n", "n"),
  "%": /* @__PURE__ */ __name(() => "%", "%")
};
formatCodes.h = formatCodes.b;
function strftime(d, formatStr) {
  let output = "";
  let remaining = formatStr;
  let match2;
  while (match2 = rFormat.exec(remaining)) {
    output += remaining.slice(0, match2.index);
    remaining = remaining.slice(match2.index + match2[0].length);
    output += format(d, match2);
  }
  return output + remaining;
}
__name(strftime, "strftime");
function format(d, match2) {
  const [input, flagStr = "", width, modifier, conversion] = match2;
  const convert = formatCodes[conversion];
  if (!convert)
    return input;
  const flags = {};
  for (const flag of flagStr)
    flags[flag] = true;
  let ret = String(convert(d, { flags, width, modifier }));
  let padChar = padSpaceChars.has(conversion) ? " " : "0";
  let padWidth = width || padWidths[conversion] || 0;
  if (flags["^"])
    ret = ret.toUpperCase();
  else if (flags["#"])
    ret = changeCase(ret);
  if (flags["_"])
    padChar = " ";
  else if (flags["0"])
    padChar = "0";
  if (flags["-"])
    padWidth = 0;
  return padStart(ret, padWidth, padChar);
}
__name(format, "format");
function getDateTimeFormat() {
  return typeof Intl !== "undefined" ? Intl.DateTimeFormat : void 0;
}
__name(getDateTimeFormat, "getDateTimeFormat");
var OneMinute = 6e4;
var TIMEZONE_PATTERN = /([zZ]|([+-])(\d{2}):?(\d{2}))$/;
var monthNames = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December"
];
var monthNamesShort = monthNames.map((name) => name.slice(0, 3));
var dayNames = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday"
];
var dayNamesShort = dayNames.map((name) => name.slice(0, 3));
var LiquidDate = class _LiquidDate {
  static {
    __name(this, "LiquidDate");
  }
  constructor(init, locale, timezone) {
    this.locale = locale;
    this.DateTimeFormat = getDateTimeFormat();
    this.date = new Date(init);
    this.timezoneFixed = timezone !== void 0;
    if (timezone === void 0) {
      timezone = this.date.getTimezoneOffset();
    }
    this.timezoneOffset = isString(timezone) ? _LiquidDate.getTimezoneOffset(timezone, this.date) : timezone;
    this.timezoneName = isString(timezone) ? timezone : "";
    const diff = (this.date.getTimezoneOffset() - this.timezoneOffset) * OneMinute;
    const time = this.date.getTime() + diff;
    this.displayDate = new Date(time);
  }
  getTime() {
    return this.displayDate.getTime();
  }
  getMilliseconds() {
    return this.displayDate.getMilliseconds();
  }
  getSeconds() {
    return this.displayDate.getSeconds();
  }
  getMinutes() {
    return this.displayDate.getMinutes();
  }
  getHours() {
    return this.displayDate.getHours();
  }
  getDay() {
    return this.displayDate.getDay();
  }
  getDate() {
    return this.displayDate.getDate();
  }
  getMonth() {
    return this.displayDate.getMonth();
  }
  getFullYear() {
    return this.displayDate.getFullYear();
  }
  toLocaleString(locale, init) {
    if (init === null || init === void 0 ? void 0 : init.timeZone) {
      return this.date.toLocaleString(locale, init);
    }
    return this.displayDate.toLocaleString(locale, init);
  }
  toLocaleTimeString(locale) {
    return this.displayDate.toLocaleTimeString(locale);
  }
  toLocaleDateString(locale) {
    return this.displayDate.toLocaleDateString(locale);
  }
  getTimezoneOffset() {
    return this.timezoneOffset;
  }
  getTimeZoneName() {
    if (this.timezoneFixed)
      return this.timezoneName;
    if (!this.DateTimeFormat)
      return;
    return this.DateTimeFormat().resolvedOptions().timeZone;
  }
  getLongMonthName() {
    var _a;
    return (_a = this.format({ month: "long" })) !== null && _a !== void 0 ? _a : monthNames[this.getMonth()];
  }
  getShortMonthName() {
    var _a;
    return (_a = this.format({ month: "short" })) !== null && _a !== void 0 ? _a : monthNamesShort[this.getMonth()];
  }
  getLongWeekdayName() {
    var _a;
    return (_a = this.format({ weekday: "long" })) !== null && _a !== void 0 ? _a : dayNames[this.displayDate.getDay()];
  }
  getShortWeekdayName() {
    var _a;
    return (_a = this.format({ weekday: "short" })) !== null && _a !== void 0 ? _a : dayNamesShort[this.displayDate.getDay()];
  }
  valid() {
    return !isNaN(this.getTime());
  }
  format(options) {
    return this.DateTimeFormat && this.DateTimeFormat(this.locale, options).format(this.displayDate);
  }
  /**
   * Create a Date object fixed to it's declared Timezone. Both
   * - 2021-08-06T02:29:00.000Z and
   * - 2021-08-06T02:29:00.000+08:00
   * will always be displayed as
   * - 2021-08-06 02:29:00
   * regardless timezoneOffset in JavaScript realm
   *
   * The implementation hack:
   * Instead of calling `.getMonth()`/`.getUTCMonth()` respect to `preserveTimezones`,
   * we create a different Date to trick strftime, it's both simpler and more performant.
   * Given that a template is expected to be parsed fewer times than rendered.
   */
  static createDateFixedToTimezone(dateString, locale) {
    const m = dateString.match(TIMEZONE_PATTERN);
    if (m && m[1] === "Z") {
      return new _LiquidDate(+new Date(dateString), locale, 0);
    }
    if (m && m[2] && m[3] && m[4]) {
      const [, , sign, hours, minutes] = m;
      const offset2 = (sign === "+" ? -1 : 1) * (parseInt(hours, 10) * 60 + parseInt(minutes, 10));
      return new _LiquidDate(+new Date(dateString), locale, offset2);
    }
    return new _LiquidDate(dateString, locale);
  }
  static getTimezoneOffset(timezoneName, date2) {
    const localDateString = date2.toLocaleString("en-US", { timeZone: timezoneName });
    const utcDateString = date2.toLocaleString("en-US", { timeZone: "UTC" });
    const localDate = new Date(localDateString);
    const utcDate = new Date(utcDateString);
    return (+utcDate - +localDate) / (60 * 1e3);
  }
};
var Limiter = class {
  static {
    __name(this, "Limiter");
  }
  constructor(resource, limit2) {
    this.base = 0;
    this.message = `${resource} limit exceeded`;
    this.limit = limit2;
  }
  use(count) {
    if (+count > 0) {
      assert(this.base + +count <= this.limit, this.message);
      this.base += +count;
    }
  }
  check(count) {
    if (+count > 0) {
      assert(+count <= this.limit, this.message);
    }
  }
};
var DelimitedToken = class extends Token {
  static {
    __name(this, "DelimitedToken");
  }
  constructor(kind, [contentBegin, contentEnd], input, begin, end, trimLeft2, trimRight2, file) {
    super(kind, input, begin, end, file);
    this.trimLeft = false;
    this.trimRight = false;
    const tl = input[contentBegin] === "-";
    const tr = input[contentEnd - 1] === "-";
    let l = tl ? contentBegin + 1 : contentBegin;
    let r = tr ? contentEnd - 1 : contentEnd;
    while (l < r && TYPES[input.charCodeAt(l)] & BLANK)
      l++;
    while (r > l && TYPES[input.charCodeAt(r - 1)] & BLANK)
      r--;
    this.contentRange = [l, r];
    this.trimLeft = tl || trimLeft2;
    this.trimRight = tr || trimRight2;
  }
  get content() {
    return this.input.slice(this.contentRange[0], this.contentRange[1]);
  }
};
var TagToken = class extends DelimitedToken {
  static {
    __name(this, "TagToken");
  }
  constructor(input, begin, end, options, file) {
    const { trimTagLeft, trimTagRight, tagDelimiterLeft, tagDelimiterRight } = options;
    const [valueBegin, valueEnd] = [begin + tagDelimiterLeft.length, end - tagDelimiterRight.length];
    super(TokenKind.Tag, [valueBegin, valueEnd], input, begin, end, trimTagLeft, trimTagRight, file);
    this.tokenizer = new Tokenizer(input, options.operators, file, this.contentRange);
    this.name = this.tokenizer.readTagName();
    this.tokenizer.assert(this.name, `illegal tag syntax, tag name expected`);
    this.tokenizer.skipBlank();
    this.args = this.tokenizer.input.slice(this.tokenizer.p, this.contentRange[1]);
  }
};
var OutputToken = class extends DelimitedToken {
  static {
    __name(this, "OutputToken");
  }
  constructor(input, begin, end, options, file) {
    const { trimOutputLeft, trimOutputRight, outputDelimiterLeft, outputDelimiterRight } = options;
    const valueRange = [begin + outputDelimiterLeft.length, end - outputDelimiterRight.length];
    super(TokenKind.Output, valueRange, input, begin, end, trimOutputLeft, trimOutputRight, file);
  }
};
var HTMLToken = class extends Token {
  static {
    __name(this, "HTMLToken");
  }
  constructor(input, begin, end, file) {
    super(TokenKind.HTML, input, begin, end, file);
    this.input = input;
    this.begin = begin;
    this.end = end;
    this.file = file;
    this.trimLeft = 0;
    this.trimRight = 0;
  }
  getContent() {
    return this.input.slice(this.begin + this.trimLeft, this.end - this.trimRight);
  }
};
var NumberToken = class extends Token {
  static {
    __name(this, "NumberToken");
  }
  constructor(input, begin, end, file) {
    super(TokenKind.Number, input, begin, end, file);
    this.input = input;
    this.begin = begin;
    this.end = end;
    this.file = file;
    this.content = Number(this.getText());
  }
};
var IdentifierToken = class extends Token {
  static {
    __name(this, "IdentifierToken");
  }
  constructor(input, begin, end, file) {
    super(TokenKind.Word, input, begin, end, file);
    this.input = input;
    this.begin = begin;
    this.end = end;
    this.file = file;
    this.content = this.getText();
  }
};
var LiteralToken = class extends Token {
  static {
    __name(this, "LiteralToken");
  }
  constructor(input, begin, end, file) {
    super(TokenKind.Literal, input, begin, end, file);
    this.input = input;
    this.begin = begin;
    this.end = end;
    this.file = file;
    this.literal = this.getText();
    this.content = literalValues[this.literal];
  }
};
var operatorPrecedences = {
  "==": 2,
  "!=": 2,
  ">": 2,
  "<": 2,
  ">=": 2,
  "<=": 2,
  "contains": 2,
  "not": 1,
  "and": 0,
  "or": 0
};
var operatorTypes = {
  "==": 0,
  "!=": 0,
  ">": 0,
  "<": 0,
  ">=": 0,
  "<=": 0,
  "contains": 0,
  "not": 1,
  "and": 0,
  "or": 0
  /* OperatorType.Binary */
};
var OperatorToken = class extends Token {
  static {
    __name(this, "OperatorToken");
  }
  constructor(input, begin, end, file) {
    super(TokenKind.Operator, input, begin, end, file);
    this.input = input;
    this.begin = begin;
    this.end = end;
    this.file = file;
    this.operator = this.getText();
  }
  getPrecedence() {
    const key = this.getText();
    return key in operatorPrecedences ? operatorPrecedences[key] : 1;
  }
};
var PropertyAccessToken = class extends Token {
  static {
    __name(this, "PropertyAccessToken");
  }
  constructor(variable, props, input, begin, end, file) {
    super(TokenKind.PropertyAccess, input, begin, end, file);
    this.variable = variable;
    this.props = props;
  }
};
var FilterToken = class extends Token {
  static {
    __name(this, "FilterToken");
  }
  constructor(name, args, input, begin, end, file) {
    super(TokenKind.Filter, input, begin, end, file);
    this.name = name;
    this.args = args;
  }
};
var HashToken = class extends Token {
  static {
    __name(this, "HashToken");
  }
  constructor(input, begin, end, name, value, file) {
    super(TokenKind.Hash, input, begin, end, file);
    this.input = input;
    this.begin = begin;
    this.end = end;
    this.name = name;
    this.value = value;
    this.file = file;
  }
};
var rHex = /[\da-fA-F]/;
var rOct = /[0-7]/;
var escapeChar = {
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "	",
  v: "\v"
};
function hexVal(c) {
  const code = c.charCodeAt(0);
  if (code >= 97)
    return code - 87;
  if (code >= 65)
    return code - 55;
  return code - 48;
}
__name(hexVal, "hexVal");
function parseStringLiteral(str) {
  let ret = "";
  for (let i = 1; i < str.length - 1; i++) {
    if (str[i] !== "\\") {
      ret += str[i];
      continue;
    }
    if (escapeChar[str[i + 1]] !== void 0) {
      ret += escapeChar[str[++i]];
    } else if (str[i + 1] === "u") {
      let val = 0;
      let j = i + 2;
      while (j <= i + 5 && rHex.test(str[j])) {
        val = val * 16 + hexVal(str[j++]);
      }
      i = j - 1;
      ret += String.fromCharCode(val);
    } else if (!rOct.test(str[i + 1])) {
      ret += str[++i];
    } else {
      let j = i + 1;
      let val = 0;
      while (j <= i + 3 && rOct.test(str[j])) {
        val = val * 8 + hexVal(str[j++]);
      }
      i = j - 1;
      ret += String.fromCharCode(val);
    }
  }
  return ret;
}
__name(parseStringLiteral, "parseStringLiteral");
var QuotedToken = class extends Token {
  static {
    __name(this, "QuotedToken");
  }
  constructor(input, begin, end, file) {
    super(TokenKind.Quoted, input, begin, end, file);
    this.input = input;
    this.begin = begin;
    this.end = end;
    this.file = file;
    this.content = parseStringLiteral(this.getText());
  }
};
var RangeToken = class extends Token {
  static {
    __name(this, "RangeToken");
  }
  constructor(input, begin, end, lhs, rhs, file) {
    super(TokenKind.Range, input, begin, end, file);
    this.input = input;
    this.begin = begin;
    this.end = end;
    this.lhs = lhs;
    this.rhs = rhs;
    this.file = file;
  }
};
var LiquidTagToken = class extends DelimitedToken {
  static {
    __name(this, "LiquidTagToken");
  }
  constructor(input, begin, end, options, file) {
    super(TokenKind.Tag, [begin, end], input, begin, end, false, false, file);
    this.tokenizer = new Tokenizer(input, options.operators, file, this.contentRange);
    this.name = this.tokenizer.readTagName();
    this.tokenizer.assert(this.name, "illegal liquid tag syntax");
    this.tokenizer.skipBlank();
  }
  get args() {
    return this.tokenizer.input.slice(this.tokenizer.p, this.contentRange[1]);
  }
};
var FilteredValueToken = class extends Token {
  static {
    __name(this, "FilteredValueToken");
  }
  constructor(initial, filters2, input, begin, end, file) {
    super(TokenKind.FilteredValue, input, begin, end, file);
    this.initial = initial;
    this.filters = filters2;
    this.input = input;
    this.begin = begin;
    this.end = end;
    this.file = file;
  }
};
var polyfill = {
  now: /* @__PURE__ */ __name(() => Date.now(), "now")
};
function getPerformance() {
  return typeof global === "object" && global.performance || typeof window === "object" && window.performance || polyfill;
}
__name(getPerformance, "getPerformance");
var Render = class {
  static {
    __name(this, "Render");
  }
  renderTemplatesToNodeStream(templates, ctx) {
    const emitter = new StreamedEmitter();
    Promise.resolve().then(() => toPromise(this.renderTemplates(templates, ctx, emitter))).then(() => emitter.end(), (err) => emitter.error(err));
    return emitter.stream;
  }
  *renderTemplates(templates, ctx, emitter) {
    if (!emitter) {
      emitter = ctx.opts.keepOutputType ? new KeepingTypeEmitter() : new SimpleEmitter();
    }
    const errors = [];
    for (const tpl of templates) {
      ctx.renderLimit.check(getPerformance().now());
      try {
        const html = yield tpl.render(ctx, emitter);
        html && emitter.write(html);
        if (ctx.breakCalled || ctx.continueCalled)
          break;
      } catch (e) {
        const err = LiquidError.is(e) ? e : new RenderError(e, tpl);
        if (ctx.opts.catchAllErrors)
          errors.push(err);
        else
          throw err;
      }
    }
    if (errors.length) {
      throw new LiquidErrors(errors);
    }
    return emitter.buffer;
  }
};
var Expression = class {
  static {
    __name(this, "Expression");
  }
  constructor(tokens) {
    this.postfix = [...toPostfix(tokens)];
  }
  *evaluate(ctx, lenient) {
    assert(ctx, "unable to evaluate: context not defined");
    const operands = [];
    for (const token of this.postfix) {
      if (isOperatorToken(token)) {
        const r = operands.pop();
        let result;
        if (operatorTypes[token.operator] === 1) {
          result = yield ctx.opts.operators[token.operator](r, ctx);
        } else {
          const l = operands.pop();
          result = yield ctx.opts.operators[token.operator](l, r, ctx);
        }
        operands.push(result);
      } else {
        operands.push(yield evalToken(token, ctx, lenient));
      }
    }
    return operands[0];
  }
  valid() {
    return !!this.postfix.length;
  }
};
function* evalToken(token, ctx, lenient = false) {
  if (!token)
    return;
  if ("content" in token)
    return token.content;
  if (isPropertyAccessToken(token))
    return yield evalPropertyAccessToken(token, ctx, lenient);
  if (isRangeToken(token))
    return yield evalRangeToken(token, ctx);
}
__name(evalToken, "evalToken");
function* evalPropertyAccessToken(token, ctx, lenient) {
  const props = [];
  for (const prop of token.props) {
    props.push(yield evalToken(prop, ctx, false));
  }
  try {
    if (token.variable) {
      const variable = yield evalToken(token.variable, ctx, lenient);
      return yield ctx._getFromScope(variable, props);
    } else {
      return yield ctx._get(props);
    }
  } catch (e) {
    if (lenient && e.name === "InternalUndefinedVariableError")
      return null;
    throw new UndefinedVariableError(e, token);
  }
}
__name(evalPropertyAccessToken, "evalPropertyAccessToken");
function evalQuotedToken(token) {
  return token.content;
}
__name(evalQuotedToken, "evalQuotedToken");
function* evalRangeToken(token, ctx) {
  const low = yield evalToken(token.lhs, ctx);
  const high = yield evalToken(token.rhs, ctx);
  ctx.memoryLimit.use(high - low + 1);
  return range(+low, +high + 1);
}
__name(evalRangeToken, "evalRangeToken");
function* toPostfix(tokens) {
  const ops = [];
  for (const token of tokens) {
    if (isOperatorToken(token)) {
      while (ops.length && ops[ops.length - 1].getPrecedence() > token.getPrecedence()) {
        yield ops.pop();
      }
      ops.push(token);
    } else
      yield token;
  }
  while (ops.length) {
    yield ops.pop();
  }
}
__name(toPostfix, "toPostfix");
function isTruthy(val, ctx) {
  return !isFalsy(val, ctx);
}
__name(isTruthy, "isTruthy");
function isFalsy(val, ctx) {
  val = toValue(val);
  if (ctx.opts.jsTruthy) {
    return !val;
  } else {
    return val === false || void 0 === val || val === null;
  }
}
__name(isFalsy, "isFalsy");
var defaultOperators = {
  "==": equals,
  "!=": /* @__PURE__ */ __name((l, r) => !equals(l, r), "!="),
  ">": /* @__PURE__ */ __name((l, r) => {
    if (isComparable(l))
      return l.gt(r);
    if (isComparable(r))
      return r.lt(l);
    return toValue(l) > toValue(r);
  }, ">"),
  "<": /* @__PURE__ */ __name((l, r) => {
    if (isComparable(l))
      return l.lt(r);
    if (isComparable(r))
      return r.gt(l);
    return toValue(l) < toValue(r);
  }, "<"),
  ">=": /* @__PURE__ */ __name((l, r) => {
    if (isComparable(l))
      return l.geq(r);
    if (isComparable(r))
      return r.leq(l);
    return toValue(l) >= toValue(r);
  }, ">="),
  "<=": /* @__PURE__ */ __name((l, r) => {
    if (isComparable(l))
      return l.leq(r);
    if (isComparable(r))
      return r.geq(l);
    return toValue(l) <= toValue(r);
  }, "<="),
  "contains": /* @__PURE__ */ __name((l, r) => {
    l = toValue(l);
    if (isArray(l))
      return l.some((i) => equals(i, r));
    if (isFunction(l === null || l === void 0 ? void 0 : l.indexOf))
      return l.indexOf(toValue(r)) > -1;
    return false;
  }, "contains"),
  "not": /* @__PURE__ */ __name((v, ctx) => isFalsy(toValue(v), ctx), "not"),
  "and": /* @__PURE__ */ __name((l, r, ctx) => isTruthy(toValue(l), ctx) && isTruthy(toValue(r), ctx), "and"),
  "or": /* @__PURE__ */ __name((l, r, ctx) => isTruthy(toValue(l), ctx) || isTruthy(toValue(r), ctx), "or")
};
function equals(lhs, rhs) {
  if (isComparable(lhs))
    return lhs.equals(rhs);
  if (isComparable(rhs))
    return rhs.equals(lhs);
  lhs = toValue(lhs);
  rhs = toValue(rhs);
  if (isArray(lhs)) {
    return isArray(rhs) && arrayEquals(lhs, rhs);
  }
  return lhs === rhs;
}
__name(equals, "equals");
function arrayEquals(lhs, rhs) {
  if (lhs.length !== rhs.length)
    return false;
  return !lhs.some((value, i) => !equals(value, rhs[i]));
}
__name(arrayEquals, "arrayEquals");
function arrayIncludes(arr, item) {
  return arr.some((value) => equals(value, item));
}
__name(arrayIncludes, "arrayIncludes");
var Node3 = class {
  static {
    __name(this, "Node");
  }
  constructor(key, value, next, prev) {
    this.key = key;
    this.value = value;
    this.next = next;
    this.prev = prev;
  }
};
var LRU = class {
  static {
    __name(this, "LRU");
  }
  constructor(limit2, size2 = 0) {
    this.limit = limit2;
    this.size = size2;
    this.cache = {};
    this.head = new Node3("HEAD", null, null, null);
    this.tail = new Node3("TAIL", null, null, null);
    this.head.next = this.tail;
    this.tail.prev = this.head;
  }
  write(key, value) {
    if (this.cache[key]) {
      this.cache[key].value = value;
    } else {
      const node = new Node3(key, value, this.head.next, this.head);
      this.head.next.prev = node;
      this.head.next = node;
      this.cache[key] = node;
      this.size++;
      this.ensureLimit();
    }
  }
  read(key) {
    if (!this.cache[key])
      return;
    const { value } = this.cache[key];
    this.remove(key);
    this.write(key, value);
    return value;
  }
  remove(key) {
    const node = this.cache[key];
    node.prev.next = node.next;
    node.next.prev = node.prev;
    delete this.cache[key];
    this.size--;
  }
  clear() {
    this.head.next = this.tail;
    this.tail.prev = this.head;
    this.size = 0;
    this.cache = {};
  }
  ensureLimit() {
    if (this.size > this.limit)
      this.remove(this.tail.prev.key);
  }
};
function domResolve(root, path) {
  const base = document.createElement("base");
  base.href = root;
  const head = document.getElementsByTagName("head")[0];
  head.insertBefore(base, head.firstChild);
  const a = document.createElement("a");
  a.href = path;
  const resolved = a.href;
  head.removeChild(base);
  return resolved;
}
__name(domResolve, "domResolve");
function resolve(root, filepath, ext) {
  if (root.length && last(root) !== "/")
    root += "/";
  const url = domResolve(root, filepath);
  return url.replace(/^(\w+:\/\/[^/]+)(\/[^?]+)/, (str, origin, path) => {
    const last2 = path.split("/").pop();
    if (/\.\w+$/.test(last2))
      return str;
    return origin + path + ext;
  });
}
__name(resolve, "resolve");
function readFile(url) {
  return __awaiter(this, void 0, void 0, function* () {
    return new Promise((resolve2, reject2) => {
      const xhr = new XMLHttpRequest();
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve2(xhr.responseText);
        } else {
          reject2(new Error(xhr.statusText));
        }
      };
      xhr.onerror = () => {
        reject2(new Error("An error occurred whilst receiving the response."));
      };
      xhr.open("GET", url);
      xhr.send();
    });
  });
}
__name(readFile, "readFile");
function readFileSync(url) {
  const xhr = new XMLHttpRequest();
  xhr.open("GET", url, false);
  xhr.send();
  if (xhr.status < 200 || xhr.status >= 300) {
    throw new Error(xhr.statusText);
  }
  return xhr.responseText;
}
__name(readFileSync, "readFileSync");
function exists(filepath) {
  return __awaiter(this, void 0, void 0, function* () {
    return true;
  });
}
__name(exists, "exists");
function existsSync(filepath) {
  return true;
}
__name(existsSync, "existsSync");
function dirname(filepath) {
  return domResolve(filepath, ".");
}
__name(dirname, "dirname");
var sep = "/";
var fs = /* @__PURE__ */ Object.freeze({
  __proto__: null,
  resolve,
  readFile,
  readFileSync,
  exists,
  existsSync,
  dirname,
  sep
});
function defaultFilter(value, defaultValue, ...args) {
  value = toValue(value);
  if (isArray(value) || isString(value))
    return value.length ? value : defaultValue;
  if (value === false && new Map(args).get("allow_false"))
    return false;
  return isFalsy(value, this.context) ? defaultValue : value;
}
__name(defaultFilter, "defaultFilter");
function json(value, space = 0) {
  return JSON.stringify(value, null, space);
}
__name(json, "json");
function inspect(value, space = 0) {
  const ancestors = [];
  return JSON.stringify(value, function(_key, value2) {
    if (typeof value2 !== "object" || value2 === null)
      return value2;
    while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this)
      ancestors.pop();
    if (ancestors.includes(value2))
      return "[Circular]";
    ancestors.push(value2);
    return value2;
  }, space);
}
__name(inspect, "inspect");
function to_integer(value) {
  return Number(value);
}
__name(to_integer, "to_integer");
var raw2 = {
  raw: true,
  handler: identify
};
var misc = {
  default: defaultFilter,
  raw: raw2,
  jsonify: json,
  to_integer,
  json,
  inspect
};
var escapeMap = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&#34;",
  "'": "&#39;"
};
var unescapeMap = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&#34;": '"',
  "&#39;": "'"
};
function escape(str) {
  str = stringify(str);
  this.context.memoryLimit.use(str.length);
  return str.replace(/&|<|>|"|'/g, (m) => escapeMap[m]);
}
__name(escape, "escape");
function xml_escape(str) {
  return escape.call(this, str);
}
__name(xml_escape, "xml_escape");
function unescape(str) {
  str = stringify(str);
  this.context.memoryLimit.use(str.length);
  return str.replace(/&(amp|lt|gt|#34|#39);/g, (m) => unescapeMap[m]);
}
__name(unescape, "unescape");
function escape_once(str) {
  return escape.call(this, unescape.call(this, str));
}
__name(escape_once, "escape_once");
function newline_to_br(v) {
  const str = stringify(v);
  this.context.memoryLimit.use(str.length);
  return str.replace(/\r?\n/gm, "<br />\n");
}
__name(newline_to_br, "newline_to_br");
function strip_html(v) {
  const str = stringify(v);
  this.context.memoryLimit.use(str.length);
  return str.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<.*?>|<!--[\s\S]*?-->/g, "");
}
__name(strip_html, "strip_html");
var htmlFilters = /* @__PURE__ */ Object.freeze({
  __proto__: null,
  escape,
  xml_escape,
  escape_once,
  newline_to_br,
  strip_html
});
var MapFS = class {
  static {
    __name(this, "MapFS");
  }
  constructor(mapping) {
    this.mapping = mapping;
    this.sep = "/";
  }
  exists(filepath) {
    return __awaiter(this, void 0, void 0, function* () {
      return this.existsSync(filepath);
    });
  }
  existsSync(filepath) {
    return !isNil(this.mapping[filepath]);
  }
  readFile(filepath) {
    return __awaiter(this, void 0, void 0, function* () {
      return this.readFileSync(filepath);
    });
  }
  readFileSync(filepath) {
    const content = this.mapping[filepath];
    if (isNil(content))
      throw new Error(`ENOENT: ${filepath}`);
    return content;
  }
  dirname(filepath) {
    const segments = filepath.split(this.sep);
    segments.pop();
    return segments.join(this.sep);
  }
  resolve(dir, file, ext) {
    file += ext;
    if (dir === ".")
      return file;
    const segments = dir.split(/\/+/);
    for (const segment of file.split(this.sep)) {
      if (segment === "." || segment === "")
        continue;
      else if (segment === "..") {
        if (segments.length > 1 || segments[0] !== "")
          segments.pop();
      } else
        segments.push(segment);
    }
    return segments.join(this.sep);
  }
};
var defaultOptions = {
  root: ["."],
  layouts: ["."],
  partials: ["."],
  relativeReference: true,
  jekyllInclude: false,
  keyValueSeparator: ":",
  cache: void 0,
  extname: "",
  fs,
  dynamicPartials: true,
  jsTruthy: false,
  dateFormat: "%A, %B %-e, %Y at %-l:%M %P %z",
  locale: "",
  trimTagRight: false,
  trimTagLeft: false,
  trimOutputRight: false,
  trimOutputLeft: false,
  greedy: true,
  tagDelimiterLeft: "{%",
  tagDelimiterRight: "%}",
  outputDelimiterLeft: "{{",
  outputDelimiterRight: "}}",
  preserveTimezones: false,
  strictFilters: false,
  strictVariables: false,
  ownPropertyOnly: true,
  lenientIf: false,
  globals: {},
  keepOutputType: false,
  operators: defaultOperators,
  memoryLimit: Infinity,
  parseLimit: Infinity,
  renderLimit: Infinity
};
function normalize(options) {
  var _a, _b;
  if (options.hasOwnProperty("root")) {
    if (!options.hasOwnProperty("partials"))
      options.partials = options.root;
    if (!options.hasOwnProperty("layouts"))
      options.layouts = options.root;
  }
  if (options.hasOwnProperty("cache")) {
    let cache;
    if (typeof options.cache === "number")
      cache = options.cache > 0 ? new LRU(options.cache) : void 0;
    else if (typeof options.cache === "object")
      cache = options.cache;
    else
      cache = options.cache ? new LRU(1024) : void 0;
    options.cache = cache;
  }
  options = Object.assign(Object.assign(Object.assign({}, defaultOptions), options.jekyllInclude ? { dynamicPartials: false } : {}), options);
  if ((!options.fs.dirname || !options.fs.sep) && options.relativeReference) {
    console.warn("[LiquidJS] `fs.dirname` and `fs.sep` are required for relativeReference, set relativeReference to `false` to suppress this warning");
    options.relativeReference = false;
  }
  options.root = normalizeDirectoryList(options.root);
  options.partials = normalizeDirectoryList(options.partials);
  options.layouts = normalizeDirectoryList(options.layouts);
  options.outputEscape = options.outputEscape && getOutputEscapeFunction(options.outputEscape);
  if (!options.locale) {
    options.locale = (_b = (_a = getDateTimeFormat()) === null || _a === void 0 ? void 0 : _a().resolvedOptions().locale) !== null && _b !== void 0 ? _b : "en-US";
  }
  if (options.templates) {
    options.fs = new MapFS(options.templates);
    options.relativeReference = true;
    options.root = options.partials = options.layouts = ".";
  }
  return options;
}
__name(normalize, "normalize");
function getOutputEscapeFunction(nameOrFunction) {
  if (nameOrFunction === "escape")
    return escape;
  if (nameOrFunction === "json")
    return misc.json;
  assert(isFunction(nameOrFunction), "`outputEscape` need to be of type string or function");
  return nameOrFunction;
}
__name(getOutputEscapeFunction, "getOutputEscapeFunction");
function normalizeDirectoryList(value) {
  let list = [];
  if (isArray(value))
    list = value;
  if (isString(value))
    list = [value];
  return list;
}
__name(normalizeDirectoryList, "normalizeDirectoryList");
function whiteSpaceCtrl(tokens, options) {
  let inRaw = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!isDelimitedToken(token))
      continue;
    if (!inRaw && token.trimLeft) {
      trimLeft(tokens[i - 1], options.greedy);
    }
    if (isTagToken(token)) {
      if (token.name === "raw")
        inRaw = true;
      else if (token.name === "endraw")
        inRaw = false;
    }
    if (!inRaw && token.trimRight) {
      trimRight(tokens[i + 1], options.greedy);
    }
  }
}
__name(whiteSpaceCtrl, "whiteSpaceCtrl");
function trimLeft(token, greedy) {
  if (!token || !isHTMLToken(token))
    return;
  const mask = greedy ? BLANK : INLINE_BLANK;
  while (TYPES[token.input.charCodeAt(token.end - 1 - token.trimRight)] & mask)
    token.trimRight++;
}
__name(trimLeft, "trimLeft");
function trimRight(token, greedy) {
  if (!token || !isHTMLToken(token))
    return;
  const mask = greedy ? BLANK : INLINE_BLANK;
  while (TYPES[token.input.charCodeAt(token.begin + token.trimLeft)] & mask)
    token.trimLeft++;
  if (token.input.charAt(token.begin + token.trimLeft) === "\n")
    token.trimLeft++;
}
__name(trimRight, "trimRight");
var Tokenizer = class {
  static {
    __name(this, "Tokenizer");
  }
  constructor(input, operators = defaultOptions.operators, file, range2) {
    this.input = input;
    this.file = file;
    this.rawBeginAt = -1;
    this.p = range2 ? range2[0] : 0;
    this.N = range2 ? range2[1] : input.length;
    this.opTrie = createTrie(operators);
    this.literalTrie = createTrie(literalValues);
  }
  readExpression() {
    return new Expression(this.readExpressionTokens());
  }
  *readExpressionTokens() {
    while (this.p < this.N) {
      const operator = this.readOperator();
      if (operator) {
        yield operator;
        continue;
      }
      const operand = this.readValue();
      if (operand) {
        yield operand;
        continue;
      }
      return;
    }
  }
  readOperator() {
    this.skipBlank();
    const end = this.matchTrie(this.opTrie);
    if (end === -1)
      return;
    return new OperatorToken(this.input, this.p, this.p = end, this.file);
  }
  matchTrie(trie) {
    let node = trie;
    let i = this.p;
    let info;
    while (node[this.input[i]] && i < this.N) {
      node = node[this.input[i++]];
      if (node["end"])
        info = node;
    }
    if (!info)
      return -1;
    if (info["needBoundary"] && isWord(this.peek(i - this.p)))
      return -1;
    return i;
  }
  readFilteredValue() {
    const begin = this.p;
    const initial = this.readExpression();
    this.assert(initial.valid(), `invalid value expression: ${this.snapshot()}`);
    const filters2 = this.readFilters();
    return new FilteredValueToken(initial, filters2, this.input, begin, this.p, this.file);
  }
  readFilters() {
    const filters2 = [];
    while (true) {
      const filter2 = this.readFilter();
      if (!filter2)
        return filters2;
      filters2.push(filter2);
    }
  }
  readFilter() {
    this.skipBlank();
    if (this.end())
      return null;
    this.assert(this.read() === "|", `expected "|" before filter`);
    const name = this.readIdentifier();
    if (!name.size()) {
      this.assert(this.end(), `expected filter name`);
      return null;
    }
    const args = [];
    this.skipBlank();
    if (this.peek() === ":") {
      do {
        ++this.p;
        const arg = this.readFilterArg();
        arg && args.push(arg);
        this.skipBlank();
        this.assert(this.end() || this.peek() === "," || this.peek() === "|", () => `unexpected character ${this.snapshot()}`);
      } while (this.peek() === ",");
    } else if (this.peek() === "|" || this.end()) ;
    else {
      throw this.error('expected ":" after filter name');
    }
    return new FilterToken(name.getText(), args, this.input, name.begin, this.p, this.file);
  }
  readFilterArg() {
    const key = this.readValue();
    if (!key)
      return;
    this.skipBlank();
    if (this.peek() !== ":")
      return key;
    ++this.p;
    const value = this.readValue();
    return [key.getText(), value];
  }
  readTopLevelTokens(options = defaultOptions) {
    const tokens = [];
    while (this.p < this.N) {
      const token = this.readTopLevelToken(options);
      tokens.push(token);
    }
    whiteSpaceCtrl(tokens, options);
    return tokens;
  }
  readTopLevelToken(options) {
    const { tagDelimiterLeft, outputDelimiterLeft } = options;
    if (this.rawBeginAt > -1)
      return this.readEndrawOrRawContent(options);
    if (this.match(tagDelimiterLeft))
      return this.readTagToken(options);
    if (this.match(outputDelimiterLeft))
      return this.readOutputToken(options);
    return this.readHTMLToken([tagDelimiterLeft, outputDelimiterLeft]);
  }
  readHTMLToken(stopStrings) {
    const begin = this.p;
    while (this.p < this.N) {
      if (stopStrings.some((str) => this.match(str)))
        break;
      ++this.p;
    }
    return new HTMLToken(this.input, begin, this.p, this.file);
  }
  readTagToken(options) {
    const { file, input } = this;
    const begin = this.p;
    if (this.readToDelimiter(options.tagDelimiterRight) === -1) {
      throw this.error(`tag ${this.snapshot(begin)} not closed`, begin);
    }
    const token = new TagToken(input, begin, this.p, options, file);
    if (token.name === "raw")
      this.rawBeginAt = begin;
    return token;
  }
  readToDelimiter(delimiter, respectQuoted = false) {
    this.skipBlank();
    while (this.p < this.N) {
      if (respectQuoted && this.peekType() & QUOTE) {
        this.readQuoted();
        continue;
      }
      ++this.p;
      if (this.rmatch(delimiter))
        return this.p;
    }
    return -1;
  }
  readOutputToken(options = defaultOptions) {
    const { file, input } = this;
    const { outputDelimiterRight } = options;
    const begin = this.p;
    if (this.readToDelimiter(outputDelimiterRight, true) === -1) {
      throw this.error(`output ${this.snapshot(begin)} not closed`, begin);
    }
    return new OutputToken(input, begin, this.p, options, file);
  }
  readEndrawOrRawContent(options) {
    const { tagDelimiterLeft, tagDelimiterRight } = options;
    const begin = this.p;
    let leftPos = this.readTo(tagDelimiterLeft) - tagDelimiterLeft.length;
    while (this.p < this.N) {
      if (this.readIdentifier().getText() !== "endraw") {
        leftPos = this.readTo(tagDelimiterLeft) - tagDelimiterLeft.length;
        continue;
      }
      while (this.p <= this.N) {
        if (this.rmatch(tagDelimiterRight)) {
          const end = this.p;
          if (begin === leftPos) {
            this.rawBeginAt = -1;
            return new TagToken(this.input, begin, end, options, this.file);
          } else {
            this.p = leftPos;
            return new HTMLToken(this.input, begin, leftPos, this.file);
          }
        }
        if (this.rmatch(tagDelimiterLeft))
          break;
        this.p++;
      }
    }
    throw this.error(`raw ${this.snapshot(this.rawBeginAt)} not closed`, begin);
  }
  readLiquidTagTokens(options = defaultOptions) {
    const tokens = [];
    while (this.p < this.N) {
      const token = this.readLiquidTagToken(options);
      token && tokens.push(token);
    }
    return tokens;
  }
  readLiquidTagToken(options) {
    this.skipBlank();
    if (this.end())
      return;
    const begin = this.p;
    this.readToDelimiter("\n");
    const end = this.p;
    return new LiquidTagToken(this.input, begin, end, options, this.file);
  }
  error(msg, pos = this.p) {
    return new TokenizationError(msg, new IdentifierToken(this.input, pos, this.N, this.file));
  }
  assert(pred, msg, pos) {
    if (!pred)
      throw this.error(typeof msg === "function" ? msg() : msg, pos);
  }
  snapshot(begin = this.p) {
    return JSON.stringify(ellipsis(this.input.slice(begin, this.N), 32));
  }
  /**
   * @deprecated use #readIdentifier instead
   */
  readWord() {
    return this.readIdentifier();
  }
  readIdentifier() {
    this.skipBlank();
    const begin = this.p;
    while (!this.end() && isWord(this.peek()))
      ++this.p;
    return new IdentifierToken(this.input, begin, this.p, this.file);
  }
  readNonEmptyIdentifier() {
    const id = this.readIdentifier();
    return id.size() ? id : void 0;
  }
  readTagName() {
    this.skipBlank();
    if (this.input[this.p] === "#")
      return this.input.slice(this.p, ++this.p);
    return this.readIdentifier().getText();
  }
  readHashes(jekyllStyle) {
    const hashes = [];
    while (true) {
      const hash = this.readHash(jekyllStyle);
      if (!hash)
        return hashes;
      hashes.push(hash);
    }
  }
  readHash(jekyllStyle) {
    this.skipBlank();
    if (this.peek() === ",")
      ++this.p;
    const begin = this.p;
    const name = this.readNonEmptyIdentifier();
    if (!name)
      return;
    let value;
    this.skipBlank();
    const sep2 = isString(jekyllStyle) ? jekyllStyle : jekyllStyle ? "=" : ":";
    if (this.peek() === sep2) {
      ++this.p;
      value = this.readValue();
    }
    return new HashToken(this.input, begin, this.p, name, value, this.file);
  }
  remaining() {
    return this.input.slice(this.p, this.N);
  }
  advance(step = 1) {
    this.p += step;
  }
  end() {
    return this.p >= this.N;
  }
  read() {
    return this.input[this.p++];
  }
  readTo(end) {
    while (this.p < this.N) {
      ++this.p;
      if (this.rmatch(end))
        return this.p;
    }
    return -1;
  }
  readValue() {
    this.skipBlank();
    const begin = this.p;
    const variable = this.readLiteral() || this.readQuoted() || this.readRange() || this.readNumber();
    const props = this.readProperties(!variable);
    if (!props.length)
      return variable;
    return new PropertyAccessToken(variable, props, this.input, begin, this.p);
  }
  readScopeValue() {
    this.skipBlank();
    const begin = this.p;
    const props = this.readProperties();
    if (!props.length)
      return void 0;
    return new PropertyAccessToken(void 0, props, this.input, begin, this.p);
  }
  readProperties(isBegin = true) {
    const props = [];
    while (true) {
      if (this.peek() === "[") {
        this.p++;
        const prop = this.readValue() || new IdentifierToken(this.input, this.p, this.p, this.file);
        this.assert(this.readTo("]") !== -1, "[ not closed");
        props.push(prop);
        continue;
      }
      if (isBegin && !props.length) {
        const prop = this.readNonEmptyIdentifier();
        if (prop) {
          props.push(prop);
          continue;
        }
      }
      if (this.peek() === "." && this.peek(1) !== ".") {
        this.p++;
        const prop = this.readNonEmptyIdentifier();
        if (!prop)
          break;
        props.push(prop);
        continue;
      }
      break;
    }
    return props;
  }
  readNumber() {
    this.skipBlank();
    let decimalFound = false;
    let digitFound = false;
    let n = 0;
    if (this.peekType() & SIGN)
      n++;
    while (this.p + n <= this.N) {
      if (this.peekType(n) & NUMBER) {
        digitFound = true;
        n++;
      } else if (this.peek(n) === "." && this.peek(n + 1) !== ".") {
        if (decimalFound || !digitFound)
          return;
        decimalFound = true;
        n++;
      } else
        break;
    }
    if (digitFound && !isWord(this.peek(n))) {
      const num = new NumberToken(this.input, this.p, this.p + n, this.file);
      this.advance(n);
      return num;
    }
  }
  readLiteral() {
    this.skipBlank();
    const end = this.matchTrie(this.literalTrie);
    if (end === -1)
      return;
    const literal = new LiteralToken(this.input, this.p, end, this.file);
    this.p = end;
    return literal;
  }
  readRange() {
    this.skipBlank();
    const begin = this.p;
    if (this.peek() !== "(")
      return;
    ++this.p;
    const lhs = this.readValueOrThrow();
    this.skipBlank();
    this.assert(this.read() === "." && this.read() === ".", "invalid range syntax");
    const rhs = this.readValueOrThrow();
    this.skipBlank();
    this.assert(this.read() === ")", "invalid range syntax");
    return new RangeToken(this.input, begin, this.p, lhs, rhs, this.file);
  }
  readValueOrThrow() {
    const value = this.readValue();
    this.assert(value, () => `unexpected token ${this.snapshot()}, value expected`);
    return value;
  }
  readQuoted() {
    this.skipBlank();
    const begin = this.p;
    if (!(this.peekType() & QUOTE))
      return;
    ++this.p;
    let escaped = false;
    while (this.p < this.N) {
      ++this.p;
      if (this.input[this.p - 1] === this.input[begin] && !escaped)
        break;
      if (escaped)
        escaped = false;
      else if (this.input[this.p - 1] === "\\")
        escaped = true;
    }
    return new QuotedToken(this.input, begin, this.p, this.file);
  }
  *readFileNameTemplate(options) {
    const { outputDelimiterLeft } = options;
    const htmlStopStrings = [",", " ", "\r", "\n", "	", outputDelimiterLeft];
    const htmlStopStringSet = new Set(htmlStopStrings);
    while (this.p < this.N && !htmlStopStringSet.has(this.peek())) {
      yield this.match(outputDelimiterLeft) ? this.readOutputToken(options) : this.readHTMLToken(htmlStopStrings);
    }
  }
  match(word) {
    for (let i = 0; i < word.length; i++) {
      if (word[i] !== this.input[this.p + i])
        return false;
    }
    return true;
  }
  rmatch(pattern) {
    for (let i = 0; i < pattern.length; i++) {
      if (pattern[pattern.length - 1 - i] !== this.input[this.p - 1 - i])
        return false;
    }
    return true;
  }
  peekType(n = 0) {
    return this.p + n >= this.N ? 0 : TYPES[this.input.charCodeAt(this.p + n)];
  }
  peek(n = 0) {
    return this.p + n >= this.N ? "" : this.input[this.p + n];
  }
  skipBlank() {
    while (this.peekType() & BLANK)
      ++this.p;
  }
};
var ParseStream = class {
  static {
    __name(this, "ParseStream");
  }
  constructor(tokens, parseToken) {
    this.handlers = {};
    this.stopRequested = false;
    this.tokens = tokens;
    this.parseToken = parseToken;
  }
  on(name, cb) {
    this.handlers[name] = cb;
    return this;
  }
  trigger(event, arg) {
    const h = this.handlers[event];
    return h ? (h.call(this, arg), true) : false;
  }
  start() {
    this.trigger("start");
    let token;
    while (!this.stopRequested && (token = this.tokens.shift())) {
      if (this.trigger("token", token))
        continue;
      if (isTagToken(token) && this.trigger(`tag:${token.name}`, token)) {
        continue;
      }
      const template = this.parseToken(token, this.tokens);
      this.trigger("template", template);
    }
    if (!this.stopRequested)
      this.trigger("end");
    return this;
  }
  stop() {
    this.stopRequested = true;
    return this;
  }
};
var TemplateImpl = class {
  static {
    __name(this, "TemplateImpl");
  }
  constructor(token) {
    this.token = token;
  }
};
var Tag = class extends TemplateImpl {
  static {
    __name(this, "Tag");
  }
  constructor(token, remainTokens, liquid) {
    super(token);
    this.name = token.name;
    this.liquid = liquid;
    this.tokenizer = token.tokenizer;
  }
};
var Hash = class {
  static {
    __name(this, "Hash");
  }
  constructor(input, jekyllStyle) {
    this.hash = {};
    const tokenizer = input instanceof Tokenizer ? input : new Tokenizer(input, {});
    for (const hash of tokenizer.readHashes(jekyllStyle)) {
      this.hash[hash.name.content] = hash.value;
    }
  }
  *render(ctx) {
    const hash = {};
    for (const key of Object.keys(this.hash)) {
      hash[key] = this.hash[key] === void 0 ? true : yield evalToken(this.hash[key], ctx);
    }
    return hash;
  }
};
function createTagClass(options) {
  return class extends Tag {
    constructor(token, tokens, liquid) {
      super(token, tokens, liquid);
      if (isFunction(options.parse)) {
        options.parse.call(this, token, tokens);
      }
    }
    *render(ctx, emitter) {
      const hash = yield new Hash(this.token.args, ctx.opts.keyValueSeparator).render(ctx);
      return yield options.render.call(this, ctx, emitter, hash);
    }
  };
}
__name(createTagClass, "createTagClass");
function isKeyValuePair(arr) {
  return isArray(arr);
}
__name(isKeyValuePair, "isKeyValuePair");
var Filter = class {
  static {
    __name(this, "Filter");
  }
  constructor(token, options, liquid) {
    this.token = token;
    this.name = token.name;
    this.handler = isFunction(options) ? options : isFunction(options === null || options === void 0 ? void 0 : options.handler) ? options.handler : identify;
    this.raw = !isFunction(options) && !!(options === null || options === void 0 ? void 0 : options.raw);
    this.args = token.args;
    this.liquid = liquid;
  }
  *render(value, context) {
    const argv = [];
    for (const arg of this.args) {
      if (isKeyValuePair(arg))
        argv.push([arg[0], yield evalToken(arg[1], context)]);
      else
        argv.push(yield evalToken(arg, context));
    }
    return yield this.handler.apply({ context, token: this.token, liquid: this.liquid }, [value, ...argv]);
  }
};
var Value = class {
  static {
    __name(this, "Value");
  }
  /**
   * @param str the value to be valuated, eg.: "foobar" | truncate: 3
   */
  constructor(input, liquid) {
    this.filters = [];
    const token = typeof input === "string" ? new Tokenizer(input, liquid.options.operators).readFilteredValue() : input;
    this.initial = token.initial;
    this.filters = token.filters.map((token2) => new Filter(token2, this.getFilter(liquid, token2.name), liquid));
  }
  *value(ctx, lenient) {
    lenient = lenient || ctx.opts.lenientIf && this.filters.length > 0 && this.filters[0].name === "default";
    let val = yield this.initial.evaluate(ctx, lenient);
    for (const filter2 of this.filters) {
      val = yield filter2.render(val, ctx);
    }
    return val;
  }
  getFilter(liquid, name) {
    const impl = liquid.filters[name];
    assert(impl || !liquid.options.strictFilters, () => `undefined filter: ${name}`);
    return impl;
  }
};
var Output = class extends TemplateImpl {
  static {
    __name(this, "Output");
  }
  constructor(token, liquid) {
    var _a;
    super(token);
    const tokenizer = new Tokenizer(token.input, liquid.options.operators, token.file, token.contentRange);
    this.value = new Value(tokenizer.readFilteredValue(), liquid);
    const filters2 = this.value.filters;
    const outputEscape = liquid.options.outputEscape;
    if (!((_a = filters2[filters2.length - 1]) === null || _a === void 0 ? void 0 : _a.raw) && outputEscape) {
      const token2 = new FilterToken(toString.call(outputEscape), [], "", 0, 0);
      filters2.push(new Filter(token2, outputEscape, liquid));
    }
  }
  *render(ctx, emitter) {
    const val = yield this.value.value(ctx, false);
    emitter.write(val);
  }
  *arguments() {
    yield this.value;
  }
};
var HTML = class extends TemplateImpl {
  static {
    __name(this, "HTML");
  }
  constructor(token) {
    super(token);
    this.str = token.getContent();
  }
  *render(ctx, emitter) {
    emitter.write(this.str);
  }
};
var Variable = class _Variable {
  static {
    __name(this, "Variable");
  }
  constructor(segments, location) {
    this.segments = segments;
    this.location = location;
  }
  toString() {
    return segmentsString(this.segments, true);
  }
  /** Return this variable's segments as an array, possibly with nested arrays for nested paths. */
  toArray() {
    function* _visit2(...segments) {
      for (const segment of segments) {
        if (segment instanceof _Variable) {
          yield Array.from(_visit2(...segment.segments));
        } else {
          yield segment;
        }
      }
    }
    __name(_visit2, "_visit");
    return Array.from(_visit2(...this.segments));
  }
};
var VariableMap = class {
  static {
    __name(this, "VariableMap");
  }
  constructor() {
    this.map = /* @__PURE__ */ new Map();
  }
  get(key) {
    const k = segmentsString([key.segments[0]]);
    if (!this.map.has(k)) {
      this.map.set(k, []);
    }
    return this.map.get(k);
  }
  has(key) {
    return this.map.has(segmentsString([key.segments[0]]));
  }
  push(variable) {
    this.get(variable).push(variable);
  }
  asObject() {
    return Object.fromEntries(this.map);
  }
};
var defaultStaticAnalysisOptions = {
  partials: true
};
function* _analyze(templates, partials, sync) {
  const variables = new VariableMap();
  const globals = new VariableMap();
  const locals = new VariableMap();
  const rootScope = new DummyScope(/* @__PURE__ */ new Set());
  const seen = /* @__PURE__ */ new Set();
  function updateVariables(variable, scope) {
    variables.push(variable);
    const aliased = scope.alias(variable);
    if (aliased !== void 0) {
      const root = aliased.segments[0];
      if (isString(root) && !rootScope.has(root)) {
        globals.push(aliased);
      }
    } else {
      const root = variable.segments[0];
      if (isString(root) && !scope.has(root)) {
        globals.push(variable);
      }
    }
    for (const segment of variable.segments) {
      if (segment instanceof Variable) {
        updateVariables(segment, scope);
      }
    }
  }
  __name(updateVariables, "updateVariables");
  function* visit3(template, scope) {
    if (template.arguments) {
      for (const arg of template.arguments()) {
        for (const variable of extractVariables(arg)) {
          updateVariables(variable, scope);
        }
      }
    }
    if (template.localScope) {
      for (const ident of template.localScope()) {
        scope.add(ident.content);
        scope.deleteAlias(ident.content);
        const [row, col] = ident.getPosition();
        locals.push(new Variable([ident.content], { row, col, file: ident.file }));
      }
    }
    if (template.children) {
      if (template.partialScope) {
        const partial = template.partialScope();
        if (partial === void 0) {
          for (const child of yield template.children(partials, sync)) {
            yield visit3(child, scope);
          }
          return;
        }
        if (seen.has(partial.name))
          return;
        const partialScopeNames = /* @__PURE__ */ new Set();
        const partialScope = partial.isolated ? new DummyScope(partialScopeNames) : scope.push(partialScopeNames);
        for (const name of partial.scope) {
          if (isString(name)) {
            partialScopeNames.add(name);
          } else {
            const [alias, argument] = name;
            partialScopeNames.add(alias);
            const variables2 = Array.from(extractVariables(argument));
            if (variables2.length) {
              partialScope.setAlias(alias, variables2[0].segments);
            }
          }
        }
        for (const child of yield template.children(partials, sync)) {
          yield visit3(child, partialScope);
          seen.add(partial.name);
        }
        partialScope.pop();
      } else {
        if (template.blockScope) {
          scope.push(new Set(template.blockScope()));
        }
        for (const child of yield template.children(partials, sync)) {
          yield visit3(child, scope);
        }
        if (template.blockScope) {
          scope.pop();
        }
      }
    }
  }
  __name(visit3, "visit");
  for (const template of templates) {
    yield visit3(template, rootScope);
  }
  return {
    variables: variables.asObject(),
    globals: globals.asObject(),
    locals: locals.asObject()
  };
}
__name(_analyze, "_analyze");
function analyze(template, options = {}) {
  const opts = Object.assign(Object.assign({}, defaultStaticAnalysisOptions), options);
  return toPromise(_analyze(template, opts.partials, false));
}
__name(analyze, "analyze");
function analyzeSync(template, options = {}) {
  const opts = Object.assign(Object.assign({}, defaultStaticAnalysisOptions), options);
  return toValueSync(_analyze(template, opts.partials, true));
}
__name(analyzeSync, "analyzeSync");
var DummyScope = class {
  static {
    __name(this, "DummyScope");
  }
  constructor(globals) {
    this.stack = [{ names: globals, aliases: /* @__PURE__ */ new Map() }];
  }
  /** Return true if `name` is in scope.  */
  has(name) {
    for (const scope of this.stack) {
      if (scope.names.has(name)) {
        return true;
      }
    }
    return false;
  }
  push(scope) {
    this.stack.push({ names: scope, aliases: /* @__PURE__ */ new Map() });
    return this;
  }
  pop() {
    var _a;
    return (_a = this.stack.pop()) === null || _a === void 0 ? void 0 : _a.names;
  }
  // Add a name to the template scope.
  add(name) {
    this.stack[0].names.add(name);
  }
  /** Return the variable that `variable` aliases, or `variable` if it doesn't alias anything. */
  alias(variable) {
    const root = variable.segments[0];
    if (!isString(root))
      return void 0;
    const alias = this.getAlias(root);
    if (alias === void 0)
      return void 0;
    return new Variable([...alias, ...variable.segments.slice(1)], variable.location);
  }
  // TODO: `from` could be a path with multiple segments, like `include.x`.
  setAlias(from, to) {
    this.stack[this.stack.length - 1].aliases.set(from, to);
  }
  deleteAlias(name) {
    this.stack[this.stack.length - 1].aliases.delete(name);
  }
  getAlias(name) {
    for (const scope of this.stack) {
      if (scope.aliases.has(name)) {
        return scope.aliases.get(name);
      }
      if (scope.names.has(name)) {
        return void 0;
      }
    }
    return void 0;
  }
};
function* extractVariables(value) {
  if (isValueToken(value)) {
    yield* extractValueTokenVariables(value);
  } else if (value instanceof Value) {
    yield* extractFilteredValueVariables(value);
  }
}
__name(extractVariables, "extractVariables");
function* extractFilteredValueVariables(value) {
  for (const token of value.initial.postfix) {
    if (isValueToken(token)) {
      yield* extractValueTokenVariables(token);
    }
  }
  for (const filter2 of value.filters) {
    for (const arg of filter2.args) {
      if (isKeyValuePair(arg) && arg[1]) {
        yield* extractValueTokenVariables(arg[1]);
      } else if (isValueToken(arg)) {
        yield* extractValueTokenVariables(arg);
      }
    }
  }
}
__name(extractFilteredValueVariables, "extractFilteredValueVariables");
function* extractValueTokenVariables(token) {
  if (isRangeToken(token)) {
    yield* extractValueTokenVariables(token.lhs);
    yield* extractValueTokenVariables(token.rhs);
  } else if (isPropertyAccessToken(token)) {
    yield extractPropertyAccessVariable(token);
  }
}
__name(extractValueTokenVariables, "extractValueTokenVariables");
function extractPropertyAccessVariable(token) {
  const segments = [];
  let file = token.file;
  const root = token.props[0];
  file = file || root.file;
  if (isQuotedToken(root) || isNumberToken(root) || isWordToken(root)) {
    segments.push(root.content);
  } else if (isPropertyAccessToken(root)) {
    segments.push(...extractPropertyAccessVariable(root).segments);
  }
  for (const prop of token.props.slice(1)) {
    file = file || prop.file;
    if (isQuotedToken(prop) || isNumberToken(prop) || isWordToken(prop)) {
      segments.push(prop.content);
    } else if (isPropertyAccessToken(prop)) {
      segments.push(extractPropertyAccessVariable(prop));
    }
  }
  const [row, col] = token.getPosition();
  return new Variable(segments, {
    row,
    col,
    file
  });
}
__name(extractPropertyAccessVariable, "extractPropertyAccessVariable");
var RE_PROPERTY = /^[\u0080-\uFFFFa-zA-Z_][\u0080-\uFFFFa-zA-Z0-9_-]*$/;
function segmentsString(segments, bracketedRoot = false) {
  const buf = [];
  const root = segments[0];
  if (isString(root)) {
    if (!bracketedRoot || root.match(RE_PROPERTY)) {
      buf.push(`${root}`);
    } else {
      buf.push(`['${root}']`);
    }
  }
  for (const segment of segments.slice(1)) {
    if (segment instanceof Variable) {
      buf.push(`[${segmentsString(segment.segments)}]`);
    } else if (isString(segment)) {
      if (segment.match(RE_PROPERTY)) {
        buf.push(`.${segment}`);
      } else {
        buf.push(`['${segment}']`);
      }
    } else {
      buf.push(`[${segment}]`);
    }
  }
  return buf.join("");
}
__name(segmentsString, "segmentsString");
var LookupType;
(function(LookupType2) {
  LookupType2["Partials"] = "partials";
  LookupType2["Layouts"] = "layouts";
  LookupType2["Root"] = "root";
})(LookupType || (LookupType = {}));
var Loader = class {
  static {
    __name(this, "Loader");
  }
  constructor(options) {
    var _a, _b, _c, _d;
    this.options = options;
    if (options.relativeReference) {
      const sep2 = options.fs.sep;
      assert(sep2, "`fs.sep` is required for relative reference");
      const prefixes = ["." + sep2, ".." + sep2, "./", "../"];
      this.shouldLoadRelative = (referencedFile) => prefixes.some((prefix) => referencedFile.startsWith(prefix));
    } else {
      this.shouldLoadRelative = (_referencedFile) => false;
    }
    const fs2 = options.fs;
    this.contains = toLiquidAsync(((_a = fs2.contains) === null || _a === void 0 ? void 0 : _a.bind(fs2)) || (() => __awaiter(this, void 0, void 0, function* () {
      return true;
    })), ((_b = fs2.containsSync) === null || _b === void 0 ? void 0 : _b.bind(fs2)) || (() => true));
    this.exists = toLiquidAsync(((_c = fs2.exists) === null || _c === void 0 ? void 0 : _c.bind(fs2)) || (() => __awaiter(this, void 0, void 0, function* () {
      return false;
    })), (_d = fs2.existsSync) === null || _d === void 0 ? void 0 : _d.bind(fs2));
  }
  *lookup(file, type, sync, currentFile) {
    const dirs = this.options[type];
    for (const filepath of this.candidates(file, dirs, currentFile)) {
      let allowed = false;
      for (const dir of dirs) {
        if (yield this.contains(!!sync, dir, filepath)) {
          allowed = true;
          break;
        }
      }
      if (!allowed)
        continue;
      if (yield this.exists(!!sync, filepath))
        return filepath;
    }
    throw this.lookupError(file, dirs);
  }
  *candidates(file, dirs, currentFile) {
    const { fs: fs2, extname } = this.options;
    if (this.shouldLoadRelative(file) && currentFile) {
      const referenced = fs2.resolve(this.dirname(currentFile), file, extname);
      yield referenced;
    }
    for (const dir of dirs) {
      const referenced = fs2.resolve(dir, file, extname);
      yield referenced;
    }
    if (fs2.fallback !== void 0) {
      const filepath = fs2.fallback(file);
      if (filepath !== void 0)
        yield filepath;
    }
  }
  dirname(path) {
    const fs2 = this.options.fs;
    assert(fs2.dirname, "`fs.dirname` is required for relative reference");
    return fs2.dirname(path);
  }
  lookupError(file, roots) {
    const err = new Error("ENOENT");
    err.message = `ENOENT: Failed to lookup "${file}" in "${roots}"`;
    err.code = "ENOENT";
    return err;
  }
};
var Parser = class {
  static {
    __name(this, "Parser");
  }
  constructor(liquid) {
    var _a, _b;
    this.liquid = liquid;
    this.cache = this.liquid.options.cache;
    this.fs = this.liquid.options.fs;
    this.parseFile = this.cache ? this._parseFileCached : this._parseFile;
    this.loader = new Loader(this.liquid.options);
    this.parseLimit = new Limiter("parse length", liquid.options.parseLimit);
    this.readFile = toLiquidAsync(((_a = this.fs.readFile) === null || _a === void 0 ? void 0 : _a.bind(this.fs)) || (() => __awaiter(this, void 0, void 0, function* () {
      throw new Error("readFile not implemented");
    })), (_b = this.fs.readFileSync) === null || _b === void 0 ? void 0 : _b.bind(this.fs));
  }
  parse(html, filepath) {
    html = String(html);
    this.parseLimit.use(html.length);
    const tokenizer = new Tokenizer(html, this.liquid.options.operators, filepath);
    const tokens = tokenizer.readTopLevelTokens(this.liquid.options);
    return this.parseTokens(tokens);
  }
  parseTokens(tokens) {
    let token;
    const templates = [];
    const errors = [];
    while (token = tokens.shift()) {
      try {
        templates.push(this.parseToken(token, tokens));
      } catch (err) {
        if (this.liquid.options.catchAllErrors)
          errors.push(err);
        else
          throw err;
      }
    }
    if (errors.length)
      throw new LiquidErrors(errors);
    return templates;
  }
  parseToken(token, remainTokens) {
    try {
      if (isTagToken(token)) {
        const TagClass = this.liquid.tags[token.name];
        assert(TagClass, `tag "${token.name}" not found`);
        return new TagClass(token, remainTokens, this.liquid, this);
      }
      if (isOutputToken(token)) {
        return new Output(token, this.liquid);
      }
      return new HTML(token);
    } catch (e) {
      if (LiquidError.is(e))
        throw e;
      throw new ParseError(e, token);
    }
  }
  parseStream(tokens) {
    return new ParseStream(tokens, (token, tokens2) => this.parseToken(token, tokens2));
  }
  *_parseFileCached(file, sync, type = LookupType.Root, currentFile) {
    const cache = this.cache;
    const key = this.loader.shouldLoadRelative(file) ? currentFile + "," + file : type + ":" + file;
    const tpls = yield cache.read(key);
    if (tpls)
      return tpls;
    const task = this._parseFile(file, sync, type, currentFile);
    const taskOrTpl = sync ? yield task : toPromise(task);
    cache.write(key, taskOrTpl);
    try {
      return yield taskOrTpl;
    } catch (err) {
      cache.remove(key);
      throw err;
    }
  }
  *_parseFile(file, sync, type = LookupType.Root, currentFile) {
    const filepath = yield this.loader.lookup(file, type, sync, currentFile);
    return this.parse(yield this.readFile(!!sync, filepath), filepath);
  }
};
var TokenKind;
(function(TokenKind2) {
  TokenKind2[TokenKind2["Number"] = 1] = "Number";
  TokenKind2[TokenKind2["Literal"] = 2] = "Literal";
  TokenKind2[TokenKind2["Tag"] = 4] = "Tag";
  TokenKind2[TokenKind2["Output"] = 8] = "Output";
  TokenKind2[TokenKind2["HTML"] = 16] = "HTML";
  TokenKind2[TokenKind2["Filter"] = 32] = "Filter";
  TokenKind2[TokenKind2["Hash"] = 64] = "Hash";
  TokenKind2[TokenKind2["PropertyAccess"] = 128] = "PropertyAccess";
  TokenKind2[TokenKind2["Word"] = 256] = "Word";
  TokenKind2[TokenKind2["Range"] = 512] = "Range";
  TokenKind2[TokenKind2["Quoted"] = 1024] = "Quoted";
  TokenKind2[TokenKind2["Operator"] = 2048] = "Operator";
  TokenKind2[TokenKind2["FilteredValue"] = 4096] = "FilteredValue";
  TokenKind2[TokenKind2["Delimited"] = 12] = "Delimited";
})(TokenKind || (TokenKind = {}));
function isDelimitedToken(val) {
  return !!(getKind(val) & TokenKind.Delimited);
}
__name(isDelimitedToken, "isDelimitedToken");
function isOperatorToken(val) {
  return getKind(val) === TokenKind.Operator;
}
__name(isOperatorToken, "isOperatorToken");
function isHTMLToken(val) {
  return getKind(val) === TokenKind.HTML;
}
__name(isHTMLToken, "isHTMLToken");
function isOutputToken(val) {
  return getKind(val) === TokenKind.Output;
}
__name(isOutputToken, "isOutputToken");
function isTagToken(val) {
  return getKind(val) === TokenKind.Tag;
}
__name(isTagToken, "isTagToken");
function isQuotedToken(val) {
  return getKind(val) === TokenKind.Quoted;
}
__name(isQuotedToken, "isQuotedToken");
function isNumberToken(val) {
  return getKind(val) === TokenKind.Number;
}
__name(isNumberToken, "isNumberToken");
function isPropertyAccessToken(val) {
  return getKind(val) === TokenKind.PropertyAccess;
}
__name(isPropertyAccessToken, "isPropertyAccessToken");
function isWordToken(val) {
  return getKind(val) === TokenKind.Word;
}
__name(isWordToken, "isWordToken");
function isRangeToken(val) {
  return getKind(val) === TokenKind.Range;
}
__name(isRangeToken, "isRangeToken");
function isValueToken(val) {
  return (getKind(val) & 1667) > 0;
}
__name(isValueToken, "isValueToken");
function getKind(val) {
  return val ? val.kind : -1;
}
__name(getKind, "getKind");
var Context2 = class _Context {
  static {
    __name(this, "Context");
  }
  constructor(env = {}, opts = defaultOptions, renderOptions = {}, { memoryLimit, renderLimit } = {}) {
    var _a, _b, _c, _d, _e;
    this.scopes = [{}];
    this.registers = {};
    this.breakCalled = false;
    this.continueCalled = false;
    this.sync = !!renderOptions.sync;
    this.opts = opts;
    this.globals = (_a = renderOptions.globals) !== null && _a !== void 0 ? _a : opts.globals;
    this.environments = isObject(env) ? env : Object(env);
    this.strictVariables = (_b = renderOptions.strictVariables) !== null && _b !== void 0 ? _b : this.opts.strictVariables;
    this.ownPropertyOnly = (_c = renderOptions.ownPropertyOnly) !== null && _c !== void 0 ? _c : opts.ownPropertyOnly;
    this.memoryLimit = memoryLimit !== null && memoryLimit !== void 0 ? memoryLimit : new Limiter("memory alloc", (_d = renderOptions.memoryLimit) !== null && _d !== void 0 ? _d : opts.memoryLimit);
    this.renderLimit = renderLimit !== null && renderLimit !== void 0 ? renderLimit : new Limiter("template render", getPerformance().now() + ((_e = renderOptions.renderLimit) !== null && _e !== void 0 ? _e : opts.renderLimit));
  }
  getRegister(key, defaultValue = void 0) {
    return this.registers[key] = this.registers[key] || defaultValue;
  }
  setRegister(key, value) {
    return this.registers[key] = value;
  }
  saveRegister(...keys) {
    return keys.map((key) => [key, this.getRegister(key)]);
  }
  restoreRegister(keyValues) {
    return keyValues.forEach(([key, value]) => this.setRegister(key, value));
  }
  getAll() {
    return [this.globals, this.environments, ...this.scopes].reduce((ctx, val) => __assign(ctx, val), {});
  }
  /**
   * @deprecated use `_get()` or `getSync()` instead
   */
  get(paths) {
    return this.getSync(paths);
  }
  getSync(paths) {
    return toValueSync(this._get(paths));
  }
  *_get(paths) {
    const scope = this.findScope(paths[0]);
    return yield this._getFromScope(scope, paths);
  }
  /**
   * @deprecated use `_get()` instead
   */
  getFromScope(scope, paths) {
    return toValueSync(this._getFromScope(scope, paths));
  }
  *_getFromScope(scope, paths, strictVariables = this.strictVariables) {
    if (isString(paths))
      paths = paths.split(".");
    for (let i = 0; i < paths.length; i++) {
      scope = yield this.readProperty(scope, paths[i]);
      if (strictVariables && isUndefined(scope)) {
        throw new InternalUndefinedVariableError(paths.slice(0, i + 1).join("."));
      }
    }
    return scope;
  }
  push(ctx) {
    return this.scopes.push(ctx);
  }
  pop() {
    return this.scopes.pop();
  }
  bottom() {
    return this.scopes[0];
  }
  spawn(scope = {}) {
    return new _Context(scope, this.opts, {
      sync: this.sync,
      globals: this.globals,
      strictVariables: this.strictVariables
    }, {
      renderLimit: this.renderLimit,
      memoryLimit: this.memoryLimit
    });
  }
  findScope(key) {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const candidate = this.scopes[i];
      if (key in candidate)
        return candidate;
    }
    if (key in this.environments)
      return this.environments;
    return this.globals;
  }
  readProperty(obj, key) {
    obj = toLiquid(obj);
    key = toValue(key);
    if (isNil(obj))
      return obj;
    if (isArray(obj) && key < 0)
      return obj[obj.length + +key];
    const value = readJSProperty(obj, key, this.ownPropertyOnly);
    if (value === void 0 && obj instanceof Drop)
      return obj.liquidMethodMissing(key, this);
    if (isFunction(value))
      return value.call(obj);
    if (key === "size")
      return readSize(obj);
    else if (key === "first")
      return readFirst(obj);
    else if (key === "last")
      return readLast(obj);
    return value;
  }
};
function readJSProperty(obj, key, ownPropertyOnly) {
  if (ownPropertyOnly && !hasOwnProperty.call(obj, key) && !(obj instanceof Drop))
    return void 0;
  return obj[key];
}
__name(readJSProperty, "readJSProperty");
function readFirst(obj) {
  if (isArray(obj))
    return obj[0];
  return obj["first"];
}
__name(readFirst, "readFirst");
function readLast(obj) {
  if (isArray(obj))
    return obj[obj.length - 1];
  return obj["last"];
}
__name(readLast, "readLast");
function readSize(obj) {
  if (hasOwnProperty.call(obj, "size") || obj["size"] !== void 0)
    return obj["size"];
  if (isArray(obj) || isString(obj))
    return obj.length;
  if (typeof obj === "object")
    return Object.keys(obj).length;
}
__name(readSize, "readSize");
var BlockMode;
(function(BlockMode2) {
  BlockMode2[BlockMode2["OUTPUT"] = 0] = "OUTPUT";
  BlockMode2[BlockMode2["STORE"] = 1] = "STORE";
})(BlockMode || (BlockMode = {}));
var abs = argumentsToNumber(Math.abs);
var at_least = argumentsToNumber(Math.max);
var at_most = argumentsToNumber(Math.min);
var ceil = argumentsToNumber(Math.ceil);
var divided_by = argumentsToNumber((dividend, divisor, integerArithmetic = false) => integerArithmetic ? Math.floor(dividend / divisor) : dividend / divisor);
var floor = argumentsToNumber(Math.floor);
var minus = argumentsToNumber((v, arg) => v - arg);
var plus = argumentsToNumber((lhs, rhs) => lhs + rhs);
var modulo = argumentsToNumber((v, arg) => v % arg);
var times = argumentsToNumber((v, arg) => v * arg);
function round(v, arg = 0) {
  v = toNumber(v);
  arg = toNumber(arg);
  const amp = Math.pow(10, arg);
  const scaled = v * amp;
  return Math.sign(v) * Math.round(Math.abs(scaled)) / amp;
}
__name(round, "round");
var mathFilters = /* @__PURE__ */ Object.freeze({
  __proto__: null,
  abs,
  at_least,
  at_most,
  ceil,
  divided_by,
  floor,
  minus,
  plus,
  modulo,
  times,
  round
});
var url_decode = /* @__PURE__ */ __name((x) => decodeURIComponent(stringify(x)).replace(/\+/g, " "), "url_decode");
var url_encode = /* @__PURE__ */ __name((x) => encodeURIComponent(stringify(x)).replace(/%20/g, "+"), "url_encode");
var cgi_escape = /* @__PURE__ */ __name((x) => encodeURIComponent(stringify(x)).replace(/%20/g, "+").replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()), "cgi_escape");
var uri_escape = /* @__PURE__ */ __name((x) => encodeURI(stringify(x)).replace(/%5B/g, "[").replace(/%5D/g, "]"), "uri_escape");
var rSlugifyDefault = /[^\p{M}\p{L}\p{Nd}]+/ug;
var rSlugifyReplacers = {
  "raw": /\s+/g,
  "default": rSlugifyDefault,
  "pretty": /[^\p{M}\p{L}\p{Nd}._~!$&'()+,;=@]+/ug,
  "ascii": /[^A-Za-z0-9]+/g,
  "latin": rSlugifyDefault,
  "none": null
};
function slugify(str, mode = "default", cased = false) {
  str = stringify(str);
  const replacer = rSlugifyReplacers[mode];
  if (replacer) {
    if (mode === "latin")
      str = removeAccents(str);
    str = str.replace(replacer, "-").replace(/^-|-$/g, "");
  }
  return cased ? str : str.toLowerCase();
}
__name(slugify, "slugify");
function removeAccents(str) {
  return str.replace(/[àáâãäå]/g, "a").replace(/[æ]/g, "ae").replace(/[ç]/g, "c").replace(/[èéêë]/g, "e").replace(/[ìíîï]/g, "i").replace(/[ð]/g, "d").replace(/[ñ]/g, "n").replace(/[òóôõöø]/g, "o").replace(/[ùúûü]/g, "u").replace(/[ýÿ]/g, "y").replace(/[ß]/g, "ss").replace(/[œ]/g, "oe").replace(/[þ]/g, "th").replace(/[ẞ]/g, "SS").replace(/[Œ]/g, "OE").replace(/[Þ]/g, "TH");
}
__name(removeAccents, "removeAccents");
var urlFilters = /* @__PURE__ */ Object.freeze({
  __proto__: null,
  url_decode,
  url_encode,
  cgi_escape,
  uri_escape,
  slugify
});
var join = argumentsToValue(function(v, arg) {
  const array = toArray(v);
  const sep2 = isNil(arg) ? " " : stringify(arg);
  const complexity = array.length * (1 + sep2.length);
  this.context.memoryLimit.use(complexity);
  return array.join(sep2);
});
var last$1 = argumentsToValue((v) => isArrayLike(v) ? last(v) : "");
var first = argumentsToValue((v) => isArrayLike(v) ? v[0] : "");
var reverse = argumentsToValue(function(v) {
  const array = toArray(v);
  this.context.memoryLimit.use(array.length);
  return [...array].reverse();
});
function* sortBy(arr, property, comparator) {
  const values = [];
  const array = toArray(arr);
  this.context.memoryLimit.use(array.length);
  for (const item of array) {
    values.push([
      item,
      property ? yield this.context._getFromScope(item, stringify(property).split("."), false) : item
    ]);
  }
  return values.sort((lhs, rhs) => comparator(lhs[1], rhs[1])).map((tuple) => tuple[0]);
}
__name(sortBy, "sortBy");
function* sort(arr, property) {
  return yield* sortBy.call(this, arr, property, orderedCompare);
}
__name(sort, "sort");
function* sort_natural(arr, property) {
  return yield* sortBy.call(this, arr, property, caseInsensitiveCompare);
}
__name(sort_natural, "sort_natural");
var size = /* @__PURE__ */ __name((v) => v && v.length || 0, "size");
function* map(arr, property) {
  const results = [];
  const array = toArray(arr);
  this.context.memoryLimit.use(array.length);
  for (const item of array) {
    results.push(yield this.context._getFromScope(item, stringify(property), false));
  }
  return results;
}
__name(map, "map");
function* sum(arr, property) {
  let sum2 = 0;
  const array = toArray(arr);
  for (const item of array) {
    const data = Number(property ? yield this.context._getFromScope(item, stringify(property), false) : item);
    sum2 += Number.isNaN(data) ? 0 : data;
  }
  return sum2;
}
__name(sum, "sum");
function compact(arr) {
  const array = toArray(arr);
  this.context.memoryLimit.use(array.length);
  return array.filter((x) => !isNil(toValue(x)));
}
__name(compact, "compact");
function concat(v, arg = []) {
  const lhs = toArray(v);
  const rhs = toArray(arg);
  this.context.memoryLimit.use(lhs.length + rhs.length);
  return lhs.concat(rhs);
}
__name(concat, "concat");
function push(v, arg) {
  return concat.call(this, v, [arg]);
}
__name(push, "push");
function unshift(v, arg) {
  const array = toArray(v);
  this.context.memoryLimit.use(array.length);
  const clone = [...array];
  clone.unshift(arg);
  return clone;
}
__name(unshift, "unshift");
function pop(v) {
  const clone = [...toArray(v)];
  clone.pop();
  return clone;
}
__name(pop, "pop");
function shift(v) {
  const array = toArray(v);
  this.context.memoryLimit.use(array.length);
  const clone = [...array];
  clone.shift();
  return clone;
}
__name(shift, "shift");
function slice(v, begin, length = 1) {
  v = toValue(v);
  if (isNil(v))
    return [];
  if (!isArray(v))
    v = stringify(v);
  begin = begin < 0 ? v.length + begin : begin;
  this.context.memoryLimit.use(length);
  return v.slice(begin, begin + length);
}
__name(slice, "slice");
function expectedMatcher(expected) {
  if (this.context.opts.jekyllWhere) {
    return (v) => EmptyDrop.is(expected) ? equals(v, expected) : isArray(v) ? arrayIncludes(v, expected) : equals(v, expected);
  } else if (expected === void 0) {
    return (v) => isTruthy(v, this.context);
  } else {
    return (v) => equals(v, expected);
  }
}
__name(expectedMatcher, "expectedMatcher");
function* filter(include, arr, property, expected) {
  const values = [];
  arr = toArray(arr);
  this.context.memoryLimit.use(arr.length);
  const token = new Tokenizer(stringify(property)).readScopeValue();
  for (const item of arr) {
    values.push(yield evalToken(token, this.context.spawn(item)));
  }
  const matcher = expectedMatcher.call(this, expected);
  return arr.filter((_, i) => matcher(values[i]) === include);
}
__name(filter, "filter");
function* filter_exp(include, arr, itemName, exp) {
  const filtered = [];
  const keyTemplate = new Value(stringify(exp), this.liquid);
  const array = toArray(arr);
  this.context.memoryLimit.use(array.length);
  for (const item of array) {
    this.context.push({ [itemName]: item });
    const value = yield keyTemplate.value(this.context);
    this.context.pop();
    if (value === include)
      filtered.push(item);
  }
  return filtered;
}
__name(filter_exp, "filter_exp");
function* where(arr, property, expected) {
  return yield* filter.call(this, true, arr, property, expected);
}
__name(where, "where");
function* reject(arr, property, expected) {
  return yield* filter.call(this, false, arr, property, expected);
}
__name(reject, "reject");
function* where_exp(arr, itemName, exp) {
  return yield* filter_exp.call(this, true, arr, itemName, exp);
}
__name(where_exp, "where_exp");
function* reject_exp(arr, itemName, exp) {
  return yield* filter_exp.call(this, false, arr, itemName, exp);
}
__name(reject_exp, "reject_exp");
function* group_by(arr, property) {
  const map3 = /* @__PURE__ */ new Map();
  arr = toEnumerable(arr);
  const token = new Tokenizer(stringify(property)).readScopeValue();
  this.context.memoryLimit.use(arr.length);
  for (const item of arr) {
    const key = yield evalToken(token, this.context.spawn(item));
    if (!map3.has(key))
      map3.set(key, []);
    map3.get(key).push(item);
  }
  return [...map3.entries()].map(([name, items]) => ({ name, items }));
}
__name(group_by, "group_by");
function* group_by_exp(arr, itemName, exp) {
  const map3 = /* @__PURE__ */ new Map();
  const keyTemplate = new Value(stringify(exp), this.liquid);
  arr = toEnumerable(arr);
  this.context.memoryLimit.use(arr.length);
  for (const item of arr) {
    this.context.push({ [itemName]: item });
    const key = yield keyTemplate.value(this.context);
    this.context.pop();
    if (!map3.has(key))
      map3.set(key, []);
    map3.get(key).push(item);
  }
  return [...map3.entries()].map(([name, items]) => ({ name, items }));
}
__name(group_by_exp, "group_by_exp");
function* search(arr, property, expected) {
  const token = new Tokenizer(stringify(property)).readScopeValue();
  const array = toArray(arr);
  const matcher = expectedMatcher.call(this, expected);
  for (let index = 0; index < array.length; index++) {
    const value = yield evalToken(token, this.context.spawn(array[index]));
    if (matcher(value))
      return [index, array[index]];
  }
}
__name(search, "search");
function* search_exp(arr, itemName, exp) {
  const predicate = new Value(stringify(exp), this.liquid);
  const array = toArray(arr);
  for (let index = 0; index < array.length; index++) {
    this.context.push({ [itemName]: array[index] });
    const value = yield predicate.value(this.context);
    this.context.pop();
    if (value)
      return [index, array[index]];
  }
}
__name(search_exp, "search_exp");
function* has(arr, property, expected) {
  const result = yield* search.call(this, arr, property, expected);
  return !!result;
}
__name(has, "has");
function* has_exp(arr, itemName, exp) {
  const result = yield* search_exp.call(this, arr, itemName, exp);
  return !!result;
}
__name(has_exp, "has_exp");
function* find_index(arr, property, expected) {
  const result = yield* search.call(this, arr, property, expected);
  return result ? result[0] : void 0;
}
__name(find_index, "find_index");
function* find_index_exp(arr, itemName, exp) {
  const result = yield* search_exp.call(this, arr, itemName, exp);
  return result ? result[0] : void 0;
}
__name(find_index_exp, "find_index_exp");
function* find(arr, property, expected) {
  const result = yield* search.call(this, arr, property, expected);
  return result ? result[1] : void 0;
}
__name(find, "find");
function* find_exp(arr, itemName, exp) {
  const result = yield* search_exp.call(this, arr, itemName, exp);
  return result ? result[1] : void 0;
}
__name(find_exp, "find_exp");
function uniq(arr) {
  arr = toArray(arr);
  this.context.memoryLimit.use(arr.length);
  return [...new Set(arr)];
}
__name(uniq, "uniq");
function sample(v, count = 1) {
  v = toValue(v);
  if (isNil(v))
    return [];
  if (!isArray(v))
    v = stringify(v);
  this.context.memoryLimit.use(count);
  const shuffled = [...v].sort(() => Math.random() - 0.5);
  if (count === 1)
    return shuffled[0];
  return shuffled.slice(0, count);
}
__name(sample, "sample");
var arrayFilters = /* @__PURE__ */ Object.freeze({
  __proto__: null,
  join,
  last: last$1,
  first,
  reverse,
  sort,
  sort_natural,
  size,
  map,
  sum,
  compact,
  concat,
  push,
  unshift,
  pop,
  shift,
  slice,
  where,
  reject,
  where_exp,
  reject_exp,
  group_by,
  group_by_exp,
  has,
  has_exp,
  find_index,
  find_index_exp,
  find,
  find_exp,
  uniq,
  sample
});
function date(v, format2, timezoneOffset) {
  var _a, _b, _c;
  const size2 = ((_a = v === null || v === void 0 ? void 0 : v.length) !== null && _a !== void 0 ? _a : 0) + ((_b = format2 === null || format2 === void 0 ? void 0 : format2.length) !== null && _b !== void 0 ? _b : 0) + ((_c = timezoneOffset === null || timezoneOffset === void 0 ? void 0 : timezoneOffset.length) !== null && _c !== void 0 ? _c : 0);
  this.context.memoryLimit.use(size2);
  const date2 = parseDate(v, this.context.opts, timezoneOffset);
  if (!date2)
    return v;
  format2 = toValue(format2);
  format2 = isNil(format2) ? this.context.opts.dateFormat : stringify(format2);
  return strftime(date2, format2);
}
__name(date, "date");
function date_to_xmlschema(v) {
  return date.call(this, v, "%Y-%m-%dT%H:%M:%S%:z");
}
__name(date_to_xmlschema, "date_to_xmlschema");
function date_to_rfc822(v) {
  return date.call(this, v, "%a, %d %b %Y %H:%M:%S %z");
}
__name(date_to_rfc822, "date_to_rfc822");
function date_to_string(v, type, style) {
  return stringify_date.call(this, v, "%b", type, style);
}
__name(date_to_string, "date_to_string");
function date_to_long_string(v, type, style) {
  return stringify_date.call(this, v, "%B", type, style);
}
__name(date_to_long_string, "date_to_long_string");
function stringify_date(v, month_type, type, style) {
  const date2 = parseDate(v, this.context.opts);
  if (!date2)
    return v;
  if (type === "ordinal") {
    const d = date2.getDate();
    return style === "US" ? strftime(date2, `${month_type} ${d}%q, %Y`) : strftime(date2, `${d}%q ${month_type} %Y`);
  }
  return strftime(date2, `%d ${month_type} %Y`);
}
__name(stringify_date, "stringify_date");
function parseDate(v, opts, timezoneOffset) {
  let date2;
  const defaultTimezoneOffset = timezoneOffset !== null && timezoneOffset !== void 0 ? timezoneOffset : opts.timezoneOffset;
  const locale = opts.locale;
  v = toValue(v);
  if (isNil(v)) {
    return void 0;
  } else if (v === "now" || v === "today") {
    date2 = new LiquidDate(Date.now(), locale, defaultTimezoneOffset);
  } else if (isNumber(v)) {
    date2 = new LiquidDate(v * 1e3, locale, defaultTimezoneOffset);
  } else if (isString(v)) {
    if (/^\d+$/.test(v)) {
      date2 = new LiquidDate(+v * 1e3, locale, defaultTimezoneOffset);
    } else if (opts.preserveTimezones && timezoneOffset === void 0) {
      date2 = LiquidDate.createDateFixedToTimezone(v, locale);
    } else {
      date2 = new LiquidDate(v, locale, defaultTimezoneOffset);
    }
  } else {
    date2 = new LiquidDate(v, locale, defaultTimezoneOffset);
  }
  return date2.valid() ? date2 : void 0;
}
__name(parseDate, "parseDate");
var dateFilters = /* @__PURE__ */ Object.freeze({
  __proto__: null,
  date,
  date_to_xmlschema,
  date_to_rfc822,
  date_to_string,
  date_to_long_string
});
var rCJKWord = /[\u4E00-\u9FFF\uF900-\uFAFF\u3400-\u4DBF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF]/gu;
var rNonCJKWord = /[^\u4E00-\u9FFF\uF900-\uFAFF\u3400-\u4DBF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF\s]+/gu;
function append(v, arg) {
  assert(arguments.length === 2, "append expect 2 arguments");
  const lhs = stringify(v);
  const rhs = stringify(arg);
  this.context.memoryLimit.use(lhs.length + rhs.length);
  return lhs + rhs;
}
__name(append, "append");
function prepend(v, arg) {
  assert(arguments.length === 2, "prepend expect 2 arguments");
  const lhs = stringify(v);
  const rhs = stringify(arg);
  this.context.memoryLimit.use(lhs.length + rhs.length);
  return rhs + lhs;
}
__name(prepend, "prepend");
function lstrip(v, chars) {
  const str = stringify(v);
  this.context.memoryLimit.use(str.length);
  if (chars) {
    chars = stringify(chars);
    this.context.memoryLimit.use(chars.length);
    for (let i = 0, set2 = new Set(chars); i < str.length; i++) {
      if (!set2.has(str[i]))
        return str.slice(i);
    }
    return "";
  }
  return str.trimStart();
}
__name(lstrip, "lstrip");
function downcase(v) {
  const str = stringify(v);
  this.context.memoryLimit.use(str.length);
  return str.toLowerCase();
}
__name(downcase, "downcase");
function upcase(v) {
  const str = stringify(v);
  this.context.memoryLimit.use(str.length);
  return stringify(str).toUpperCase();
}
__name(upcase, "upcase");
function remove(v, arg) {
  const str = stringify(v);
  arg = stringify(arg);
  this.context.memoryLimit.use(str.length + arg.length);
  return str.split(arg).join("");
}
__name(remove, "remove");
function remove_first(v, l) {
  const str = stringify(v);
  l = stringify(l);
  this.context.memoryLimit.use(str.length + l.length);
  return str.replace(l, "");
}
__name(remove_first, "remove_first");
function remove_last(v, l) {
  const str = stringify(v);
  const pattern = stringify(l);
  this.context.memoryLimit.use(str.length + pattern.length);
  const index = str.lastIndexOf(pattern);
  if (index === -1)
    return str;
  return str.substring(0, index) + str.substring(index + pattern.length);
}
__name(remove_last, "remove_last");
function rstrip(str, chars) {
  str = stringify(str);
  this.context.memoryLimit.use(str.length);
  if (chars) {
    chars = stringify(chars);
    this.context.memoryLimit.use(chars.length);
    for (let i = str.length - 1, set2 = new Set(chars); i >= 0; i--) {
      if (!set2.has(str[i]))
        return str.slice(0, i + 1);
    }
    return "";
  }
  return str.trimEnd();
}
__name(rstrip, "rstrip");
function split(v, arg) {
  const str = stringify(v);
  this.context.memoryLimit.use(str.length);
  const arr = str.split(stringify(arg));
  while (arr.length && arr[arr.length - 1] === "")
    arr.pop();
  return arr;
}
__name(split, "split");
function strip(v, chars) {
  const str = stringify(v);
  this.context.memoryLimit.use(str.length);
  if (chars) {
    const set2 = new Set(stringify(chars));
    this.context.memoryLimit.use(set2.size);
    let i = 0;
    let j = str.length - 1;
    while (set2.has(str[i]))
      i++;
    while (j >= i && set2.has(str[j]))
      j--;
    return str.slice(i, j + 1);
  }
  return str.trim();
}
__name(strip, "strip");
function strip_newlines(v) {
  const str = stringify(v);
  this.context.memoryLimit.use(str.length);
  return str.replace(/\r?\n/gm, "");
}
__name(strip_newlines, "strip_newlines");
function capitalize(str) {
  str = stringify(str);
  this.context.memoryLimit.use(str.length);
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}
__name(capitalize, "capitalize");
function replace(v, pattern, replacement) {
  const str = stringify(v);
  pattern = stringify(pattern);
  replacement = stringify(replacement);
  const parts = str.split(pattern);
  const outputSize = str.length + (parts.length - 1) * (replacement.length - pattern.length);
  this.context.memoryLimit.use(outputSize);
  return parts.join(replacement);
}
__name(replace, "replace");
function replace_first(v, arg1, arg2) {
  const str = stringify(v);
  arg1 = stringify(arg1);
  arg2 = stringify(arg2);
  this.context.memoryLimit.use(str.length + arg1.length + arg2.length);
  return str.replace(arg1, () => arg2);
}
__name(replace_first, "replace_first");
function replace_last(v, arg1, arg2) {
  const str = stringify(v);
  const pattern = stringify(arg1);
  const replacement = stringify(arg2);
  this.context.memoryLimit.use(str.length + pattern.length + replacement.length);
  const index = str.lastIndexOf(pattern);
  if (index === -1)
    return str;
  return str.substring(0, index) + replacement + str.substring(index + pattern.length);
}
__name(replace_last, "replace_last");
function truncate(v, l = 50, o = "...") {
  const str = stringify(v);
  o = stringify(o);
  this.context.memoryLimit.use(str.length + o.length);
  if (str.length <= l)
    return v;
  return str.substring(0, l - o.length) + o;
}
__name(truncate, "truncate");
function truncatewords(v, words = 15, o = "...") {
  const str = stringify(v);
  o = stringify(o);
  this.context.memoryLimit.use(str.length + o.length);
  const arr = str.split(/\s+/);
  if (words <= 0)
    words = 1;
  let ret = arr.slice(0, words).join(" ");
  if (arr.length >= words)
    ret += o;
  return ret;
}
__name(truncatewords, "truncatewords");
function normalize_whitespace(v) {
  const str = stringify(v);
  this.context.memoryLimit.use(str.length);
  return str.replace(/\s+/g, " ");
}
__name(normalize_whitespace, "normalize_whitespace");
function number_of_words(input, mode) {
  const str = stringify(input);
  this.context.memoryLimit.use(str.length);
  input = str.trim();
  if (!input)
    return 0;
  switch (mode) {
    case "cjk":
      return (input.match(rCJKWord) || []).length + (input.match(rNonCJKWord) || []).length;
    case "auto":
      return rCJKWord.test(input) ? input.match(rCJKWord).length + (input.match(rNonCJKWord) || []).length : input.split(/\s+/).length;
    default:
      return input.split(/\s+/).length;
  }
}
__name(number_of_words, "number_of_words");
function array_to_sentence_string(array, connector = "and") {
  connector = stringify(connector);
  this.context.memoryLimit.use(array.length + connector.length);
  switch (array.length) {
    case 0:
      return "";
    case 1:
      return array[0];
    case 2:
      return `${array[0]} ${connector} ${array[1]}`;
    default:
      return `${array.slice(0, -1).join(", ")}, ${connector} ${array[array.length - 1]}`;
  }
}
__name(array_to_sentence_string, "array_to_sentence_string");
var stringFilters = /* @__PURE__ */ Object.freeze({
  __proto__: null,
  append,
  prepend,
  lstrip,
  downcase,
  upcase,
  remove,
  remove_first,
  remove_last,
  rstrip,
  split,
  strip,
  strip_newlines,
  capitalize,
  replace,
  replace_first,
  replace_last,
  truncate,
  truncatewords,
  normalize_whitespace,
  number_of_words,
  array_to_sentence_string
});
function base64Encode(str) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(str)));
}
__name(base64Encode, "base64Encode");
function base64Decode(str) {
  return new TextDecoder().decode(Uint8Array.from(atob(str), (c) => c.charCodeAt(0)));
}
__name(base64Decode, "base64Decode");
function base64_encode(value) {
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
    this.context.memoryLimit.use(value.byteLength);
    return value.toString("base64");
  }
  const str = stringify(value);
  this.context.memoryLimit.use(str.length);
  return base64Encode(str);
}
__name(base64_encode, "base64_encode");
function base64_decode(value) {
  const str = stringify(value);
  this.context.memoryLimit.use(str.length);
  return base64Decode(str);
}
__name(base64_decode, "base64_decode");
var base64Filters = /* @__PURE__ */ Object.freeze({
  __proto__: null,
  base64_encode,
  base64_decode
});
var filters = Object.assign(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign({}, htmlFilters), mathFilters), urlFilters), arrayFilters), dateFilters), stringFilters), base64Filters), misc);
var AssignTag = class extends Tag {
  static {
    __name(this, "AssignTag");
  }
  constructor(token, remainTokens, liquid) {
    super(token, remainTokens, liquid);
    this.identifier = this.tokenizer.readIdentifier();
    this.key = this.identifier.content;
    this.tokenizer.assert(this.key, "expected variable name");
    this.tokenizer.skipBlank();
    this.tokenizer.assert(this.tokenizer.peek() === "=", 'expected "="');
    this.tokenizer.advance();
    this.value = new Value(this.tokenizer.readFilteredValue(), this.liquid);
  }
  *render(ctx) {
    ctx.bottom()[this.key] = yield this.value.value(ctx, this.liquid.options.lenientIf);
  }
  *arguments() {
    yield this.value;
  }
  *localScope() {
    yield this.identifier;
  }
};
var MODIFIERS = ["offset", "limit", "reversed"];
var ForTag = class extends Tag {
  static {
    __name(this, "ForTag");
  }
  constructor(token, remainTokens, liquid, parser) {
    super(token, remainTokens, liquid);
    const variable = this.tokenizer.readIdentifier();
    const inStr = this.tokenizer.readIdentifier();
    const collection = this.tokenizer.readValue();
    if (!variable.size() || inStr.content !== "in" || !collection) {
      throw new Error(`illegal tag: ${token.getText()}`);
    }
    this.variable = variable.content;
    this.collection = collection;
    this.hash = new Hash(this.tokenizer, liquid.options.keyValueSeparator);
    this.templates = [];
    this.elseTemplates = [];
    let p;
    const stream = parser.parseStream(remainTokens).on("start", () => p = this.templates).on("tag:else", (tag) => {
      assertEmpty(tag.args);
      p = this.elseTemplates;
    }).on("tag:endfor", (tag) => {
      assertEmpty(tag.args);
      stream.stop();
    }).on("template", (tpl) => p.push(tpl)).on("end", () => {
      throw new Error(`tag ${token.getText()} not closed`);
    });
    stream.start();
  }
  *render(ctx, emitter) {
    const r = this.liquid.renderer;
    let collection = toEnumerable(yield evalToken(this.collection, ctx));
    if (!collection.length) {
      yield r.renderTemplates(this.elseTemplates, ctx, emitter);
      return;
    }
    const continueKey = "continue-" + this.variable + "-" + this.collection.getText();
    ctx.push({ continue: ctx.getRegister(continueKey, {}) });
    const hash = yield this.hash.render(ctx);
    ctx.pop();
    const modifiers = this.liquid.options.orderedFilterParameters ? Object.keys(hash).filter((x) => MODIFIERS.includes(x)) : MODIFIERS.filter((x) => hash[x] !== void 0);
    collection = modifiers.reduce((collection2, modifier) => {
      if (modifier === "offset")
        return offset(collection2, hash["offset"]);
      if (modifier === "limit")
        return limit(collection2, hash["limit"]);
      return reversed(collection2);
    }, collection);
    ctx.setRegister(continueKey, (hash["offset"] || 0) + collection.length);
    const scope = { forloop: new ForloopDrop(collection.length, this.collection.getText(), this.variable) };
    ctx.push(scope);
    for (const item of collection) {
      scope[this.variable] = item;
      ctx.continueCalled = ctx.breakCalled = false;
      yield r.renderTemplates(this.templates, ctx, emitter);
      if (ctx.breakCalled)
        break;
      scope.forloop.next();
    }
    ctx.continueCalled = ctx.breakCalled = false;
    ctx.pop();
  }
  *children() {
    const templates = this.templates.slice();
    if (this.elseTemplates) {
      templates.push(...this.elseTemplates);
    }
    return templates;
  }
  *arguments() {
    yield this.collection;
    for (const v of Object.values(this.hash.hash)) {
      if (isValueToken(v)) {
        yield v;
      }
    }
  }
  blockScope() {
    return [this.variable, "forloop"];
  }
};
function reversed(arr) {
  return [...arr].reverse();
}
__name(reversed, "reversed");
function offset(arr, count) {
  return arr.slice(count);
}
__name(offset, "offset");
function limit(arr, count) {
  return arr.slice(0, count);
}
__name(limit, "limit");
var CaptureTag = class extends Tag {
  static {
    __name(this, "CaptureTag");
  }
  constructor(tagToken, remainTokens, liquid, parser) {
    super(tagToken, remainTokens, liquid);
    this.templates = [];
    this.identifier = this.readVariable();
    this.variable = this.identifier.content;
    while (remainTokens.length) {
      const token = remainTokens.shift();
      if (isTagToken(token) && token.name === "endcapture")
        return;
      this.templates.push(parser.parseToken(token, remainTokens));
    }
    throw new Error(`tag ${tagToken.getText()} not closed`);
  }
  readVariable() {
    let ident = this.tokenizer.readIdentifier();
    if (ident.content)
      return ident;
    ident = this.tokenizer.readQuoted();
    if (ident)
      return ident;
    throw this.tokenizer.error("invalid capture name");
  }
  *render(ctx) {
    const r = this.liquid.renderer;
    const html = yield r.renderTemplates(this.templates, ctx);
    ctx.bottom()[this.variable] = html;
  }
  *children() {
    return this.templates;
  }
  *localScope() {
    yield this.identifier;
  }
};
var CaseTag = class extends Tag {
  static {
    __name(this, "CaseTag");
  }
  constructor(tagToken, remainTokens, liquid, parser) {
    super(tagToken, remainTokens, liquid);
    this.branches = [];
    this.elseTemplates = [];
    this.value = new Value(this.tokenizer.readFilteredValue(), this.liquid);
    this.elseTemplates = [];
    let p = [];
    let elseCount = 0;
    const stream = parser.parseStream(remainTokens).on("tag:when", (token) => {
      if (elseCount > 0) {
        return;
      }
      p = [];
      const values = [];
      while (!token.tokenizer.end()) {
        values.push(token.tokenizer.readValueOrThrow());
        token.tokenizer.skipBlank();
        if (token.tokenizer.peek() === ",") {
          token.tokenizer.readTo(",");
        } else {
          token.tokenizer.readTo("or");
        }
      }
      this.branches.push({
        values,
        templates: p
      });
    }).on("tag:else", () => {
      elseCount++;
      p = this.elseTemplates;
    }).on("tag:endcase", () => stream.stop()).on("template", (tpl) => {
      if (p !== this.elseTemplates || elseCount === 1) {
        p.push(tpl);
      }
    }).on("end", () => {
      throw new Error(`tag ${tagToken.getText()} not closed`);
    });
    stream.start();
  }
  *render(ctx, emitter) {
    const r = this.liquid.renderer;
    const target = toValue(yield this.value.value(ctx, ctx.opts.lenientIf));
    let branchHit = false;
    for (const branch of this.branches) {
      for (const valueToken of branch.values) {
        const value = yield evalToken(valueToken, ctx, ctx.opts.lenientIf);
        if (equals(target, value)) {
          yield r.renderTemplates(branch.templates, ctx, emitter);
          branchHit = true;
          break;
        }
      }
    }
    if (!branchHit) {
      yield r.renderTemplates(this.elseTemplates, ctx, emitter);
    }
  }
  *arguments() {
    yield this.value;
    yield* this.branches.flatMap((b) => b.values);
  }
  *children() {
    const templates = this.branches.flatMap((b) => b.templates);
    if (this.elseTemplates) {
      templates.push(...this.elseTemplates);
    }
    return templates;
  }
};
var CommentTag = class extends Tag {
  static {
    __name(this, "CommentTag");
  }
  constructor(tagToken, remainTokens, liquid) {
    super(tagToken, remainTokens, liquid);
    while (remainTokens.length) {
      const token = remainTokens.shift();
      if (isTagToken(token) && token.name === "endcomment")
        return;
    }
    throw new Error(`tag ${tagToken.getText()} not closed`);
  }
  render() {
  }
};
var RenderTag = class extends Tag {
  static {
    __name(this, "RenderTag");
  }
  constructor(token, remainTokens, liquid, parser) {
    super(token, remainTokens, liquid);
    const tokenizer = this.tokenizer;
    this.file = parseFilePath(tokenizer, this.liquid, parser);
    this.currentFile = token.file;
    while (!tokenizer.end()) {
      tokenizer.skipBlank();
      const begin = tokenizer.p;
      const keyword = tokenizer.readIdentifier();
      if (keyword.content === "with" || keyword.content === "for") {
        tokenizer.skipBlank();
        if (tokenizer.peek() !== ":") {
          const value = tokenizer.readValue();
          if (value) {
            const beforeAs = tokenizer.p;
            const asStr = tokenizer.readIdentifier();
            let alias;
            if (asStr.content === "as")
              alias = tokenizer.readIdentifier();
            else
              tokenizer.p = beforeAs;
            this[keyword.content] = { value, alias: alias && alias.content };
            tokenizer.skipBlank();
            if (tokenizer.peek() === ",")
              tokenizer.advance();
            continue;
          }
        }
      }
      tokenizer.p = begin;
      break;
    }
    this.hash = new Hash(tokenizer, liquid.options.keyValueSeparator);
  }
  *render(ctx, emitter) {
    const { liquid, hash } = this;
    const filepath = yield renderFilePath(this["file"], ctx, liquid);
    assert(filepath, () => `illegal file path "${filepath}"`);
    const childCtx = ctx.spawn();
    const scope = childCtx.bottom();
    __assign(scope, yield hash.render(ctx));
    if (this["with"]) {
      const { value, alias } = this["with"];
      scope[alias || filepath] = yield evalToken(value, ctx);
    }
    if (this["for"]) {
      const { value, alias } = this["for"];
      const collection = toEnumerable(yield evalToken(value, ctx));
      scope["forloop"] = new ForloopDrop(collection.length, value.getText(), alias);
      for (const item of collection) {
        scope[alias] = item;
        const templates = yield liquid._parsePartialFile(filepath, childCtx.sync, this["currentFile"]);
        yield liquid.renderer.renderTemplates(templates, childCtx, emitter);
        scope["forloop"].next();
      }
    } else {
      const templates = yield liquid._parsePartialFile(filepath, childCtx.sync, this["currentFile"]);
      yield liquid.renderer.renderTemplates(templates, childCtx, emitter);
    }
  }
  *children(partials, sync) {
    if (partials && isString(this["file"])) {
      return yield this.liquid._parsePartialFile(this["file"], sync, this["currentFile"]);
    }
    return [];
  }
  partialScope() {
    if (isString(this["file"])) {
      const names = Object.keys(this.hash.hash);
      if (this["with"]) {
        const { value, alias } = this["with"];
        if (isString(alias)) {
          names.push([alias, value]);
        } else if (isString(this.file)) {
          names.push([this.file, value]);
        }
      }
      if (this["for"]) {
        const { value, alias } = this["for"];
        if (isString(alias)) {
          names.push([alias, value]);
        } else if (isString(this.file)) {
          names.push([this.file, value]);
        }
      }
      return { name: this["file"], isolated: true, scope: names };
    }
  }
  *arguments() {
    for (const v of Object.values(this.hash.hash)) {
      if (isValueToken(v)) {
        yield v;
      }
    }
    if (this["with"]) {
      const { value } = this["with"];
      if (isValueToken(value)) {
        yield value;
      }
    }
    if (this["for"]) {
      const { value } = this["for"];
      if (isValueToken(value)) {
        yield value;
      }
    }
  }
};
function parseFilePath(tokenizer, liquid, parser) {
  if (liquid.options.dynamicPartials) {
    const file = tokenizer.readValue();
    tokenizer.assert(file, "illegal file path");
    if (file.getText() === "none")
      return;
    if (isQuotedToken(file)) {
      const templates2 = parser.parse(evalQuotedToken(file));
      return optimize(templates2);
    }
    return file;
  }
  const tokens = [...tokenizer.readFileNameTemplate(liquid.options)];
  const templates = optimize(parser.parseTokens(tokens));
  return templates === "none" ? void 0 : templates;
}
__name(parseFilePath, "parseFilePath");
function optimize(templates) {
  if (templates.length === 1 && isHTMLToken(templates[0].token))
    return templates[0].token.getContent();
  return templates;
}
__name(optimize, "optimize");
function* renderFilePath(file, ctx, liquid) {
  if (typeof file === "string")
    return file;
  if (Array.isArray(file))
    return liquid.renderer.renderTemplates(file, ctx);
  return yield evalToken(file, ctx);
}
__name(renderFilePath, "renderFilePath");
var IncludeTag = class extends Tag {
  static {
    __name(this, "IncludeTag");
  }
  constructor(token, remainTokens, liquid, parser) {
    super(token, remainTokens, liquid);
    const { tokenizer } = token;
    this["file"] = parseFilePath(tokenizer, this.liquid, parser);
    this["currentFile"] = token.file;
    const begin = tokenizer.p;
    const withStr = tokenizer.readIdentifier();
    if (withStr.content === "with") {
      tokenizer.skipBlank();
      if (tokenizer.peek() !== ":") {
        this.withVar = tokenizer.readValue();
      } else
        tokenizer.p = begin;
    } else
      tokenizer.p = begin;
    this.hash = new Hash(tokenizer, liquid.options.jekyllInclude || liquid.options.keyValueSeparator);
  }
  *render(ctx, emitter) {
    const { liquid, hash, withVar } = this;
    const { renderer } = liquid;
    const filepath = yield renderFilePath(this["file"], ctx, liquid);
    assert(filepath, () => `illegal file path "${filepath}"`);
    const saved = ctx.saveRegister("blocks", "blockMode");
    ctx.setRegister("blocks", {});
    ctx.setRegister("blockMode", BlockMode.OUTPUT);
    const scope = yield hash.render(ctx);
    if (withVar)
      scope[filepath] = yield evalToken(withVar, ctx);
    const templates = yield liquid._parsePartialFile(filepath, ctx.sync, this["currentFile"]);
    ctx.push(ctx.opts.jekyllInclude ? { include: scope } : scope);
    yield renderer.renderTemplates(templates, ctx, emitter);
    ctx.pop();
    ctx.restoreRegister(saved);
  }
  *children(partials, sync) {
    if (partials && isString(this["file"])) {
      return yield this.liquid._parsePartialFile(this["file"], sync, this["currentFile"]);
    }
    return [];
  }
  partialScope() {
    if (isString(this["file"])) {
      let names;
      if (this.liquid.options.jekyllInclude) {
        names = ["include"];
      } else {
        names = Object.keys(this.hash.hash);
        if (this.withVar) {
          names.push([this["file"], this.withVar]);
        }
      }
      return { name: this["file"], isolated: false, scope: names };
    }
  }
  *arguments() {
    yield* Object.values(this.hash.hash).filter(isValueToken);
    if (isValueToken(this["file"])) {
      yield this["file"];
    }
    if (isValueToken(this.withVar)) {
      yield this.withVar;
    }
  }
};
var DecrementTag = class extends Tag {
  static {
    __name(this, "DecrementTag");
  }
  constructor(token, remainTokens, liquid) {
    super(token, remainTokens, liquid);
    this.identifier = this.tokenizer.readIdentifier();
    this.variable = this.identifier.content;
  }
  render(context, emitter) {
    const scope = context.environments;
    if (!isNumber(scope[this.variable])) {
      scope[this.variable] = 0;
    }
    emitter.write(stringify(--scope[this.variable]));
  }
  *localScope() {
    yield this.identifier;
  }
};
var CycleTag = class extends Tag {
  static {
    __name(this, "CycleTag");
  }
  constructor(token, remainTokens, liquid) {
    super(token, remainTokens, liquid);
    this.candidates = [];
    const group = this.tokenizer.readValue();
    this.tokenizer.skipBlank();
    if (group) {
      if (this.tokenizer.peek() === ":") {
        this.group = group;
        this.tokenizer.advance();
      } else
        this.candidates.push(group);
    }
    while (!this.tokenizer.end()) {
      const value = this.tokenizer.readValue();
      if (value)
        this.candidates.push(value);
      this.tokenizer.readTo(",");
    }
    this.tokenizer.assert(this.candidates.length, () => `empty candidates: "${token.getText()}"`);
  }
  *render(ctx, emitter) {
    const group = yield evalToken(this.group, ctx);
    const fingerprint = `cycle:${group}:` + this.candidates.join(",");
    const groups = ctx.getRegister("cycle", {});
    let idx = groups[fingerprint];
    if (idx === void 0) {
      idx = groups[fingerprint] = 0;
    }
    const candidate = this.candidates[idx];
    idx = (idx + 1) % this.candidates.length;
    groups[fingerprint] = idx;
    return yield evalToken(candidate, ctx);
  }
  *arguments() {
    yield* this.candidates;
    if (this.group) {
      yield this.group;
    }
  }
};
var IfTag = class extends Tag {
  static {
    __name(this, "IfTag");
  }
  constructor(tagToken, remainTokens, liquid, parser) {
    super(tagToken, remainTokens, liquid);
    this.branches = [];
    let p = [];
    parser.parseStream(remainTokens).on("start", () => this.branches.push({
      value: new Value(tagToken.tokenizer.readFilteredValue(), this.liquid),
      templates: p = []
    })).on("tag:elsif", (token) => {
      assert(!this.elseTemplates, "unexpected elsif after else");
      this.branches.push({
        value: new Value(token.tokenizer.readFilteredValue(), this.liquid),
        templates: p = []
      });
    }).on("tag:else", (tag) => {
      assertEmpty(tag.args);
      assert(!this.elseTemplates, "duplicated else");
      p = this.elseTemplates = [];
    }).on("tag:endif", function(tag) {
      assertEmpty(tag.args);
      this.stop();
    }).on("template", (tpl) => p.push(tpl)).on("end", () => {
      throw new Error(`tag ${tagToken.getText()} not closed`);
    }).start();
  }
  *render(ctx, emitter) {
    const r = this.liquid.renderer;
    for (const { value, templates } of this.branches) {
      const v = yield value.value(ctx, ctx.opts.lenientIf);
      if (isTruthy(v, ctx)) {
        yield r.renderTemplates(templates, ctx, emitter);
        return;
      }
    }
    yield r.renderTemplates(this.elseTemplates || [], ctx, emitter);
  }
  *children() {
    const templates = this.branches.flatMap((b) => b.templates);
    if (this.elseTemplates) {
      templates.push(...this.elseTemplates);
    }
    return templates;
  }
  arguments() {
    return this.branches.map((b) => b.value);
  }
};
var IncrementTag = class extends Tag {
  static {
    __name(this, "IncrementTag");
  }
  constructor(token, remainTokens, liquid) {
    super(token, remainTokens, liquid);
    this.identifier = this.tokenizer.readIdentifier();
    this.variable = this.identifier.content;
  }
  render(context, emitter) {
    const scope = context.environments;
    if (!isNumber(scope[this.variable])) {
      scope[this.variable] = 0;
    }
    const val = scope[this.variable];
    scope[this.variable]++;
    emitter.write(stringify(val));
  }
  *localScope() {
    yield this.identifier;
  }
};
var LayoutTag = class extends Tag {
  static {
    __name(this, "LayoutTag");
  }
  constructor(token, remainTokens, liquid, parser) {
    super(token, remainTokens, liquid);
    this.file = parseFilePath(this.tokenizer, this.liquid, parser);
    this["currentFile"] = token.file;
    this.args = new Hash(this.tokenizer, liquid.options.keyValueSeparator);
    this.templates = parser.parseTokens(remainTokens);
  }
  *render(ctx, emitter) {
    const { liquid, args, file } = this;
    const { renderer } = liquid;
    if (file === void 0) {
      ctx.setRegister("blockMode", BlockMode.OUTPUT);
      yield renderer.renderTemplates(this.templates, ctx, emitter);
      return;
    }
    const filepath = yield renderFilePath(this.file, ctx, liquid);
    assert(filepath, () => `illegal file path "${filepath}"`);
    const templates = yield liquid._parseLayoutFile(filepath, ctx.sync, this["currentFile"]);
    ctx.setRegister("blockMode", BlockMode.STORE);
    const html = yield renderer.renderTemplates(this.templates, ctx);
    const blocks = ctx.getRegister("blocks", {});
    if (blocks[""] === void 0)
      blocks[""] = (parent, emitter2) => emitter2.write(html);
    ctx.setRegister("blockMode", BlockMode.OUTPUT);
    ctx.push(yield args.render(ctx));
    yield renderer.renderTemplates(templates, ctx, emitter);
    ctx.pop();
  }
  *children(partials) {
    const templates = this.templates.slice();
    if (partials && isString(this.file)) {
      templates.push(...yield this.liquid._parsePartialFile(this.file, true, this["currentFile"]));
    }
    return templates;
  }
  *arguments() {
    for (const v of Object.values(this.args.hash)) {
      if (isValueToken(v)) {
        yield v;
      }
    }
    if (isValueToken(this.file)) {
      yield this.file;
    }
  }
  partialScope() {
    if (isString(this.file)) {
      return { name: this.file, isolated: false, scope: Object.keys(this.args.hash) };
    }
  }
};
var BlockTag = class extends Tag {
  static {
    __name(this, "BlockTag");
  }
  constructor(token, remainTokens, liquid, parser) {
    super(token, remainTokens, liquid);
    this.templates = [];
    const match2 = /\w+/.exec(token.args);
    this.block = match2 ? match2[0] : "";
    while (remainTokens.length) {
      const token2 = remainTokens.shift();
      if (isTagToken(token2) && token2.name === "endblock")
        return;
      const template = parser.parseToken(token2, remainTokens);
      this.templates.push(template);
    }
    throw new Error(`tag ${token.getText()} not closed`);
  }
  *render(ctx, emitter) {
    const blockRender = this.getBlockRender(ctx);
    if (ctx.getRegister("blockMode") === BlockMode.STORE) {
      ctx.getRegister("blocks", {})[this.block] = blockRender;
    } else {
      yield blockRender(new BlockDrop(), emitter);
    }
  }
  getBlockRender(ctx) {
    const self = this;
    const { liquid, templates } = this;
    const renderChild = ctx.getRegister("blocks", {})[this.block];
    const renderCurrent = /* @__PURE__ */ __name(function* (superBlock, emitter) {
      const stack = ctx.getRegister("blockStack", []);
      if (stack.includes(self))
        throw new Error("block tag cannot be nested");
      stack.push(self);
      ctx.push({ block: superBlock });
      yield liquid.renderer.renderTemplates(templates, ctx, emitter);
      ctx.pop();
      stack.pop();
    }, "renderCurrent");
    return renderChild ? (superBlock, emitter) => renderChild(new BlockDrop((emitter2) => renderCurrent(superBlock, emitter2)), emitter) : renderCurrent;
  }
  *children() {
    return this.templates;
  }
  blockScope() {
    return ["block"];
  }
};
var RawTag = class extends Tag {
  static {
    __name(this, "RawTag");
  }
  constructor(tagToken, remainTokens, liquid) {
    super(tagToken, remainTokens, liquid);
    this.tokens = [];
    while (remainTokens.length) {
      const token = remainTokens.shift();
      if (isTagToken(token) && token.name === "endraw")
        return;
      this.tokens.push(token);
    }
    throw new Error(`tag ${tagToken.getText()} not closed`);
  }
  render() {
    return this.tokens.map((token) => token.getText()).join("");
  }
};
var TablerowloopDrop = class extends ForloopDrop {
  static {
    __name(this, "TablerowloopDrop");
  }
  constructor(length, cols, collection, variable) {
    super(length, collection, variable);
    this.length = length;
    this.cols = cols;
  }
  row() {
    return Math.floor(this.i / this.cols) + 1;
  }
  col0() {
    return this.i % this.cols;
  }
  col() {
    return this.col0() + 1;
  }
  col_first() {
    return this.col0() === 0;
  }
  col_last() {
    return this.col() === this.cols;
  }
};
var TablerowTag = class extends Tag {
  static {
    __name(this, "TablerowTag");
  }
  constructor(tagToken, remainTokens, liquid, parser) {
    super(tagToken, remainTokens, liquid);
    const variable = this.tokenizer.readIdentifier();
    this.tokenizer.skipBlank();
    const predicate = this.tokenizer.readIdentifier();
    const collectionToken = this.tokenizer.readValue();
    if (predicate.content !== "in" || !collectionToken) {
      throw new Error(`illegal tag: ${tagToken.getText()}`);
    }
    this.variable = variable.content;
    this.collection = collectionToken;
    this.args = new Hash(this.tokenizer, liquid.options.keyValueSeparator);
    this.templates = [];
    let p;
    const stream = parser.parseStream(remainTokens).on("start", () => p = this.templates).on("tag:endtablerow", () => stream.stop()).on("template", (tpl) => p.push(tpl)).on("end", () => {
      throw new Error(`tag ${tagToken.getText()} not closed`);
    });
    stream.start();
  }
  *render(ctx, emitter) {
    let collection = toEnumerable(yield evalToken(this.collection, ctx));
    const args = yield this.args.render(ctx);
    const offset2 = args.offset || 0;
    const limit2 = args.limit === void 0 ? collection.length : args.limit;
    collection = collection.slice(offset2, offset2 + limit2);
    const cols = args.cols || collection.length;
    const r = this.liquid.renderer;
    const tablerowloop = new TablerowloopDrop(collection.length, cols, this.collection.getText(), this.variable);
    const scope = { tablerowloop };
    ctx.push(scope);
    for (let idx = 0; idx < collection.length; idx++, tablerowloop.next()) {
      scope[this.variable] = collection[idx];
      if (tablerowloop.col0() === 0) {
        if (tablerowloop.row() !== 1)
          emitter.write("</tr>");
        emitter.write(`<tr class="row${tablerowloop.row()}">`);
      }
      emitter.write(`<td class="col${tablerowloop.col()}">`);
      yield r.renderTemplates(this.templates, ctx, emitter);
      emitter.write("</td>");
    }
    if (collection.length)
      emitter.write("</tr>");
    ctx.pop();
  }
  *children() {
    return this.templates;
  }
  *arguments() {
    yield this.collection;
    for (const v of Object.values(this.args.hash)) {
      if (isValueToken(v)) {
        yield v;
      }
    }
  }
  blockScope() {
    return [this.variable, "tablerowloop"];
  }
};
var UnlessTag = class extends Tag {
  static {
    __name(this, "UnlessTag");
  }
  constructor(tagToken, remainTokens, liquid, parser) {
    super(tagToken, remainTokens, liquid);
    this.branches = [];
    this.elseTemplates = [];
    let p = [];
    let elseCount = 0;
    parser.parseStream(remainTokens).on("start", () => this.branches.push({
      value: new Value(tagToken.tokenizer.readFilteredValue(), this.liquid),
      test: isFalsy,
      templates: p = []
    })).on("tag:elsif", (token) => {
      if (elseCount > 0) {
        p = [];
        return;
      }
      this.branches.push({
        value: new Value(token.tokenizer.readFilteredValue(), this.liquid),
        test: isTruthy,
        templates: p = []
      });
    }).on("tag:else", () => {
      elseCount++;
      p = this.elseTemplates;
    }).on("tag:endunless", function() {
      this.stop();
    }).on("template", (tpl) => {
      if (p !== this.elseTemplates || elseCount === 1) {
        p.push(tpl);
      }
    }).on("end", () => {
      throw new Error(`tag ${tagToken.getText()} not closed`);
    }).start();
  }
  *render(ctx, emitter) {
    const r = this.liquid.renderer;
    for (const { value, test, templates } of this.branches) {
      const v = yield value.value(ctx, ctx.opts.lenientIf);
      if (test(v, ctx)) {
        yield r.renderTemplates(templates, ctx, emitter);
        return;
      }
    }
    yield r.renderTemplates(this.elseTemplates, ctx, emitter);
  }
  *children() {
    const children = this.branches.flatMap((b) => b.templates);
    if (this.elseTemplates) {
      children.push(...this.elseTemplates);
    }
    return children;
  }
  arguments() {
    return this.branches.map((b) => b.value);
  }
};
var BreakTag = class extends Tag {
  static {
    __name(this, "BreakTag");
  }
  render(ctx, _emitter) {
    ctx.breakCalled = true;
  }
};
var ContinueTag = class extends Tag {
  static {
    __name(this, "ContinueTag");
  }
  render(ctx, _emitter) {
    ctx.continueCalled = true;
  }
};
var EchoTag = class extends Tag {
  static {
    __name(this, "EchoTag");
  }
  constructor(token, remainTokens, liquid) {
    super(token, remainTokens, liquid);
    this.tokenizer.skipBlank();
    if (!this.tokenizer.end()) {
      this.value = new Value(this.tokenizer.readFilteredValue(), this.liquid);
    }
  }
  *render(ctx, emitter) {
    if (!this.value)
      return;
    const val = yield this.value.value(ctx, false);
    emitter.write(val);
  }
  *arguments() {
    if (this.value) {
      yield this.value;
    }
  }
};
var LiquidTag = class extends Tag {
  static {
    __name(this, "LiquidTag");
  }
  constructor(token, remainTokens, liquid, parser) {
    super(token, remainTokens, liquid);
    const tokens = this.tokenizer.readLiquidTagTokens(this.liquid.options);
    this.templates = parser.parseTokens(tokens);
  }
  *render(ctx, emitter) {
    yield this.liquid.renderer.renderTemplates(this.templates, ctx, emitter);
  }
  *children() {
    return this.templates;
  }
};
var InlineCommentTag = class extends Tag {
  static {
    __name(this, "InlineCommentTag");
  }
  constructor(tagToken, remainTokens, liquid) {
    super(tagToken, remainTokens, liquid);
    if (tagToken.args.search(/\n\s*[^#\s]/g) !== -1) {
      throw new Error("every line of an inline comment must start with a '#' character");
    }
  }
  render() {
  }
};
var tags = {
  assign: AssignTag,
  "for": ForTag,
  capture: CaptureTag,
  "case": CaseTag,
  comment: CommentTag,
  include: IncludeTag,
  render: RenderTag,
  decrement: DecrementTag,
  increment: IncrementTag,
  cycle: CycleTag,
  "if": IfTag,
  layout: LayoutTag,
  block: BlockTag,
  raw: RawTag,
  tablerow: TablerowTag,
  unless: UnlessTag,
  "break": BreakTag,
  "continue": ContinueTag,
  echo: EchoTag,
  liquid: LiquidTag,
  "#": InlineCommentTag
};
var Liquid = class _Liquid {
  static {
    __name(this, "Liquid");
  }
  constructor(opts = {}) {
    this.renderer = new Render();
    this.filters = {};
    this.tags = {};
    this.options = normalize(opts);
    this.parser = new Parser(this);
    forOwn(tags, (conf, name) => this.registerTag(name, conf));
    forOwn(filters, (handler, name) => this.registerFilter(name, handler));
  }
  parse(html, filepath) {
    const parser = new Parser(this);
    return parser.parse(html, filepath);
  }
  _render(tpl, scope, renderOptions) {
    const ctx = scope instanceof Context2 ? scope : new Context2(scope, this.options, renderOptions);
    return this.renderer.renderTemplates(tpl, ctx);
  }
  render(tpl, scope, renderOptions) {
    return __awaiter(this, void 0, void 0, function* () {
      return toPromise(this._render(tpl, scope, Object.assign(Object.assign({}, renderOptions), { sync: false })));
    });
  }
  renderSync(tpl, scope, renderOptions) {
    return toValueSync(this._render(tpl, scope, Object.assign(Object.assign({}, renderOptions), { sync: true })));
  }
  renderToNodeStream(tpl, scope, renderOptions = {}) {
    const ctx = new Context2(scope, this.options, renderOptions);
    return this.renderer.renderTemplatesToNodeStream(tpl, ctx);
  }
  _parseAndRender(html, scope, renderOptions) {
    const tpl = this.parse(html);
    return this._render(tpl, scope, renderOptions);
  }
  parseAndRender(html, scope, renderOptions) {
    return __awaiter(this, void 0, void 0, function* () {
      return toPromise(this._parseAndRender(html, scope, Object.assign(Object.assign({}, renderOptions), { sync: false })));
    });
  }
  parseAndRenderSync(html, scope, renderOptions) {
    return toValueSync(this._parseAndRender(html, scope, Object.assign(Object.assign({}, renderOptions), { sync: true })));
  }
  _parsePartialFile(file, sync, currentFile) {
    return new Parser(this).parseFile(file, sync, LookupType.Partials, currentFile);
  }
  _parseLayoutFile(file, sync, currentFile) {
    return new Parser(this).parseFile(file, sync, LookupType.Layouts, currentFile);
  }
  _parseFile(file, sync, lookupType, currentFile) {
    return new Parser(this).parseFile(file, sync, lookupType, currentFile);
  }
  parseFile(file, lookupType) {
    return __awaiter(this, void 0, void 0, function* () {
      return toPromise(new Parser(this).parseFile(file, false, lookupType));
    });
  }
  parseFileSync(file, lookupType) {
    return toValueSync(new Parser(this).parseFile(file, true, lookupType));
  }
  *_renderFile(file, ctx, renderFileOptions) {
    const templates = yield this._parseFile(file, renderFileOptions.sync, renderFileOptions.lookupType);
    return yield this._render(templates, ctx, renderFileOptions);
  }
  renderFile(file, ctx, renderFileOptions) {
    return __awaiter(this, void 0, void 0, function* () {
      return toPromise(this._renderFile(file, ctx, Object.assign(Object.assign({}, renderFileOptions), { sync: false })));
    });
  }
  renderFileSync(file, ctx, renderFileOptions) {
    return toValueSync(this._renderFile(file, ctx, Object.assign(Object.assign({}, renderFileOptions), { sync: true })));
  }
  renderFileToNodeStream(file, scope, renderOptions) {
    return __awaiter(this, void 0, void 0, function* () {
      const templates = yield this.parseFile(file);
      return this.renderToNodeStream(templates, scope, renderOptions);
    });
  }
  _evalValue(str, scope) {
    const value = new Value(str, this);
    const ctx = scope instanceof Context2 ? scope : new Context2(scope, this.options);
    return value.value(ctx);
  }
  evalValue(str, scope) {
    return __awaiter(this, void 0, void 0, function* () {
      return toPromise(this._evalValue(str, scope));
    });
  }
  evalValueSync(str, scope) {
    return toValueSync(this._evalValue(str, scope));
  }
  registerFilter(name, filter2) {
    this.filters[name] = filter2;
  }
  registerTag(name, tag) {
    this.tags[name] = isFunction(tag) ? tag : createTagClass(tag);
  }
  plugin(plugin) {
    return plugin.call(this, _Liquid);
  }
  express() {
    const self = this;
    let firstCall = true;
    return function(filePath, ctx, callback) {
      if (firstCall) {
        firstCall = false;
        const dirs = normalizeDirectoryList(this.root);
        self.options.root.unshift(...dirs);
        self.options.layouts.unshift(...dirs);
        self.options.partials.unshift(...dirs);
      }
      self.renderFile(filePath, ctx).then((html) => callback(null, html), callback);
    };
  }
  analyze(template, options = {}) {
    return __awaiter(this, void 0, void 0, function* () {
      return analyze(template, options);
    });
  }
  analyzeSync(template, options = {}) {
    return analyzeSync(template, options);
  }
  parseAndAnalyze(html, filename, options = {}) {
    return __awaiter(this, void 0, void 0, function* () {
      return analyze(this.parse(html, filename), options);
    });
  }
  parseAndAnalyzeSync(html, filename, options = {}) {
    return analyzeSync(this.parse(html, filename), options);
  }
  /** Return an array of all variables without their properties. */
  variables(template, options = {}) {
    return __awaiter(this, void 0, void 0, function* () {
      const analysis = yield analyze(isString(template) ? this.parse(template) : template, options);
      return Object.keys(analysis.variables);
    });
  }
  /** Return an array of all variables without their properties. */
  variablesSync(template, options = {}) {
    const analysis = analyzeSync(isString(template) ? this.parse(template) : template, options);
    return Object.keys(analysis.variables);
  }
  /** Return an array of all variables including their properties/paths. */
  fullVariables(template, options = {}) {
    return __awaiter(this, void 0, void 0, function* () {
      const analysis = yield analyze(isString(template) ? this.parse(template) : template, options);
      return Array.from(new Set(Object.values(analysis.variables).flatMap((a) => a.map((v) => String(v)))));
    });
  }
  /** Return an array of all variables including their properties/paths. */
  fullVariablesSync(template, options = {}) {
    const analysis = analyzeSync(isString(template) ? this.parse(template) : template, options);
    return Array.from(new Set(Object.values(analysis.variables).flatMap((a) => a.map((v) => String(v)))));
  }
  /** Return an array of all variables, each as an array of properties/segments. */
  variableSegments(template, options = {}) {
    return __awaiter(this, void 0, void 0, function* () {
      const analysis = yield analyze(isString(template) ? this.parse(template) : template, options);
      return Array.from(strictUniq(Object.values(analysis.variables).flatMap((a) => a.map((v) => v.toArray()))));
    });
  }
  /** Return an array of all variables, each as an array of properties/segments. */
  variableSegmentsSync(template, options = {}) {
    const analysis = analyzeSync(isString(template) ? this.parse(template) : template, options);
    return Array.from(strictUniq(Object.values(analysis.variables).flatMap((a) => a.map((v) => v.toArray()))));
  }
  /** Return an array of all expected context variables without their properties. */
  globalVariables(template, options = {}) {
    return __awaiter(this, void 0, void 0, function* () {
      const analysis = yield analyze(isString(template) ? this.parse(template) : template, options);
      return Object.keys(analysis.globals);
    });
  }
  /** Return an array of all expected context variables without their properties. */
  globalVariablesSync(template, options = {}) {
    const analysis = analyzeSync(isString(template) ? this.parse(template) : template, options);
    return Object.keys(analysis.globals);
  }
  /** Return an array of all expected context variables including their properties/paths. */
  globalFullVariables(template, options = {}) {
    return __awaiter(this, void 0, void 0, function* () {
      const analysis = yield analyze(isString(template) ? this.parse(template) : template, options);
      return Array.from(new Set(Object.values(analysis.globals).flatMap((a) => a.map((v) => String(v)))));
    });
  }
  /** Return an array of all expected context variables including their properties/paths. */
  globalFullVariablesSync(template, options = {}) {
    const analysis = analyzeSync(isString(template) ? this.parse(template) : template, options);
    return Array.from(new Set(Object.values(analysis.globals).flatMap((a) => a.map((v) => String(v)))));
  }
  /** Return an array of all expected context variables, each as an array of properties/segments. */
  globalVariableSegments(template, options = {}) {
    return __awaiter(this, void 0, void 0, function* () {
      const analysis = yield analyze(isString(template) ? this.parse(template) : template, options);
      return Array.from(strictUniq(Object.values(analysis.globals).flatMap((a) => a.map((v) => v.toArray()))));
    });
  }
  /** Return an array of all expected context variables, each as an array of properties/segments. */
  globalVariableSegmentsSync(template, options = {}) {
    const analysis = analyzeSync(isString(template) ? this.parse(template) : template, options);
    return Array.from(strictUniq(Object.values(analysis.globals).flatMap((a) => a.map((v) => v.toArray()))));
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
  constructor(yaml, tags2) {
    this.docStart = null;
    this.docEnd = false;
    this.yaml = Object.assign({}, _Directives.defaultYaml, yaml);
    this.tags = Object.assign({}, _Directives.defaultTags, tags2);
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
      const tags2 = {};
      visit(doc.contents, (_key, node) => {
        if (isNode(node) && node.tag)
          tags2[node.tag] = true;
      });
      tagNames = Object.keys(tags2);
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
function findTagObject(value, tagName, tags2) {
  if (tagName) {
    const match2 = tags2.filter((t) => t.tag === tagName);
    const tagObj = match2.find((t) => !t.format) ?? match2[0];
    if (!tagObj)
      throw new Error(`Tag ${tagName} not found`);
    return tagObj;
  }
  return tags2.find((t) => t.identify?.(value) && !t.format);
}
__name(findTagObject, "findTagObject");
function createNode(value, tagName, ctx) {
  if (isDocument(value))
    value = value.contents;
  if (isNode(value))
    return value;
  if (isPair(value)) {
    const map3 = ctx.schema[MAP].createNode?.(ctx.schema, null, ctx);
    map3.items.push(value);
    return map3;
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
  let split2 = void 0;
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
      split2 = void 0;
    } else {
      if (ch === " " && prev && prev !== " " && prev !== "\n" && prev !== "	") {
        const next = text[i + 1];
        if (next && next !== " " && next !== "\n" && next !== "	")
          split2 = i;
      }
      if (i >= end) {
        if (split2) {
          folds.push(split2);
          end = split2 + endStep;
          split2 = void 0;
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
          split2 = void 0;
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
  const limit2 = lineWidth - indentLength;
  const strLen = str.length;
  if (strLen <= limit2)
    return false;
  for (let i = 0, start = 0; i < strLen; ++i) {
    if (str[i] === "\n") {
      if (i - start > limit2)
        return true;
      start = i + 1;
      if (strLen - start <= limit2)
        return false;
    }
  }
  return true;
}
__name(lineLengthOverLimit, "lineLengthOverLimit");
function doubleQuotedString(value, ctx) {
  const json2 = JSON.stringify(value);
  if (ctx.options.doubleQuotedAsJSON)
    return json2;
  const { implicitKey } = ctx;
  const minMultiLineLength = ctx.options.doubleQuotedMinMultiLineLength;
  const indent = ctx.indent || (containsDocumentMarker(value) ? "  " : "");
  let str = "";
  let start = 0;
  for (let i = 0, ch = json2[i]; ch; ch = json2[++i]) {
    if (ch === " " && json2[i + 1] === "\\" && json2[i + 2] === "n") {
      str += json2.slice(start, i) + "\\ ";
      i += 1;
      start = i;
      ch = "\\";
    }
    if (ch === "\\")
      switch (json2[i + 1]) {
        case "u":
          {
            str += json2.slice(start, i);
            const code = json2.substr(i + 2, 4);
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
                  str += json2.substr(i, 6);
            }
            i += 5;
            start = i + 1;
          }
          break;
        case "n":
          if (implicitKey || json2[i + 2] === '"' || json2.length < minMultiLineLength) {
            i += 1;
          } else {
            str += json2.slice(start, i) + "\n\n";
            while (json2[i + 2] === "\\" && json2[i + 3] === "n" && json2[i + 4] !== '"') {
              str += "\n";
              i += 2;
            }
            str += indent;
            if (json2[i + 2] === " ")
              str += "\\";
            i += 1;
            start = i + 1;
          }
          break;
        default:
          i += 1;
      }
  }
  str = start ? str + json2.slice(start) : json2;
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
    const { compat, tags: tags2 } = ctx.doc.schema;
    if (tags2.some(test) || compat?.some(test))
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
function getTagObject(tags2, item) {
  if (item.tag) {
    const match2 = tags2.filter((t) => t.tag === item.tag);
    if (match2.length > 0)
      return match2.find((t) => t.format === item.format) ?? match2[0];
  }
  let tagObj = void 0;
  let obj;
  if (isScalar(item)) {
    obj = item.value;
    let match2 = tags2.filter((t) => t.identify?.(obj));
    if (match2.length > 1) {
      const testMatch = match2.filter((t) => t.test);
      if (testMatch.length > 0)
        match2 = testMatch;
    }
    tagObj = match2.find((t) => t.format === item.format) ?? match2.find((t) => !t.format);
  } else {
    obj = item;
    tagObj = tags2.find((t) => t.nodeClass && obj instanceof t.nodeClass);
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
function stringify2(item, ctx, onComment, onChompKeep) {
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
__name(stringify2, "stringify");

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
  let str = stringify2(key, ctx, () => keyCommentDone = true, () => chompKeep = true);
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
  const valueStr = stringify2(value, ctx, () => valueCommentDone = true, () => chompKeep = true);
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
function addMergeToJSMap(ctx, map3, value) {
  value = ctx && isAlias(value) ? value.resolve(ctx.doc) : value;
  if (isSeq(value))
    for (const it of value.items)
      mergeValue(ctx, map3, it);
  else if (Array.isArray(value))
    for (const it of value)
      mergeValue(ctx, map3, it);
  else
    mergeValue(ctx, map3, value);
}
__name(addMergeToJSMap, "addMergeToJSMap");
function mergeValue(ctx, map3, value) {
  const source = ctx && isAlias(value) ? value.resolve(ctx.doc) : value;
  if (!isMap(source))
    throw new Error("Merge sources must be maps or map aliases");
  const srcMap = source.toJSON(null, ctx, Map);
  for (const [key, value2] of srcMap) {
    if (map3 instanceof Map) {
      if (!map3.has(key))
        map3.set(key, value2);
    } else if (map3 instanceof Set) {
      map3.add(key);
    } else if (!Object.prototype.hasOwnProperty.call(map3, key)) {
      Object.defineProperty(map3, key, {
        value: value2,
        writable: true,
        enumerable: true,
        configurable: true
      });
    }
  }
  return map3;
}
__name(mergeValue, "mergeValue");

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/nodes/addPairToJSMap.js
function addPairToJSMap(ctx, map3, { key, value }) {
  if (isNode(key) && key.addToJSMap)
    key.addToJSMap(ctx, map3, value);
  else if (isMergeKey(ctx, key))
    addMergeToJSMap(ctx, map3, value);
  else {
    const jsKey = toJS(key, "", ctx);
    if (map3 instanceof Map) {
      map3.set(jsKey, toJS(value, jsKey, ctx));
    } else if (map3 instanceof Set) {
      map3.add(jsKey);
    } else {
      const stringKey = stringifyKey(key, jsKey, ctx);
      const jsValue = toJS(value, stringKey, ctx);
      if (stringKey in map3)
        Object.defineProperty(map3, stringKey, {
          value: jsValue,
          writable: true,
          enumerable: true,
          configurable: true
        });
      else
        map3[stringKey] = jsValue;
    }
  }
  return map3;
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
  const stringify5 = flow ? stringifyFlowCollection : stringifyBlockCollection;
  return stringify5(collection, ctx, options);
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
    let str2 = stringify2(item, itemCtx, () => comment2 = null, () => chompKeep = true);
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
    let str = stringify2(item, itemCtx, () => comment = null);
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
      const len = lines.reduce((sum2, line) => sum2 + line.length + 2, 2);
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
    const map3 = new this(schema4);
    const add = /* @__PURE__ */ __name((key, value) => {
      if (typeof replacer === "function")
        value = replacer.call(obj, key, value);
      else if (Array.isArray(replacer) && !replacer.includes(key))
        return;
      if (value !== void 0 || keepUndefined)
        map3.items.push(createPair(key, value, ctx));
    }, "add");
    if (obj instanceof Map) {
      for (const [key, value] of obj)
        add(key, value);
    } else if (obj && typeof obj === "object") {
      for (const key of Object.keys(obj))
        add(key, obj[key]);
    }
    if (typeof schema4.sortMapEntries === "function") {
      map3.items.sort(schema4.sortMapEntries);
    }
    return map3;
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
    const map3 = Type ? new Type() : ctx?.mapAsMap ? /* @__PURE__ */ new Map() : {};
    if (ctx?.onCreate)
      ctx.onCreate(map3);
    for (const item of this.items)
      addPairToJSMap(ctx, map3, item);
    return map3;
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
var map2 = {
  collection: "map",
  default: true,
  nodeClass: YAMLMap,
  tag: "tag:yaml.org,2002:map",
  resolve(map3, onError) {
    if (!isMap(map3))
      onError("Expected a mapping for this tag");
    return map3;
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
function stringifyNumber({ format: format2, minFractionDigits, tag, value }) {
  if (typeof value === "bigint")
    return String(value);
  const num = typeof value === "number" ? value : Number(value);
  if (!isFinite(num))
    return isNaN(num) ? ".nan" : num < 0 ? "-.inf" : ".inf";
  let n = JSON.stringify(value);
  if (!format2 && minFractionDigits && (!tag || tag === "tag:yaml.org,2002:float") && /^\d/.test(n)) {
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
var intResolve = /* @__PURE__ */ __name((str, offset2, radix, { intAsBigInt }) => intAsBigInt ? BigInt(str) : parseInt(str.substring(offset2), radix), "intResolve");
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
  map2,
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
var schema2 = [map2, seq].concat(jsonScalars, jsonError);

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
    const map3 = /* @__PURE__ */ new Map();
    if (ctx?.onCreate)
      ctx.onCreate(map3);
    for (const pair of this.items) {
      let key, value;
      if (isPair(pair)) {
        key = toJS(pair.key, "", ctx);
        value = toJS(pair.value, key, ctx);
      } else {
        key = toJS(pair, "", ctx);
      }
      if (map3.has(key))
        throw new Error("Ordered maps must not include duplicate keys");
      map3.set(key, value);
    }
    return map3;
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
function intResolve2(str, offset2, radix, { intAsBigInt }) {
  const sign = str[0];
  if (sign === "-" || sign === "+")
    offset2 += 1;
  str = str.substring(offset2).replace(/_/g, "");
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
  resolve(map3, onError) {
    if (isMap(map3)) {
      if (map3.hasAllNullValues(true))
        return Object.assign(new YAMLSet(), map3);
      else
        onError("Set items must all have null values");
    } else
      onError("Expected a mapping for this tag");
    return map3;
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
    let date2 = Date.UTC(year, month - 1, day, hour || 0, minute || 0, second || 0, millisec);
    const tz = match2[8];
    if (tz && tz !== "Z") {
      let d = parseSexagesimal(tz, false);
      if (Math.abs(d) < 30)
        d *= 60;
      date2 -= 6e4 * d;
    }
    return new Date(date2);
  },
  stringify: /* @__PURE__ */ __name(({ value }) => value?.toISOString().replace(/(T00:00:00)?\.000Z$/, "") ?? "", "stringify")
};

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/schema/yaml-1.1/schema.js
var schema3 = [
  map2,
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
  ["failsafe", [map2, seq, string]],
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
  map: map2,
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
  let tags2 = schemaTags;
  if (!tags2) {
    if (Array.isArray(customTags))
      tags2 = [];
    else {
      const keys = Array.from(schemas.keys()).filter((key) => key !== "yaml11").map((key) => JSON.stringify(key)).join(", ");
      throw new Error(`Unknown schema "${schemaName}"; use one of ${keys} or define customTags array`);
    }
  }
  if (Array.isArray(customTags)) {
    for (const tag of customTags)
      tags2 = tags2.concat(tag);
  } else if (typeof customTags === "function") {
    tags2 = customTags(tags2.slice());
  }
  if (addMergeTag)
    tags2 = tags2.concat(merge);
  return tags2.reduce((tags3, tag) => {
    const tagObj = typeof tag === "string" ? tagsByName[tag] : tag;
    if (!tagObj) {
      const tagName = JSON.stringify(tag);
      const keys = Object.keys(tagsByName).map((key) => JSON.stringify(key)).join(", ");
      throw new Error(`Unknown custom tag ${tagName}; use one of ${keys}`);
    }
    if (!tags3.includes(tagObj))
      tags3.push(tagObj);
    return tags3;
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
    Object.defineProperty(this, MAP, { value: map2 });
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
    let body = stringify2(doc.contents, ctx, () => contentComment = null, onChompKeep);
    if (contentComment)
      body += lineComment(body, "", commentString(contentComment));
    if ((body[0] === "|" || body[0] === ">") && lines[lines.length - 1] === "---") {
      lines[lines.length - 1] = `--- ${body}`;
    } else
      lines.push(body);
  } else {
    lines.push(stringify2(doc.contents, ctx));
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
  toJS({ json: json2, jsonArg, mapAsMap, maxAliasCount, onAnchor, reviver } = {}) {
    const ctx = {
      anchors: /* @__PURE__ */ new Map(),
      doc: this,
      keep: !json2,
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
function resolveProps(tokens, { flow, indicator, next, offset: offset2, onError, parentIndent, startOnNewline }) {
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
  const last2 = tokens[tokens.length - 1];
  const end = last2 ? last2.offset + last2.source.length : offset2;
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
function mapIncludes(ctx, items, search2) {
  const { uniqueKeys } = ctx.options;
  if (uniqueKeys === false)
    return false;
  const isEqual = typeof uniqueKeys === "function" ? uniqueKeys : (a, b) => a === b || isScalar(a) && isScalar(b) && a.value === b.value;
  return items.some((pair) => isEqual(pair.key, search2));
}
__name(mapIncludes, "mapIncludes");

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/compose/resolve-block-map.js
var startColMsg = "All mapping items must start at the same column";
function resolveBlockMap({ composeNode: composeNode2, composeEmptyNode: composeEmptyNode2 }, ctx, bm, onError, tag) {
  const NodeClass = tag?.nodeClass ?? YAMLMap;
  const map3 = new NodeClass(ctx.schema);
  if (ctx.atRoot)
    ctx.atRoot = false;
  let offset2 = bm.offset;
  let commentEnd = null;
  for (const collItem of bm.items) {
    const { start, key, sep: sep2, value } = collItem;
    const keyProps = resolveProps(start, {
      indicator: "explicit-key-ind",
      next: key ?? sep2?.[0],
      offset: offset2,
      onError,
      parentIndent: bm.indent,
      startOnNewline: true
    });
    const implicitKey = !keyProps.found;
    if (implicitKey) {
      if (key) {
        if (key.type === "block-seq")
          onError(offset2, "BLOCK_AS_IMPLICIT_KEY", "A block sequence may not be used as an implicit map key");
        else if ("indent" in key && key.indent !== bm.indent)
          onError(offset2, "BAD_INDENT", startColMsg);
      }
      if (!keyProps.anchor && !keyProps.tag && !sep2) {
        commentEnd = keyProps.end;
        if (keyProps.comment) {
          if (map3.comment)
            map3.comment += "\n" + keyProps.comment;
          else
            map3.comment = keyProps.comment;
        }
        continue;
      }
      if (keyProps.newlineAfterProp || containsNewline(key)) {
        onError(key ?? start[start.length - 1], "MULTILINE_IMPLICIT_KEY", "Implicit keys need to be on a single line");
      }
    } else if (keyProps.found?.indent !== bm.indent) {
      onError(offset2, "BAD_INDENT", startColMsg);
    }
    ctx.atKey = true;
    const keyStart = keyProps.end;
    const keyNode = key ? composeNode2(ctx, key, keyProps, onError) : composeEmptyNode2(ctx, keyStart, start, null, keyProps, onError);
    if (ctx.schema.compat)
      flowIndentCheck(bm.indent, key, onError);
    ctx.atKey = false;
    if (mapIncludes(ctx, map3.items, keyNode))
      onError(keyStart, "DUPLICATE_KEY", "Map keys must be unique");
    const valueProps = resolveProps(sep2 ?? [], {
      indicator: "map-value-ind",
      next: value,
      offset: keyNode.range[2],
      onError,
      parentIndent: bm.indent,
      startOnNewline: !key || key.type === "block-scalar"
    });
    offset2 = valueProps.end;
    if (valueProps.found) {
      if (implicitKey) {
        if (value?.type === "block-map" && !valueProps.hasNewline)
          onError(offset2, "BLOCK_AS_IMPLICIT_KEY", "Nested mappings are not allowed in compact mappings");
        if (ctx.options.strict && keyProps.start < valueProps.found.offset - 1024)
          onError(keyNode.range, "KEY_OVER_1024_CHARS", "The : indicator must be at most 1024 chars after the start of an implicit block mapping key");
      }
      const valueNode = value ? composeNode2(ctx, value, valueProps, onError) : composeEmptyNode2(ctx, offset2, sep2, null, valueProps, onError);
      if (ctx.schema.compat)
        flowIndentCheck(bm.indent, value, onError);
      offset2 = valueNode.range[2];
      const pair = new Pair(keyNode, valueNode);
      if (ctx.options.keepSourceTokens)
        pair.srcToken = collItem;
      map3.items.push(pair);
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
      map3.items.push(pair);
    }
  }
  if (commentEnd && commentEnd < offset2)
    onError(commentEnd, "IMPOSSIBLE", "Map comment with trailing content");
  map3.range = [bm.offset, offset2, commentEnd ?? offset2];
  return map3;
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
  let offset2 = bs.offset;
  let commentEnd = null;
  for (const { start, value } of bs.items) {
    const props = resolveProps(start, {
      indicator: "seq-item-ind",
      next: value,
      offset: offset2,
      onError,
      parentIndent: bs.indent,
      startOnNewline: true
    });
    if (!props.found) {
      if (props.anchor || props.tag || value) {
        if (value && value.type === "block-seq")
          onError(props.end, "BAD_INDENT", "All sequence items must start at the same column");
        else
          onError(offset2, "MISSING_CHAR", "Sequence item without - indicator");
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
    offset2 = node.range[2];
    seq2.items.push(node);
  }
  seq2.range = [bs.offset, offset2, commentEnd ?? offset2];
  return seq2;
}
__name(resolveBlockSeq, "resolveBlockSeq");

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/compose/resolve-end.js
function resolveEnd(end, offset2, reqSpace, onError) {
  let comment = "";
  if (end) {
    let hasSpace = false;
    let sep2 = "";
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
            comment += sep2 + cb;
          sep2 = "";
          break;
        }
        case "newline":
          if (comment)
            sep2 += source;
          hasSpace = true;
          break;
        default:
          onError(token, "UNEXPECTED_TOKEN", `Unexpected ${type} at node end`);
      }
      offset2 += source.length;
    }
  }
  return { comment, offset: offset2 };
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
  let offset2 = fc.offset + fc.start.source.length;
  for (let i = 0; i < fc.items.length; ++i) {
    const collItem = fc.items[i];
    const { start, key, sep: sep2, value } = collItem;
    const props = resolveProps(start, {
      flow: fcName,
      indicator: "explicit-key-ind",
      next: key ?? sep2?.[0],
      offset: offset2,
      onError,
      parentIndent: fc.indent,
      startOnNewline: false
    });
    if (!props.found) {
      if (!props.anchor && !props.tag && !sep2 && !value) {
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
        offset2 = props.end;
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
    if (!isMap2 && !sep2 && !props.found) {
      const valueNode = value ? composeNode2(ctx, value, props, onError) : composeEmptyNode2(ctx, props.end, sep2, null, props, onError);
      coll.items.push(valueNode);
      offset2 = valueNode.range[2];
      if (isBlock(value))
        onError(valueNode.range, "BLOCK_IN_FLOW", blockMsg);
    } else {
      ctx.atKey = true;
      const keyStart = props.end;
      const keyNode = key ? composeNode2(ctx, key, props, onError) : composeEmptyNode2(ctx, keyStart, start, null, props, onError);
      if (isBlock(key))
        onError(keyNode.range, "BLOCK_IN_FLOW", blockMsg);
      ctx.atKey = false;
      const valueProps = resolveProps(sep2 ?? [], {
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
          if (sep2)
            for (const st of sep2) {
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
      const valueNode = value ? composeNode2(ctx, value, valueProps, onError) : valueProps.found ? composeEmptyNode2(ctx, valueProps.end, sep2, null, valueProps, onError) : null;
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
        const map3 = coll;
        if (mapIncludes(ctx, map3.items, keyNode))
          onError(keyStart, "DUPLICATE_KEY", "Map keys must be unique");
        map3.items.push(pair);
      } else {
        const map3 = new YAMLMap(ctx.schema);
        map3.flow = true;
        map3.items.push(pair);
        const endRange = (valueNode ?? keyNode).range;
        map3.range = [keyNode.range[0], endRange[1], endRange[2]];
        coll.items.push(map3);
      }
      offset2 = valueNode ? valueNode.range[2] : valueProps.end;
    }
  }
  const expectedEnd = isMap2 ? "}" : "]";
  const [ce, ...ee] = fc.end;
  let cePos = offset2;
  if (ce && ce.source === expectedEnd)
    cePos = ce.offset + ce.source.length;
  else {
    const name = fcName[0].toUpperCase() + fcName.substring(1);
    const msg = atRoot ? `${name} must end with a ${expectedEnd}` : `${name} in block collection must be sufficiently indented and end with a ${expectedEnd}`;
    onError(offset2, atRoot ? "MISSING_CHAR" : "BAD_INDENT", msg);
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
  let offset2 = scalar.offset + header.length;
  let contentStart = 0;
  for (let i = 0; i < chompStart; ++i) {
    const [indent, content] = lines[i];
    if (content === "" || content === "\r") {
      if (header.indent === 0 && indent.length > trimIndent)
        trimIndent = indent.length;
    } else {
      if (indent.length < trimIndent) {
        const message = "Block scalars with more-indented leading empty lines must use an explicit indentation indicator";
        onError(offset2 + indent.length, "MISSING_CHAR", message);
      }
      if (header.indent === 0)
        trimIndent = indent.length;
      contentStart = i;
      if (trimIndent === 0 && !ctx.atRoot) {
        const message = "Block scalar values in collections must be indented";
        onError(offset2, "BAD_INDENT", message);
      }
      break;
    }
    offset2 += indent.length + content.length + 1;
  }
  for (let i = lines.length - 1; i >= chompStart; --i) {
    if (lines[i][0].length > trimIndent)
      chompStart = i + 1;
  }
  let value = "";
  let sep2 = "";
  let prevMoreIndented = false;
  for (let i = 0; i < contentStart; ++i)
    value += lines[i][0].slice(trimIndent) + "\n";
  for (let i = contentStart; i < chompStart; ++i) {
    let [indent, content] = lines[i];
    offset2 += indent.length + content.length + 1;
    const crlf = content[content.length - 1] === "\r";
    if (crlf)
      content = content.slice(0, -1);
    if (content && indent.length < trimIndent) {
      const src = header.indent ? "explicit indentation indicator" : "first line";
      const message = `Block scalar lines must not be less indented than their ${src}`;
      onError(offset2 - content.length - (crlf ? 2 : 1), "BAD_INDENT", message);
      indent = "";
    }
    if (type === Scalar.BLOCK_LITERAL) {
      value += sep2 + indent.slice(trimIndent) + content;
      sep2 = "\n";
    } else if (indent.length > trimIndent || content[0] === "	") {
      if (sep2 === " ")
        sep2 = "\n";
      else if (!prevMoreIndented && sep2 === "\n")
        sep2 = "\n\n";
      value += sep2 + indent.slice(trimIndent) + content;
      sep2 = "\n";
      prevMoreIndented = true;
    } else if (content === "") {
      if (sep2 === "\n")
        value += "\n";
      else
        sep2 = "\n";
    } else {
      value += sep2 + content;
      sep2 = " ";
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
function parseBlockScalarHeader({ offset: offset2, props }, strict, onError) {
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
        error = offset2 + i;
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
  const split2 = source.split(/\n( *)/);
  const first2 = split2[0];
  const m = first2.match(/^( *)/);
  const line0 = m?.[1] ? [m[1], first2.slice(m[1].length)] : ["", first2];
  const lines = [line0];
  for (let i = 1; i < split2.length; i += 2)
    lines.push([split2[i], split2[i + 1]]);
  return lines;
}
__name(splitLines, "splitLines");

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/compose/resolve-flow-scalar.js
function resolveFlowScalar(scalar, strict, onError) {
  const { offset: offset2, type, source, end } = scalar;
  let _type;
  let value;
  const _onError = /* @__PURE__ */ __name((rel, code, msg) => onError(offset2 + rel, code, msg), "_onError");
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
        range: [offset2, offset2 + source.length, offset2 + source.length]
      };
  }
  const valueEnd = offset2 + source.length;
  const re = resolveEnd(end, valueEnd, strict, onError);
  return {
    value,
    type: _type,
    comment: re.comment,
    range: [offset2, valueEnd, re.offset]
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
  let first2, line;
  try {
    first2 = new RegExp("(.*?)(?<![ 	])[ 	]*\r?\n", "sy");
    line = new RegExp("[ 	]*(.*?)(?:(?<![ 	])[ 	]*)?\r?\n", "sy");
  } catch {
    first2 = /(.*?)[ \t]*\r?\n/sy;
    line = /[ \t]*(.*?)[ \t]*\r?\n/sy;
  }
  let match2 = first2.exec(source);
  if (!match2)
    return source;
  let res = match2[1];
  let sep2 = " ";
  let pos = first2.lastIndex;
  line.lastIndex = pos;
  while (match2 = line.exec(source)) {
    if (match2[1] === "") {
      if (sep2 === "\n")
        res += sep2;
      else
        sep2 = "\n";
    } else {
      res += sep2 + match2[1];
      sep2 = " ";
    }
    pos = line.lastIndex;
  }
  const last2 = /[ \t]*(.*)/sy;
  last2.lastIndex = pos;
  match2 = last2.exec(source);
  return res + sep2 + (match2?.[1] ?? "");
}
__name(foldLines, "foldLines");
function doubleQuotedValue(source, onError) {
  let res = "";
  for (let i = 1; i < source.length - 1; ++i) {
    const ch = source[i];
    if (ch === "\r" && source[i + 1] === "\n")
      continue;
    if (ch === "\n") {
      const { fold, offset: offset2 } = foldNewline(source, i);
      res += fold;
      i = offset2;
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
        const raw3 = source.substr(i - 1, 2);
        onError(i - 1, "BAD_DQ_ESCAPE", `Invalid escape sequence ${raw3}`);
        res += raw3;
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
function foldNewline(source, offset2) {
  let fold = "";
  let ch = source[offset2 + 1];
  while (ch === " " || ch === "	" || ch === "\n" || ch === "\r") {
    if (ch === "\r" && source[offset2 + 2] !== "\n")
      break;
    if (ch === "\n")
      fold += "\n";
    offset2 += 1;
    ch = source[offset2 + 1];
  }
  if (!fold)
    fold = " ";
  return { fold, offset: offset2 };
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
function parseCharCode(source, offset2, length, onError) {
  const cc = source.substr(offset2, length);
  const ok = cc.length === length && /^[0-9a-fA-F]+$/.test(cc);
  const code = ok ? parseInt(cc, 16) : NaN;
  if (isNaN(code)) {
    const raw3 = source.substr(offset2 - 2, length + 2);
    onError(offset2 - 2, "BAD_DQ_ESCAPE", `Invalid escape sequence ${raw3}`);
    return raw3;
  }
  return String.fromCodePoint(code);
}
__name(parseCharCode, "parseCharCode");

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/compose/compose-scalar.js
function composeScalar(ctx, token, tagToken, onError) {
  const { value, type, comment, range: range2 } = token.type === "block-scalar" ? resolveBlockScalar(ctx, token, onError) : resolveFlowScalar(token, ctx.options.strict, onError);
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
  scalar.range = range2;
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
function emptyScalarPosition(offset2, before, pos) {
  if (before) {
    if (pos === null)
      pos = before.length;
    for (let i = pos - 1; i >= 0; --i) {
      let st = before[i];
      switch (st.type) {
        case "space":
        case "comment":
        case "newline":
          offset2 -= st.source.length;
          continue;
      }
      st = before[++i];
      while (st?.type === "space") {
        offset2 += st.source.length;
        st = before[++i];
      }
      break;
    }
  }
  return offset2;
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
function composeEmptyNode(ctx, offset2, before, pos, { spaceBefore, comment, anchor, tag, end }, onError) {
  const token = {
    type: "scalar",
    offset: emptyScalarPosition(offset2, before, pos),
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
function composeAlias({ options }, { offset: offset2, source, end }, onError) {
  const alias = new Alias(source.substring(1));
  if (alias.source === "")
    onError(offset2, "BAD_ALIAS", "Alias cannot be an empty string");
  if (alias.source.endsWith(":"))
    onError(offset2 + source.length - 1, "BAD_ALIAS", "Alias ending in : is ambiguous", true);
  const valueEnd = offset2 + source.length;
  const re = resolveEnd(end, valueEnd, options.strict, onError);
  alias.range = [offset2, valueEnd, re.offset];
  if (re.comment)
    alias.comment = re.comment;
  return alias;
}
__name(composeAlias, "composeAlias");

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/compose/compose-doc.js
function composeDoc(options, directives, { offset: offset2, start, value, end }, onError) {
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
    offset: offset2,
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
  doc.range = [offset2, contentEnd, re.offset];
  return doc;
}
__name(composeDoc, "composeDoc");

// ../node_modules/.bun/yaml@2.7.1/node_modules/yaml/browser/dist/compose/composer.js
function getErrorPos(src) {
  if (typeof src === "number")
    return [src, src + 1];
  if (Array.isArray(src))
    return src.length === 2 ? src : [src[0], src[1]];
  const { offset: offset2, source } = src;
  return [offset2, offset2 + (typeof source === "string" ? source.length : 1)];
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
        this.directives.add(token.source, (offset2, message, warning) => {
          const pos = getErrorPos(token);
          pos[0] += offset2;
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
  continueScalar(offset2) {
    let ch = this.buffer[offset2];
    if (this.indentNext > 0) {
      let indent = 0;
      while (ch === " ")
        ch = this.buffer[++indent + offset2];
      if (ch === "\r") {
        const next = this.buffer[indent + offset2 + 1];
        if (next === "\n" || !next && !this.atEnd)
          return offset2 + indent + 1;
      }
      return ch === "\n" || indent >= this.indentNext || !ch && !this.atEnd ? offset2 + indent : -1;
    }
    if (ch === "-" || ch === ".") {
      const dt = this.buffer.substr(offset2, 3);
      if ((dt === "---" || dt === "...") && isEmpty(this.buffer[offset2 + 3]))
        return -1;
    }
    return offset2;
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
    this.addNewLine = (offset2) => this.lineStarts.push(offset2);
    this.linePos = (offset2) => {
      let low = 0;
      let high = this.lineStarts.length;
      while (low < high) {
        const mid = low + high >> 1;
        if (this.lineStarts[mid] < offset2)
          low = mid + 1;
        else
          high = mid;
      }
      if (this.lineStarts[low] === offset2)
        return { line: low + 1, col: 1 };
      if (low === 0)
        return { line: 0, col: offset2 };
      const start = this.lineStarts[low - 1];
      return { line: low, col: offset2 - start + 1 };
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
var Parser2 = class {
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
        const last2 = token.items[token.items.length - 1];
        if (last2 && !last2.sep && !last2.value && last2.start.length > 0 && findNonEmptyIndex(last2.start) === -1 && (token.indent === 0 || last2.start.every((st) => st.type !== "comment" || st.indent < token.indent))) {
          if (top.type === "document")
            top.end = last2.start;
          else
            top.items.push({ start: last2.start });
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
      let sep2;
      if (scalar.end) {
        sep2 = scalar.end;
        sep2.push(this.sourceToken);
        delete scalar.end;
      } else
        sep2 = [this.sourceToken];
      const map3 = {
        type: "block-map",
        offset: scalar.offset,
        indent: scalar.indent,
        items: [{ start, key: scalar, sep: sep2 }]
      };
      this.onKeyLine = true;
      this.stack[this.stack.length - 1] = map3;
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
  *blockMap(map3) {
    const it = map3.items[map3.items.length - 1];
    switch (this.type) {
      case "newline":
        this.onKeyLine = false;
        if (it.value) {
          const end = "end" in it.value ? it.value.end : void 0;
          const last2 = Array.isArray(end) ? end[end.length - 1] : void 0;
          if (last2?.type === "comment")
            end?.push(this.sourceToken);
          else
            map3.items.push({ start: [this.sourceToken] });
        } else if (it.sep) {
          it.sep.push(this.sourceToken);
        } else {
          it.start.push(this.sourceToken);
        }
        return;
      case "space":
      case "comment":
        if (it.value) {
          map3.items.push({ start: [this.sourceToken] });
        } else if (it.sep) {
          it.sep.push(this.sourceToken);
        } else {
          if (this.atIndentedComment(it.start, map3.indent)) {
            const prev = map3.items[map3.items.length - 2];
            const end = prev?.value?.end;
            if (Array.isArray(end)) {
              Array.prototype.push.apply(end, it.start);
              end.push(this.sourceToken);
              map3.items.pop();
              return;
            }
          }
          it.start.push(this.sourceToken);
        }
        return;
    }
    if (this.indent >= map3.indent) {
      const atMapIndent = !this.onKeyLine && this.indent === map3.indent;
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
              if (st.indent > map3.indent)
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
            map3.items.push({ start });
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
            map3.items.push({ start, explicitKey: true });
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
              map3.items.push({ start: [], key: null, sep: [this.sourceToken] });
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
              const sep2 = it.sep;
              sep2.push(this.sourceToken);
              delete it.key;
              delete it.sep;
              this.stack.push({
                type: "block-map",
                offset: this.offset,
                indent: this.indent,
                items: [{ start: start2, key, sep: sep2 }]
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
              map3.items.push({ start, key: null, sep: [this.sourceToken] });
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
          const fs2 = this.flowScalar(this.type);
          if (atNextItem || it.value) {
            map3.items.push({ start, key: fs2, sep: [] });
            this.onKeyLine = true;
          } else if (it.sep) {
            this.stack.push(fs2);
          } else {
            Object.assign(it, { key: fs2, sep: [] });
            this.onKeyLine = true;
          }
          return;
        }
        default: {
          const bv = this.startBlockValue(map3);
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
              map3.items.push({ start });
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
          const last2 = Array.isArray(end) ? end[end.length - 1] : void 0;
          if (last2?.type === "comment")
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
          const fs2 = this.flowScalar(this.type);
          if (!it || it.value)
            fc.items.push({ start: [], key: fs2, sep: [] });
          else if (it.sep)
            this.stack.push(fs2);
          else
            Object.assign(it, { key: fs2, sep: [] });
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
        const sep2 = fc.end.splice(1, fc.end.length);
        sep2.push(this.sourceToken);
        const map3 = {
          type: "block-map",
          offset: fc.offset,
          indent: fc.indent,
          items: [{ start, key: fc, sep: sep2 }]
        };
        this.onKeyLine = true;
        this.stack[this.stack.length - 1] = map3;
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
  const parser = new Parser2(lineCounter?.addNewLine);
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
var liquidEngine = new Liquid();
var strictLiquidEngine = new Liquid({ strictVariables: true });
var ISSUE_PLACEHOLDERS = {
  title: "{{ issue.title }}",
  description: "{{ issue.description }}",
  url: "{{ issue.url }}"
};
function parseWorkflowConfig(content, options = {}) {
  const split2 = splitFrontMatter(content);
  const promptTemplate = split2.prompt.trim();
  const liquidDetails = validateLiquidTemplates(promptTemplate);
  if (!split2.hasFrontMatter) {
    if (liquidDetails.length > 0) {
      throw configParseError(liquidDetails);
    }
    return { promptTemplate, frontMatter: {} };
  }
  if (split2.frontMatter.trim() === "") {
    const details2 = [...liquidDetails];
    if (!split2.terminated) {
      details2.push({ path: "$", message: "unterminated front matter" });
    }
    if (details2.length > 0) {
      throw configParseError(details2);
    }
    return { promptTemplate, frontMatter: {} };
  }
  const document2 = parseDocument(split2.frontMatter, { prettyErrors: false });
  if (document2.errors.length > 0) {
    throw configParseError(document2.errors.map((error) => ({
      path: "$",
      message: `invalid workflow yaml: ${error.message}`
    })));
  }
  if (!isMap(document2.contents)) {
    throw configParseError([{ path: "$", message: "workflow front matter must be a map" }]);
  }
  const frontMatter = getRecord(document2.toJSON());
  if (frontMatter === void 0) {
    throw configParseError([{ path: "$", message: "workflow front matter must be a map" }]);
  }
  const details = [
    ...validateWorkflowConfig(frontMatter, options),
    ...liquidDetails
  ];
  if (!split2.terminated) {
    details.push({ path: "$", message: "unterminated front matter" });
  }
  if (details.length > 0) {
    throw configParseError(details);
  }
  return { promptTemplate, frontMatter };
}
__name(parseWorkflowConfig, "parseWorkflowConfig");
function renderWorkflowConfig(content, options = {}) {
  const split2 = splitFrontMatter(content);
  const parsed = parseWorkflowConfig(content, options);
  const renderedPrompt = renderPromptTemplate(parsed.promptTemplate, options);
  if (renderedPrompt === parsed.promptTemplate) {
    return content;
  }
  const promptSuffix = split2.prompt.endsWith("\n") || split2.prompt.endsWith("\r\n") ? "\n" : "";
  if (!split2.hasFrontMatter) {
    return `${renderedPrompt}${promptSuffix}`;
  }
  return `${content.slice(0, content.length - split2.prompt.length)}${renderedPrompt}${promptSuffix}`;
}
__name(renderWorkflowConfig, "renderWorkflowConfig");
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
  let offset2 = 0;
  let frontMatter = "";
  for (const line of lines) {
    offset2 += line.length;
    if (line.replace(/[\r\n]+$/u, "") === "---") {
      return {
        frontMatter,
        prompt: remainder.slice(offset2),
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
function validateLiquidTemplates(promptTemplate) {
  try {
    const template = liquidEngine.parse(promptTemplate);
    const hasSecretReference = liquidEngine.fullVariablesSync(template).some((variable) => {
      return variable === "secrets" || variable.startsWith("secrets.");
    });
    if (hasSecretReference) {
      return [{ path: "prompt", message: "secrets are not allowed in prompts" }];
    }
    return [];
  } catch (error) {
    return [{ path: "prompt", message: `invalid liquid template: ${getErrorMessage(error)}` }];
  }
}
__name(validateLiquidTemplates, "validateLiquidTemplates");
function renderPromptTemplate(promptTemplate, options) {
  try {
    return String(strictLiquidEngine.parseAndRenderSync(promptTemplate, {
      ...options.liquidContext,
      issue: ISSUE_PLACEHOLDERS
    }));
  } catch (error) {
    throw configParseError([{ path: "prompt", message: `invalid liquid template: ${getErrorMessage(error)}` }]);
  }
}
__name(renderPromptTemplate, "renderPromptTemplate");
function getRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
__name(getRecord, "getRecord");
function getString(value) {
  return typeof value === "string" ? value : void 0;
}
__name(getString, "getString");
function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
__name(getErrorMessage, "getErrorMessage");
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
var DASHBOARD_OAUTH_STATE_COOKIE_NAME = "contrabass_oauth_state";
var SESSION_TOKEN_TTL_MS = 60 * 60 * 1e3;
var REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1e3;
var DASHBOARD_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1e3;
var OAUTH_STATE_TTL_MS = 10 * 60 * 1e3;
var HEARTBEAT_INTERVAL_SEC = 20;
var LEASE_SEC = 60;
var SUPPORTED_PROTOCOL_VERSIONS = [PROTOCOL_VERSION_CURRENT];
var API_VERSION_HEADER = "X-Contrabass-Api-Version";
var workerRouter = new Hono2();
workerRouter.use("*", apiVersionHeaderMiddleware());
workerRouter.use("/v1/*", authMiddleware());
workerRouter.get("/v1/auth/github/login", startGitHubOAuth);
workerRouter.get("/v1/auth/github/callback", completeGitHubOAuth);
workerRouter.get("/v1/teams/:teamId/board", (context) => {
  return forwardTeamCoordinatorRequest(context, "/board");
});
workerRouter.post("/v1/teams/:teamId/board/*", forwardTeamCoordinatorBoardPostRequest);
workerRouter.post("/v1/teams/:teamId/config", createTeamConfig);
workerRouter.post("/v1/teams/:teamId/config/:version/activate", activateTeamConfigVersion);
workerRouter.get("/v1/teams/:teamId/config/diff", getTeamConfigDiff);
workerRouter.get("/v1/teams/:teamId/config/:hash", getTeamConfigByHash);
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
  if (sessionToken !== void 0) {
    const issuedDashboardSession = await validateDashboardSessionToken(sessionToken, env);
    if (issuedDashboardSession !== void 0) {
      return {
        kind: "dashboard-session",
        token: sessionToken,
        githubId: issuedDashboardSession.githubId,
        githubLogin: issuedDashboardSession.githubLogin,
        issued: true
      };
    }
    if (isConfiguredToken(sessionToken, env.CONTRABASS_DASHBOARD_SESSION_TOKENS)) {
      return { kind: "dashboard-session", token: sessionToken };
    }
  }
  return void 0;
}
__name(validateAuthPrincipal, "validateAuthPrincipal");
async function startGitHubOAuth(context) {
  const clientId = context.env.CONTRABASS_GITHUB_CLIENT_ID?.trim();
  if (clientId === void 0 || clientId.length === 0 || dashboardSessionSigningSecret(context.env) === void 0) {
    return jsonResponse3({ error: "oauth_config_missing" }, 500);
  }
  const requestUrl = new URL(context.req.raw.url);
  const nonce = await randomTokenPart(24);
  const next = dashboardRedirectTarget(context.env, requestUrl.searchParams.get("next"));
  const state = await issueOAuthStateToken(context.env, nonce, next, Date.now() + OAUTH_STATE_TTL_MS);
  const redirectUri = `${requestUrl.origin}/v1/auth/github/callback`;
  const authorizeUrl = new URL(context.env.CONTRABASS_GITHUB_AUTHORIZE_URL ?? "https://github.com/login/oauth/authorize");
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("scope", "read:user");
  authorizeUrl.searchParams.set("state", state);
  return redirectResponse(authorizeUrl.toString(), 302, [
    serializeCookie(DASHBOARD_OAUTH_STATE_COOKIE_NAME, nonce, {
      httpOnly: true,
      path: "/v1/auth/github/callback",
      sameSite: "Lax",
      secure: requestUrl.protocol === "https:",
      maxAge: Math.floor(OAUTH_STATE_TTL_MS / 1e3)
    })
  ]);
}
__name(startGitHubOAuth, "startGitHubOAuth");
async function completeGitHubOAuth(context) {
  const requestUrl = new URL(context.req.raw.url);
  const code = requestUrl.searchParams.get("code")?.trim();
  const state = requestUrl.searchParams.get("state")?.trim();
  if (code === void 0 || code.length === 0 || state === void 0 || state.length === 0) {
    return jsonResponse3({ error: "oauth_invalid_callback" }, 400);
  }
  const statePayload = await validateOAuthStateToken(state, context.env);
  const stateCookie = extractNamedCookie(context.req.raw.headers.get("cookie"), DASHBOARD_OAUTH_STATE_COOKIE_NAME);
  if (statePayload === void 0 || stateCookie === void 0 || !timingSafeEqual(stateCookie, statePayload.nonce)) {
    return jsonResponse3({ error: "oauth_state_invalid" }, 401);
  }
  const githubUser = await exchangeGitHubOAuthCode(context.env, code, `${requestUrl.origin}/v1/auth/github/callback`);
  if (githubUser === void 0) {
    return jsonResponse3({ error: "oauth_exchange_failed" }, 401);
  }
  const expiresAt = Date.now() + DASHBOARD_SESSION_TTL_MS;
  const sessionToken = await issueDashboardSessionToken(context.env, githubUser, expiresAt);
  const cookies = [
    serializeCookie(DASHBOARD_SESSION_COOKIE_NAME, sessionToken, {
      httpOnly: true,
      path: "/",
      sameSite: "Lax",
      secure: requestUrl.protocol === "https:",
      maxAge: Math.floor(DASHBOARD_SESSION_TTL_MS / 1e3)
    }),
    serializeCookie(DASHBOARD_OAUTH_STATE_COOKIE_NAME, "", {
      httpOnly: true,
      path: "/v1/auth/github/callback",
      sameSite: "Lax",
      secure: requestUrl.protocol === "https:",
      maxAge: 0
    })
  ];
  return redirectResponse(statePayload.next, 302, cookies);
}
__name(completeGitHubOAuth, "completeGitHubOAuth");
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
  let renderedContentYaml;
  try {
    renderedContentYaml = renderWorkflowConfig(request.contentYaml, {
      boundSecrets: parseConfiguredTokens(context.env.CONTRABASS_CONFIG_BOUND_SECRETS),
      liquidContext: configLiquidContext(teamId, context.env.CONTRABASS_CONFIG_LIQUID_CONTEXT)
    });
  } catch (error) {
    if (isConfigParseError(error)) {
      return configInvalidResponse(error.details);
    }
    return configInvalidResponse([{ path: "$", message: "invalid workflow config" }]);
  }
  const contentHash = await sha256Hex(renderedContentYaml);
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
  `).bind(teamId, version, contentHash, renderedContentYaml, createdBy, createdAt, request.notes ?? "").run();
  return jsonResponse3({
    teamId,
    version,
    contentHash,
    unchanged: false,
    protocol_version: PROTOCOL_VERSION_CURRENT
  }, 201);
}
__name(createTeamConfig, "createTeamConfig");
async function getTeamConfigByHash(context) {
  const teamId = (context.req.param("teamId") ?? "").trim();
  const hash = (context.req.param("hash") ?? "").trim();
  if (teamId === "") {
    return errorResponse("invalid_team_id", 400);
  }
  if (!isContentHash(hash)) {
    return errorResponse("invalid_config_hash", 400);
  }
  const principal = context.get("principal");
  if ("issued" in principal && principal.teamId !== teamId) {
    return errorResponse("team_forbidden", 403);
  }
  if (context.env.CONTROL_PLANE_DB === void 0) {
    return errorResponse("config_store_unavailable", 500);
  }
  const config = await context.env.CONTROL_PLANE_DB.prepare(`
    SELECT content_yaml
    FROM team_configs
    WHERE team_id = ? AND content_hash = ?
    LIMIT 1
  `).bind(teamId, hash).first();
  if (config === null) {
    return errorResponse("config_not_found", 404);
  }
  return new Response(config.content_yaml, {
    status: 200,
    headers: {
      "Cache-Control": "public, max-age=86400, immutable",
      "Content-Type": "text/yaml; charset=utf-8"
    }
  });
}
__name(getTeamConfigByHash, "getTeamConfigByHash");
async function activateTeamConfigVersion(context) {
  const teamId = (context.req.param("teamId") ?? "").trim();
  const version = parsePositiveInteger(context.req.param("version") ?? "");
  if (teamId === "") {
    return errorResponse("invalid_team_id", 400);
  }
  if (version === void 0) {
    return errorResponse("invalid_config_version", 400);
  }
  const principal = context.get("principal");
  if ("issued" in principal && principal.teamId !== teamId) {
    return errorResponse("team_forbidden", 403);
  }
  if (context.env.CONTROL_PLANE_DB === void 0) {
    return errorResponse("config_store_unavailable", 500);
  }
  const body = await readOptionalObjectBody(context.req.raw);
  if (body === false) {
    return errorResponse("invalid_request", 400);
  }
  const config = await context.env.CONTROL_PLANE_DB.prepare(`
    SELECT version, content_hash
    FROM team_configs
    WHERE team_id = ? AND version = ?
    LIMIT 1
  `).bind(teamId, version).first();
  if (config === null) {
    return errorResponse("config_not_found", 404);
  }
  const activatedAt = (/* @__PURE__ */ new Date()).toISOString();
  const activatedBy = (body === void 0 ? void 0 : getStringField3(body, "activated_by") ?? getStringField3(body, "activatedBy")) ?? defaultConfigActor(principal);
  await context.env.CONTROL_PLANE_DB.prepare(`
    INSERT INTO team_configs_active (team_id, active_version, active_content_hash, activated_at, activated_by)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(team_id) DO UPDATE SET
      active_version = excluded.active_version,
      active_content_hash = excluded.active_content_hash,
      activated_at = excluded.activated_at,
      activated_by = excluded.activated_by
  `).bind(teamId, config.version, config.content_hash, activatedAt, activatedBy).run();
  const responseBody = {
    teamId,
    activeVersion: config.version,
    activeContentHash: config.content_hash,
    activatedAt,
    activatedBy,
    protocol_version: PROTOCOL_VERSION_CURRENT
  };
  const notificationResponse = await notifyTeamConfigChanged(context, responseBody);
  if (!notificationResponse.ok) {
    return normalizeForwardedErrorResponse(notificationResponse);
  }
  return jsonResponse3(responseBody, 200);
}
__name(activateTeamConfigVersion, "activateTeamConfigVersion");
async function getTeamConfigDiff(context) {
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
  const url = new URL(context.req.raw.url);
  const fromVersion = parseConfigVersionRef(url.searchParams.get("from"));
  const toVersion = parseConfigVersionRef(url.searchParams.get("to"));
  if (fromVersion === void 0 || toVersion === void 0) {
    return errorResponse("invalid_config_version", 400);
  }
  const [fromConfig, toConfig] = await Promise.all([
    readConfigVersion(context.env.CONTROL_PLANE_DB, teamId, fromVersion),
    readConfigVersion(context.env.CONTROL_PLANE_DB, teamId, toVersion)
  ]);
  if (fromConfig === void 0 || toConfig === void 0) {
    return errorResponse("config_not_found", 404);
  }
  const diff = buildUnifiedDiff({
    fromLabel: `v${fromConfig.version}`,
    fromContent: fromConfig.content_yaml,
    toLabel: `v${toConfig.version}`,
    toContent: toConfig.content_yaml
  });
  return jsonResponse3({
    teamId,
    from: configDiffMetadata(fromConfig),
    to: configDiffMetadata(toConfig),
    changed: fromConfig.content_hash !== toConfig.content_hash,
    diff,
    protocol_version: PROTOCOL_VERSION_CURRENT
  }, 200);
}
__name(getTeamConfigDiff, "getTeamConfigDiff");
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
  return extractNamedCookie(cookieHeader, DASHBOARD_SESSION_COOKIE_NAME);
}
__name(extractDashboardSessionCookie, "extractDashboardSessionCookie");
function extractNamedCookie(cookieHeader, cookieName) {
  if (cookieHeader === null) {
    return void 0;
  }
  for (const segment of cookieHeader.split(";")) {
    const [rawName, ...rawValueParts] = segment.trim().split("=");
    const value = rawValueParts.join("=").trim();
    if (rawName === cookieName && value.length > 0) {
      try {
        return decodeURIComponent(value);
      } catch {
        return void 0;
      }
    }
  }
  return void 0;
}
__name(extractNamedCookie, "extractNamedCookie");
function isConfiguredToken(token, configuredTokens) {
  return parseConfiguredTokens(configuredTokens).some((configuredToken) => timingSafeEqual(token, configuredToken));
}
__name(isConfiguredToken, "isConfiguredToken");
function parseConfiguredTokens(configuredTokens) {
  const raw3 = configuredTokens?.trim();
  if (raw3 === void 0 || raw3.length === 0) {
    return [];
  }
  if (raw3.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw3);
      if (Array.isArray(parsed) && parsed.every((token) => typeof token === "string")) {
        return parsed.map((token) => token.trim()).filter((token) => token.length > 0);
      }
    } catch {
      return [];
    }
    return [];
  }
  return raw3.split(/[\s,]+/u).map((token) => token.trim()).filter((token) => token.length > 0);
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
  return request.method === "POST" && (url.pathname === "/v1/workers/refresh" || url.pathname === "/v1/workers/enroll") || request.method === "GET" && (url.pathname === "/v1/auth/github/login" || url.pathname === "/v1/auth/github/callback");
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
function configLiquidContext(teamId, rawContext) {
  const defaultTeam = { id: teamId, name: teamId };
  if (rawContext === void 0 || rawContext.trim() === "") {
    return { team: defaultTeam };
  }
  let parsed;
  try {
    parsed = JSON.parse(rawContext);
  } catch {
    throw configParseError([{ path: "prompt", message: "invalid liquid context" }]);
  }
  if (!isPlainRecord(parsed) || "secrets" in parsed) {
    throw configParseError([{ path: "prompt", message: "invalid liquid context" }]);
  }
  const team = isPlainRecord(parsed.team) ? { ...defaultTeam, ...parsed.team } : defaultTeam;
  return { ...parsed, team };
}
__name(configLiquidContext, "configLiquidContext");
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
async function exchangeGitHubOAuthCode(env, code, redirectUri) {
  const clientId = env.CONTRABASS_GITHUB_CLIENT_ID?.trim();
  const clientSecret = env.CONTRABASS_GITHUB_CLIENT_SECRET?.trim();
  if (clientId === void 0 || clientId.length === 0 || clientSecret === void 0 || clientSecret.length === 0) {
    return void 0;
  }
  const tokenResponse = await fetch(env.CONTRABASS_GITHUB_TOKEN_URL ?? "https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": "contrabass-cloud"
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri
    })
  });
  if (!tokenResponse.ok) {
    return void 0;
  }
  const tokenBody = await readJsonObjectResponse(tokenResponse);
  const accessToken = tokenBody === void 0 ? void 0 : getStringField3(tokenBody, "access_token");
  if (accessToken === void 0) {
    return void 0;
  }
  const userResponse = await fetch(env.CONTRABASS_GITHUB_USER_URL ?? "https://api.github.com/user", {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${accessToken}`,
      "user-agent": "contrabass-cloud"
    }
  });
  if (!userResponse.ok) {
    return void 0;
  }
  const userBody = await readJsonObjectResponse(userResponse);
  if (userBody === void 0) {
    return void 0;
  }
  const id = userBody.id;
  const login = getStringField3(userBody, "login");
  return typeof id === "number" && Number.isInteger(id) && login !== void 0 ? { id, login } : void 0;
}
__name(exchangeGitHubOAuthCode, "exchangeGitHubOAuthCode");
async function readJsonObjectResponse(response) {
  let body;
  try {
    body = await response.json();
  } catch {
    return void 0;
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return void 0;
  }
  return body;
}
__name(readJsonObjectResponse, "readJsonObjectResponse");
function dashboardRedirectTarget(env, next) {
  const dashboardOrigin = env.CONTRABASS_DASHBOARD_ORIGIN?.trim();
  const fallback = dashboardOrigin === void 0 || dashboardOrigin.length === 0 ? "/" : dashboardOrigin;
  if (next === null || next.trim() === "") {
    return fallback;
  }
  const trimmedNext = next.trim();
  if (trimmedNext.startsWith("/") && !trimmedNext.startsWith("//")) {
    return dashboardOrigin === void 0 || dashboardOrigin.length === 0 ? trimmedNext : `${dashboardOrigin}${trimmedNext}`;
  }
  if (dashboardOrigin !== void 0 && dashboardOrigin.length > 0) {
    try {
      const nextUrl = new URL(trimmedNext);
      return nextUrl.origin === dashboardOrigin ? nextUrl.toString() : dashboardOrigin;
    } catch {
      return dashboardOrigin;
    }
  }
  return "/";
}
__name(dashboardRedirectTarget, "dashboardRedirectTarget");
async function issueOAuthStateToken(env, nonce, next, expiresAt) {
  const secret = dashboardSessionSigningSecret(env);
  if (secret === void 0) {
    throw new Error("CONTRABASS_DASHBOARD_SESSION_SECRET is required to issue OAuth state tokens");
  }
  const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ nonce, next, exp: expiresAt })));
  const signature = await hmacSha256Base64Url(secret, payload);
  return `cbo.${payload}.${signature}`;
}
__name(issueOAuthStateToken, "issueOAuthStateToken");
async function validateOAuthStateToken(token, env) {
  const secret = dashboardSessionSigningSecret(env);
  if (secret === void 0) {
    return void 0;
  }
  const [prefix, payload, signature] = token.split(".");
  if (prefix !== "cbo" || payload === void 0 || signature === void 0) {
    return void 0;
  }
  const expected = await hmacSha256Base64Url(secret, payload);
  if (!timingSafeEqual(signature, expected)) {
    return void 0;
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload)));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return void 0;
    }
    const record = parsed;
    return typeof record.nonce === "string" && typeof record.next === "string" && typeof record.exp === "number" && record.exp > Date.now() ? { nonce: record.nonce, next: record.next, exp: record.exp } : void 0;
  } catch {
    return void 0;
  }
}
__name(validateOAuthStateToken, "validateOAuthStateToken");
async function issueDashboardSessionToken(env, user, expiresAt) {
  const secret = dashboardSessionSigningSecret(env);
  if (secret === void 0) {
    throw new Error("CONTRABASS_DASHBOARD_SESSION_SECRET is required to issue dashboard session tokens");
  }
  const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify({
    githubId: user.id,
    githubLogin: user.login,
    exp: expiresAt
  })));
  const signature = await hmacSha256Base64Url(secret, payload);
  return `cbd.${payload}.${signature}`;
}
__name(issueDashboardSessionToken, "issueDashboardSessionToken");
async function validateDashboardSessionToken(token, env) {
  const secret = dashboardSessionSigningSecret(env);
  if (secret === void 0) {
    return void 0;
  }
  const [prefix, payload, signature] = token.split(".");
  if (prefix !== "cbd" || payload === void 0 || signature === void 0) {
    return void 0;
  }
  const expected = await hmacSha256Base64Url(secret, payload);
  if (!timingSafeEqual(signature, expected)) {
    return void 0;
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload)));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return void 0;
    }
    const record = parsed;
    return typeof record.githubId === "number" && Number.isInteger(record.githubId) && typeof record.githubLogin === "string" && typeof record.exp === "number" && record.exp > Date.now() ? { githubId: record.githubId, githubLogin: record.githubLogin, exp: record.exp } : void 0;
  } catch {
    return void 0;
  }
}
__name(validateDashboardSessionToken, "validateDashboardSessionToken");
function dashboardSessionSigningSecret(env) {
  const explicit = env.CONTRABASS_DASHBOARD_SESSION_SECRET?.trim();
  if (explicit !== void 0 && explicit.length > 0) {
    return explicit;
  }
  const configuredTokens = env.CONTRABASS_DASHBOARD_SESSION_TOKENS?.trim();
  return configuredTokens === void 0 || configuredTokens.length === 0 ? void 0 : configuredTokens;
}
__name(dashboardSessionSigningSecret, "dashboardSessionSigningSecret");
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
function isContentHash(value) {
  return /^[a-f0-9]{64}$/u.test(value);
}
__name(isContentHash, "isContentHash");
function parseConfigVersionRef(value) {
  if (value === null) {
    return void 0;
  }
  const normalized = value.trim().replace(/^v/iu, "");
  return parsePositiveInteger(normalized);
}
__name(parseConfigVersionRef, "parseConfigVersionRef");
async function readConfigVersion(db, teamId, version) {
  const row = await db.prepare(`
    SELECT version, content_hash, content_yaml, created_by, created_at, notes
    FROM team_configs
    WHERE team_id = ? AND version = ?
    LIMIT 1
  `).bind(teamId, version).first();
  return row ?? void 0;
}
__name(readConfigVersion, "readConfigVersion");
function configDiffMetadata(row) {
  return {
    version: row.version,
    contentHash: row.content_hash,
    createdBy: row.created_by,
    createdAt: row.created_at,
    notes: row.notes ?? ""
  };
}
__name(configDiffMetadata, "configDiffMetadata");
function buildUnifiedDiff(options) {
  const fromLines = splitDiffLines(options.fromContent);
  const toLines = splitDiffLines(options.toContent);
  const operations = diffLineOperations(fromLines, toLines);
  const body = operations.filter((operation) => operation.kind !== "equal").map((operation) => `${operation.kind === "delete" ? "-" : "+"}${operation.line}`);
  return [
    `--- ${options.fromLabel}`,
    `+++ ${options.toLabel}`,
    ...body
  ].join("\n");
}
__name(buildUnifiedDiff, "buildUnifiedDiff");
function splitDiffLines(content) {
  const lines = content.split("\n");
  return lines.at(-1) === "" ? lines.slice(0, -1) : lines;
}
__name(splitDiffLines, "splitDiffLines");
function diffLineOperations(fromLines, toLines) {
  const lcsLengths = Array.from({ length: fromLines.length + 1 }, () => Array(toLines.length + 1).fill(0));
  for (let fromIndex2 = fromLines.length - 1; fromIndex2 >= 0; fromIndex2 -= 1) {
    for (let toIndex2 = toLines.length - 1; toIndex2 >= 0; toIndex2 -= 1) {
      lcsLengths[fromIndex2][toIndex2] = fromLines[fromIndex2] === toLines[toIndex2] ? lcsLengths[fromIndex2 + 1][toIndex2 + 1] + 1 : Math.max(lcsLengths[fromIndex2 + 1][toIndex2], lcsLengths[fromIndex2][toIndex2 + 1]);
    }
  }
  const operations = [];
  let fromIndex = 0;
  let toIndex = 0;
  while (fromIndex < fromLines.length && toIndex < toLines.length) {
    if (fromLines[fromIndex] === toLines[toIndex]) {
      operations.push({ kind: "equal", line: fromLines[fromIndex] });
      fromIndex += 1;
      toIndex += 1;
    } else if (lcsLengths[fromIndex + 1][toIndex] >= lcsLengths[fromIndex][toIndex + 1]) {
      operations.push({ kind: "delete", line: fromLines[fromIndex] });
      fromIndex += 1;
    } else {
      operations.push({ kind: "insert", line: toLines[toIndex] });
      toIndex += 1;
    }
  }
  for (; fromIndex < fromLines.length; fromIndex += 1) {
    operations.push({ kind: "delete", line: fromLines[fromIndex] });
  }
  for (; toIndex < toLines.length; toIndex += 1) {
    operations.push({ kind: "insert", line: toLines[toIndex] });
  }
  return operations;
}
__name(diffLineOperations, "diffLineOperations");
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
function isIssuedWorkerPrincipal(principal) {
  return principal.kind === "bearer" && "issued" in principal;
}
__name(isIssuedWorkerPrincipal, "isIssuedWorkerPrincipal");
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
async function readOptionalObjectBody(request) {
  const text = await request.text();
  if (text.trim() === "") {
    return void 0;
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return false;
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return false;
  }
  return body;
}
__name(readOptionalObjectBody, "readOptionalObjectBody");
function isPlainRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
__name(isPlainRecord, "isPlainRecord");
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
function parsePositiveInteger(value) {
  if (!/^[1-9][0-9]*$/u.test(value)) {
    return void 0;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : void 0;
}
__name(parsePositiveInteger, "parsePositiveInteger");
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
  if (isIssuedWorkerPrincipal(principal) && principal.teamId !== teamId) {
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
async function notifyTeamConfigChanged(context, payload) {
  const id = context.env.TEAM_COORDINATOR.idFromName(String(payload.teamId));
  const stub = context.env.TEAM_COORDINATOR.get(id);
  const headers = new Headers(context.req.raw.headers);
  headers.set("content-type", "application/json");
  headers.set("x-contrabass-team-id", String(payload.teamId));
  return stub.fetch(new Request("https://team-coordinator.internal/config-changed", {
    method: "POST",
    headers,
    body: JSON.stringify({
      type: "config-changed",
      ...payload
    })
  }));
}
__name(notifyTeamConfigChanged, "notifyTeamConfigChanged");
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
  if (isIssuedWorkerPrincipal(principal)) {
    headers.set("x-contrabass-worker-id", principal.workerId);
  }
  const issueRef = await lookupIssueRefForRun(context, teamId, runId);
  if (issueRef === void 0) {
    return errorResponse("run_not_found", 404);
  }
  const body = issueRunPath === "/ack" && isIssuedWorkerPrincipal(principal) ? await ackBodyWithWorkerId(request, principal.workerId) : await request.arrayBuffer();
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
  if (isIssuedWorkerPrincipal(principal)) {
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
  if (isIssuedWorkerPrincipal(principal)) {
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
function redirectResponse(location, status, cookies) {
  const headers = new Headers({ location });
  for (const cookie of cookies) {
    headers.append("set-cookie", cookie);
  }
  return new Response(null, { status, headers });
}
__name(redirectResponse, "redirectResponse");
function serializeCookie(name, value, options) {
  const segments = [
    `${name}=${encodeURIComponent(value)}`,
    `Max-Age=${options.maxAge}`,
    `Path=${options.path}`,
    `SameSite=${options.sameSite}`
  ];
  if (options.httpOnly) {
    segments.push("HttpOnly");
  }
  if (options.secure) {
    segments.push("Secure");
  }
  return segments.join("; ");
}
__name(serializeCookie, "serializeCookie");
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
