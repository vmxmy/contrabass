export type TeamCoordinatorRecord = {
  teamId?: string;
  createdAt: number;
  updatedAt: number;
  paused: boolean;
};

export type TeamCoordinatorUsageCaps = {
  max_active_workers?: number;
  max_runs_per_day?: number;
  max_events_per_day?: number;
};

export type TeamCoordinatorBoardPhase = "open" | "claimed" | "running" | "done";

export type TeamCoordinatorBoardEntry = {
  issueRef: string;
  externalId?: string;
  runId?: string;
  assignedWorkerId?: string;
  phase: TeamCoordinatorBoardPhase;
  lastUpdated: number;
};

export type TeamCoordinatorBoard = Record<TeamCoordinatorBoardPhase, TeamCoordinatorBoardEntry[]>;

type BoardRefreshStats = {
  issuesNew: number;
  issuesUpdated: number;
};

export type TeamCoordinatorWorkerStatus = "idle" | "busy" | "unhealthy";

export type TeamCoordinatorWorkerKind = "local" | "container";

export type TeamCoordinatorWorkerRecord = {
  workerId: string;
  capabilities: string[];
  maxConcurrency: number;
  currentLoad: number;
  lastHeartbeatTs: number;
  kind: TeamCoordinatorWorkerKind;
  version: string;
  status: TeamCoordinatorWorkerStatus;
};

export type TeamCoordinatorWorkerRegistry = Record<string, TeamCoordinatorWorkerRecord>;

export type TeamCoordinatorDispatchFrame = {
  type: "dispatch";
  protocol_version: string;
  runId: string;
  issueRef: string;
  workerId: string;
  branch?: string;
  prompt?: string;
  configHash?: string;
  leaseSec?: number;
  artifactUploadURLs?: Record<string, unknown>;
};

export type TeamCoordinatorNotification = {
  eventId: string;
  type: "run-event" | "run-complete" | "lease-revoked" | "no-worker-available" | "config-changed";
  receivedAt: number;
  payload: Record<string, unknown>;
};

export type TeamCoordinatorStorage = {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
};

type DurableObjectStub = {
  fetch(input: string | Request, init?: RequestInit): Promise<Response>;
};

type IssueRunNamespace = {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStub;
};

type TeamCoordinatorDurableState = {
  storage: TeamCoordinatorStorage;
  acceptWebSocket?: (socket: WebSocket, tags?: string[]) => void;
  getWebSockets?: (tag?: string) => WebSocket[];
};

type TeamCoordinatorEnv = {
  ISSUE_RUN?: IssueRunNamespace;
};

type WebSocketPairConstructor = new () => {
  0: WebSocket;
  1: WebSocket;
};

const TEAM_RECORD_KEY = "team-coordinator:record";
const BOARD_KEY = "team-coordinator:board";
const NOTIFICATIONS_KEY = "team-coordinator:notifications";
const WORKER_PENDING_DISPATCHES_KEY = "team-coordinator:worker-pending-dispatches";
const WORKER_REGISTRY_KEY = "team-coordinator:worker-registry";
const USAGE_CAPS_KEY = "team-coordinator:usage-caps";
const USAGE_COUNTERS_KEY = "team-coordinator:usage-counters";
const INTERNAL_NOTIFICATION_PATHS = new Set(["/run-event", "/run-complete", "/lease-revoked", "/config-changed"]);
const BOARD_PHASES: TeamCoordinatorBoardPhase[] = ["open", "claimed", "running", "done"];
const PROTOCOL_VERSION = "1.0.0";
const EVENT_RING_BUFFER_LIMIT = 100;
const DEFAULT_WORKER_MAX_CONCURRENCY = 1;
const DEFAULT_REGISTRY_HEARTBEAT_INTERVAL_SEC = 30;

type TeamCoordinatorUsageCounters = {
  day: string;
  runs: number;
  events: number;
};

export class TeamCoordinator {
  private readonly subscribers = new Set<WebSocket>();
  private readonly workerDispatchSubscribers = new Map<string, Set<WebSocket>>();
  private readonly workerLongPollWaiters = new Map<string, Set<(dispatch: TeamCoordinatorDispatchFrame | undefined) => void>>();
  private workerRegistry: TeamCoordinatorWorkerRegistry | undefined;

  constructor(
    private readonly state: TeamCoordinatorDurableState,
    private readonly env: TeamCoordinatorEnv = {},
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/state")) {
      const record = await this.ensureRecord(request);
      return jsonResponse({ team: record, usageCaps: await this.ensureUsageCaps(request) });
    }

    if (request.method === "GET" && url.pathname === "/board") {
      return jsonResponse({ board: await this.ensureBoard() });
    }

    if (request.method === "GET" && url.pathname === "/workers") {
      return jsonResponse({ registry: await this.ensureWorkerRegistry() });
    }

    const workerDispatchMatch = /^\/workers\/([^/]+)\/dispatch$/u.exec(url.pathname);
    if (request.method === "GET" && workerDispatchMatch?.[1] !== undefined) {
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

    return jsonResponse({ error: "not_found" }, 404);
  }

  private async ensureRecord(request: Request): Promise<TeamCoordinatorRecord> {
    const existing = await this.state.storage.get<TeamCoordinatorRecord>(TEAM_RECORD_KEY);
    if (existing !== undefined) {
      return existing;
    }

    const now = Date.now();
    const teamId = getTeamId(request);
    const record: TeamCoordinatorRecord = {
      ...(teamId === undefined ? {} : { teamId }),
      createdAt: now,
      updatedAt: now,
      paused: false,
    };

    await this.state.storage.put(TEAM_RECORD_KEY, record);
    return record;
  }

  private async ensureBoard(): Promise<TeamCoordinatorBoard> {
    const existing = await this.state.storage.get<TeamCoordinatorBoard>(BOARD_KEY);
    if (existing !== undefined) {
      return normalizeBoard(existing);
    }

    const board = emptyBoard();
    await this.state.storage.put(BOARD_KEY, board);
    return board;
  }

  private async ensureWorkerRegistry(): Promise<TeamCoordinatorWorkerRegistry> {
    if (this.workerRegistry !== undefined) {
      const evaluated = evaluateWorkerHealth(this.workerRegistry, Date.now());
      if (evaluated.changed) {
        await this.persistWorkerRegistry(evaluated.registry);
      }
      return evaluated.registry;
    }

    const existing = await this.state.storage.get<TeamCoordinatorWorkerRegistry>(WORKER_REGISTRY_KEY);
    const normalized = normalizeWorkerRegistry(existing ?? {}, Date.now());
    this.workerRegistry = normalized;
    await this.state.storage.put(WORKER_REGISTRY_KEY, normalized);
    return normalized;
  }

  private async persistWorkerRegistry(registry: TeamCoordinatorWorkerRegistry): Promise<void> {
    this.workerRegistry = registry;
    await this.state.storage.put(WORKER_REGISTRY_KEY, registry);
  }

  private async registerWorker(request: Request): Promise<Response> {
    const body = await readObjectBody(request);
    if (body === undefined) {
      return jsonResponse({ error: "invalid_request", message: "body must be a JSON object" }, 400);
    }

    const now = Date.now();
    const worker = workerRecordFromRegistrationBody(body, now);
    if (worker === undefined) {
      return jsonResponse({
        error: "invalid_request",
        message: "workerId, capabilities, maxConcurrency, kind, and version are required",
      }, 400);
    }

    const registry = {
      ...await this.ensureWorkerRegistry(),
    };
    const existing = registry[worker.workerId];
    const usageCaps = await this.ensureUsageCaps(request);
    if (existing === undefined && exceedsActiveWorkerCap(registry, usageCaps)) {
      return teamWorkerCapExceededResponse(usageCaps.max_active_workers);
    }

    const updatedRegistry = {
      ...registry,
      [worker.workerId]: worker,
    };
    await this.persistWorkerRegistry(updatedRegistry);
    await this.touchRecord(request);
    this.broadcast(workerStatusFrame(worker));

    return jsonResponse({ worker, registry: updatedRegistry });
  }

  private async recordWorkerHeartbeat(request: Request): Promise<Response> {
    const body = await readObjectBody(request);
    if (body === undefined) {
      return jsonResponse({ error: "invalid_request", message: "body must be a JSON object" }, 400);
    }

    const workerId = getStringField(body, "workerId") ?? getStringField(body, "worker_id");
    if (workerId === undefined) {
      return jsonResponse({ error: "invalid_request", message: "workerId is required" }, 400);
    }

    const registry = await this.ensureWorkerRegistry();
    const existing = registry[workerId];
    if (existing === undefined) {
      return jsonResponse({ error: "worker_not_registered" }, 404);
    }

    const currentLoad = clampWorkerLoad(
      getNumberField(body, "currentLoad") ?? getNumberField(body, "current_load") ?? existing.currentLoad,
      existing.maxConcurrency,
    );
    const worker = {
      ...existing,
      currentLoad,
      lastHeartbeatTs: Date.now(),
      status: statusForWorkerLoad(currentLoad),
    };
    const updatedRegistry = {
      ...registry,
      [workerId]: worker,
    };
    await this.persistWorkerRegistry(updatedRegistry);
    await this.touchRecord(request);
    this.broadcast(workerStatusFrame(worker));

    return jsonResponse({ worker, registry: updatedRegistry });
  }

  private async dispatchRun(request: Request): Promise<Response> {
    const body = await readObjectBody(request);
    if (body === undefined) {
      return jsonResponse({ error: "invalid_request", message: "body must be a JSON object" }, 400);
    }

    const runId = getStringField(body, "runId") ?? getStringField(body, "run_id");
    const issueRef = getStringField(body, "issueRef") ?? getStringField(body, "issue_ref");
    if (runId === undefined || issueRef === undefined) {
      return jsonResponse({ error: "invalid_request", message: "runId and issueRef are required" }, 400);
    }

    const requiredCapabilities = getDispatchRequiredCapabilities(body);
    if (requiredCapabilities === undefined) {
      return jsonResponse({ error: "invalid_request", message: "required capabilities must be strings" }, 400);
    }

    const usageCaps = await this.ensureUsageCaps(request);
    const counters = await this.ensureUsageCounters();
    if (usageCaps.max_runs_per_day !== undefined && counters.runs >= usageCaps.max_runs_per_day) {
      return usageCapExceededResponse("team_run_cap_exceeded", "max_runs_per_day", usageCaps.max_runs_per_day);
    }

    const acceptedCounters = { ...counters, runs: counters.runs + 1 };
    const record = await this.ensureRecord(request);
    if (record.paused) {
      const board = mergeBoard(await this.ensureBoard(), boardWithEntries([
        {
          issueRef,
          runId,
          phase: "open",
          lastUpdated: Date.now(),
        },
      ]));
      await this.state.storage.put(BOARD_KEY, board);
      await this.persistUsageCounters(acceptedCounters);
      await this.touchRecord(request);
      this.broadcast(boardUpdateFrame(board));

      return jsonResponse({ dispatched: false, paused: true, board }, 202);
    }

    const registry = await this.ensureWorkerRegistry();
    const selectedWorker = selectDispatchWorker(registry, requiredCapabilities);
    if (selectedWorker === undefined) {
      await this.persistUsageCounters(acceptedCounters);
      const event = await this.emitNoWorkerAvailable(request, body, requiredCapabilities);
      return jsonResponse({ dispatched: false, event }, 202);
    }

    const worker = incrementWorkerLoad(selectedWorker);
    const updatedRegistry = {
      ...registry,
      [worker.workerId]: worker,
    };
    await this.persistWorkerRegistry(updatedRegistry);
    await this.persistUsageCounters(acceptedCounters);

    const board = mergeBoard(await this.ensureBoard(), boardWithEntries([
      {
        issueRef,
        runId,
        assignedWorkerId: worker.workerId,
        phase: "claimed",
        lastUpdated: Date.now(),
      },
    ]));
    await this.state.storage.put(BOARD_KEY, board);
    await this.touchRecord(request);

    const dispatch = dispatchFrameFromBody(body, worker.workerId, runId, issueRef);
    this.broadcast(workerStatusFrame(worker));
    this.broadcast(boardUpdateFrame(board));
    if (this.hasWorkerDispatchSubscriber(worker.workerId)) {
      this.sendToWorker(worker.workerId, dispatch);
    } else {
      await this.deliverLongPollDispatch(worker.workerId, dispatch);
    }

    return jsonResponse({ dispatched: true, worker, dispatch, board });
  }

  private async longPollWorkerDispatch(workerId: string, url: URL): Promise<Response> {
    const normalizedWorkerId = decodeURIComponent(workerId).trim();
    if (normalizedWorkerId === "") {
      return jsonResponse({ error: "invalid_worker_id" }, 400);
    }

    const queued = await this.takePendingDispatch(normalizedWorkerId);
    if (queued !== undefined) {
      return jsonResponse({ ...queued });
    }

    const waitMs = parseWaitMs(url.searchParams.get("wait"));
    if (waitMs <= 0) {
      return new Response(null, { status: 204 });
    }

    const dispatch = await this.waitForWorkerDispatch(normalizedWorkerId, waitMs);
    return dispatch === undefined ? new Response(null, { status: 204 }) : jsonResponse({ ...dispatch });
  }

  private async refreshBoard(request: Request): Promise<Response> {
    const body = await readObjectBody(request);
    if (body === undefined) {
      return jsonResponse({ error: "invalid_request", message: "body must be a JSON object" }, 400);
    }

    const now = Date.now();
    const refreshedBoard = boardFromRefreshBody(body, now);
    if (refreshedBoard === undefined) {
      return jsonResponse({ error: "invalid_request", message: "body must include a valid board or entries" }, 400);
    }

    const existingBoard = await this.ensureBoard();
    const issueStats = boardRefreshStats(existingBoard, refreshedBoard);
    const board = isFullBoardRefreshBody(body) ? refreshedBoard : mergeBoard(existingBoard, refreshedBoard);
    await this.state.storage.put(BOARD_KEY, board);
    await this.touchRecord(request);
    this.broadcast(boardUpdateFrame(board));

    return jsonResponse({ board, issueStats });
  }

  private async reassignRun(request: Request): Promise<Response> {
    const body = await readObjectBody(request);
    if (body === undefined) {
      return jsonResponse({ error: "invalid_request", message: "body must be a JSON object" }, 400);
    }

    const runId = getStringField(body, "runId") ?? getStringField(body, "run_id");
    const targetWorkerId = getStringField(body, "targetWorkerId") ?? getStringField(body, "target_worker_id");
    if (runId === undefined || targetWorkerId === undefined) {
      return jsonResponse({ error: "invalid_request", message: "runId and targetWorkerId are required" }, 400);
    }

    const board = await this.ensureBoard();
    const existingEntry = findBoardEntryByRunId(board, runId);
    if (existingEntry === undefined) {
      return jsonResponse({ error: "run_not_found" }, 404);
    }

    const registry = await this.ensureWorkerRegistry();
    const targetWorker = registry[targetWorkerId];
    if (targetWorker === undefined) {
      return jsonResponse({ error: "target_worker_not_registered" }, 404);
    }
    if (!isDispatchCandidate(targetWorker, [])) {
      return jsonResponse({ error: "target_worker_unavailable" }, 409);
    }

    const issueRun = await this.issueRunStub(request, body, existingEntry);
    if (issueRun === undefined) {
      return jsonResponse({ error: "issue_run_binding_unavailable" }, 503);
    }

    const revokeResponse = await issueRun.fetch("https://issue-run.internal/revoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "manual_reassign" }),
    });
    if (!revokeResponse.ok) {
      return forwardErrorResponse(revokeResponse);
    }

    const dispatch = dispatchFrameFromBody(body, targetWorkerId, runId, existingEntry.issueRef);
    const dispatchResponse = await issueRun.fetch("https://issue-run.internal/dispatch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(dispatch),
    });
    if (!dispatchResponse.ok) {
      return forwardErrorResponse(dispatchResponse);
    }

    const updatedRegistry: TeamCoordinatorWorkerRegistry = {
      ...registry,
      [targetWorkerId]: incrementWorkerLoad(targetWorker),
    };
    if (existingEntry.assignedWorkerId !== undefined) {
      const previousWorker = decrementWorkerLoad(registry[existingEntry.assignedWorkerId]);
      if (previousWorker !== undefined) {
        updatedRegistry[existingEntry.assignedWorkerId] = previousWorker;
      }
    }
    await this.persistWorkerRegistry(updatedRegistry);

    const updatedBoard = moveBoardEntry(board, runId, {
      assignedWorkerId: targetWorkerId,
      phase: "claimed",
      lastUpdated: Date.now(),
    });
    await this.state.storage.put(BOARD_KEY, updatedBoard);
    await this.touchRecord(request);

    if (existingEntry.assignedWorkerId !== undefined && updatedRegistry[existingEntry.assignedWorkerId] !== undefined) {
      this.broadcast(workerStatusFrame(updatedRegistry[existingEntry.assignedWorkerId]));
    }
    this.broadcast(workerStatusFrame(updatedRegistry[targetWorkerId]));
    this.broadcast(boardUpdateFrame(updatedBoard));
    if (this.hasWorkerDispatchSubscriber(targetWorkerId)) {
      this.sendToWorker(targetWorkerId, dispatch);
    } else {
      await this.deliverLongPollDispatch(targetWorkerId, dispatch);
    }

    return jsonResponse({ reassigned: true, dispatch, board: updatedBoard, registry: updatedRegistry });
  }

  private async cancelRun(request: Request): Promise<Response> {
    const body = await readObjectBody(request);
    if (body === undefined) {
      return jsonResponse({ error: "invalid_request", message: "body must be a JSON object" }, 400);
    }

    const runId = getStringField(body, "runId") ?? getStringField(body, "run_id");
    if (runId === undefined) {
      return jsonResponse({ error: "invalid_request", message: "runId is required" }, 400);
    }

    const board = await this.ensureBoard();
    const existingEntry = findBoardEntryByRunId(board, runId);
    if (existingEntry === undefined) {
      return jsonResponse({ error: "run_not_found" }, 404);
    }

    const issueRun = await this.issueRunStub(request, body, existingEntry);
    if (issueRun === undefined) {
      return jsonResponse({ error: "issue_run_binding_unavailable" }, 503);
    }

    const cancelResponse = await issueRun.fetch("https://issue-run.internal/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!cancelResponse.ok) {
      return forwardErrorResponse(cancelResponse);
    }

    const registry = await this.ensureWorkerRegistry();
    const updatedRegistry: TeamCoordinatorWorkerRegistry = { ...registry };
    if (existingEntry.assignedWorkerId !== undefined) {
      const previousWorker = decrementWorkerLoad(registry[existingEntry.assignedWorkerId]);
      if (previousWorker !== undefined) {
        updatedRegistry[existingEntry.assignedWorkerId] = previousWorker;
      }
      await this.persistWorkerRegistry(updatedRegistry);
      if (updatedRegistry[existingEntry.assignedWorkerId] !== undefined) {
        this.broadcast(workerStatusFrame(updatedRegistry[existingEntry.assignedWorkerId]));
      }
    }

    const updatedBoard = moveBoardEntry(board, runId, {
      phase: "done",
      lastUpdated: Date.now(),
    });
    await this.state.storage.put(BOARD_KEY, updatedBoard);
    await this.touchRecord(request);
    this.broadcast(boardUpdateFrame(updatedBoard));

    return jsonResponse({ cancelled: true, board: updatedBoard, registry: updatedRegistry });
  }

  private async setTeamPaused(request: Request, paused: boolean): Promise<Response> {
    const record = await this.ensureRecord(request);
    const updated = {
      ...record,
      paused,
      updatedAt: Date.now(),
    };
    await this.state.storage.put(TEAM_RECORD_KEY, updated);

    return jsonResponse({ team: updated });
  }

  private async subscribe(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return jsonResponse({ error: "websocket_required" }, 426);
    }

    const pair = createWebSocketPair();
    if (pair === undefined) {
      return jsonResponse({ error: "websocket_unavailable" }, 501);
    }

    const [client, server] = pair;
    const workerId = getSubscriptionWorkerId(request);
    if (workerId !== undefined) {
      server.accept();
      this.addWorkerDispatchSubscriber(workerId, server);
    } else {
      this.acceptDashboardSubscriber(server);

      server.send(JSON.stringify(boardUpdateFrame(await this.ensureBoard())));
      const notifications = await this.state.storage.get<TeamCoordinatorNotification[]>(NOTIFICATIONS_KEY);
      const lastEventId = getLastEventId(request);
      for (const notification of replayNotifications(notifications ?? [], lastEventId)) {
        server.send(JSON.stringify(notificationFrame(notification)));
      }
    }

    return webSocketResponse(client);
  }

  private async acceptInternalNotification(request: Request, pathname: string): Promise<Response> {
    const record = await this.ensureRecord(request);
    const body = await readObjectBody(request);
    if (body === undefined) {
      return jsonResponse({ error: "invalid_request", message: "body must be a JSON object" }, 400);
    }

    const now = Date.now();
    const usageCaps = pathname === "/config-changed"
      ? (parseUsageCaps(body) ?? await this.ensureUsageCaps(request))
      : await this.ensureUsageCaps(request);
    const counters = await this.ensureUsageCounters();
    if (
      pathname === "/run-event"
      && usageCaps.max_events_per_day !== undefined
      && counters.events >= usageCaps.max_events_per_day
    ) {
      return usageCapExceededResponse("team_event_cap_exceeded", "max_events_per_day", usageCaps.max_events_per_day);
    }

    const notifications = await this.state.storage.get<TeamCoordinatorNotification[]>(NOTIFICATIONS_KEY);
    const notification: TeamCoordinatorNotification = {
      eventId: nextNotificationEventId(notifications ?? []),
      type: notificationTypeForPath(pathname),
      receivedAt: now,
      payload: body,
    };

    await this.state.storage.put(NOTIFICATIONS_KEY, appendNotification(notifications ?? [], notification));
    if (notification.type === "run-event") {
      await this.persistUsageCounters({ ...counters, events: counters.events + 1 });
    }
    if (notification.type === "config-changed") {
      const updatedCaps = parseUsageCaps(body);
      if (updatedCaps !== undefined) {
        await this.state.storage.put(USAGE_CAPS_KEY, updatedCaps);
      }
    }
    await this.state.storage.put(TEAM_RECORD_KEY, {
      ...record,
      updatedAt: now,
    });
    const frame = notificationFrame(notification);
    if (notification.type === "lease-revoked") {
      const workerId = getStringField(body, "workerId") ?? getStringField(body, "worker_id");
      if (workerId !== undefined) {
        this.sendToWorker(workerId, frame);
      }
    }
    this.broadcast(frame);

    return jsonResponse({ accepted: true, type: notification.type });
  }

  private async emitNoWorkerAvailable(
    request: Request,
    payload: Record<string, unknown>,
    requiredCapabilities: string[],
  ): Promise<TeamCoordinatorNotification> {
    const record = await this.ensureRecord(request);
    const now = Date.now();
    const notifications = await this.state.storage.get<TeamCoordinatorNotification[]>(NOTIFICATIONS_KEY);
    const notification: TeamCoordinatorNotification = {
      eventId: nextNotificationEventId(notifications ?? []),
      type: "no-worker-available",
      receivedAt: now,
      payload: {
        ...payload,
        requiredCapabilities,
      },
    };

    await this.state.storage.put(NOTIFICATIONS_KEY, appendNotification(notifications ?? [], notification));
    await this.state.storage.put(TEAM_RECORD_KEY, {
      ...record,
      updatedAt: now,
    });
    this.broadcast(notificationFrame(notification));

    return notification;
  }

  private async touchRecord(request: Request): Promise<void> {
    const record = await this.ensureRecord(request);
    await this.state.storage.put(TEAM_RECORD_KEY, {
      ...record,
      updatedAt: Date.now(),
    });
  }

  private async ensureUsageCaps(request: Request): Promise<TeamCoordinatorUsageCaps> {
    const stored = await this.state.storage.get<TeamCoordinatorUsageCaps>(USAGE_CAPS_KEY);
    if (stored !== undefined) {
      return normalizeUsageCaps(stored) ?? {};
    }

    const headers = usageCapsFromHeaders(request.headers);
    if (headers !== undefined) {
      await this.state.storage.put(USAGE_CAPS_KEY, headers);
      return headers;
    }

    return {};
  }

  private async ensureUsageCounters(): Promise<TeamCoordinatorUsageCounters> {
    const day = usageDay(Date.now());
    const stored = await this.state.storage.get<TeamCoordinatorUsageCounters>(USAGE_COUNTERS_KEY);
    if (stored !== undefined && stored.day === day) {
      return {
        day,
        runs: Math.max(0, Math.trunc(stored.runs)),
        events: Math.max(0, Math.trunc(stored.events)),
      };
    }

    const counters = { day, runs: 0, events: 0 };
    await this.persistUsageCounters(counters);
    return counters;
  }

  private async persistUsageCounters(counters: TeamCoordinatorUsageCounters): Promise<void> {
    await this.state.storage.put(USAGE_COUNTERS_KEY, counters);
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    if (message === "ping") {
      socket.send(JSON.stringify({ type: "pong", protocol_version: PROTOCOL_VERSION }));
    }
  }

  webSocketClose(socket: WebSocket): void {
    this.subscribers.delete(socket);
  }

  webSocketError(socket: WebSocket): void {
    this.subscribers.delete(socket);
  }

  private acceptDashboardSubscriber(socket: WebSocket): void {
    if (this.state.acceptWebSocket !== undefined) {
      this.state.acceptWebSocket(socket, ["dashboard"]);
      return;
    }

    socket.accept();
    this.subscribers.add(socket);
    const removeSubscriber = () => {
      this.subscribers.delete(socket);
    };
    socket.addEventListener("close", removeSubscriber);
    socket.addEventListener("error", removeSubscriber);
  }

  private broadcast(frame: Record<string, unknown>): void {
    const message = JSON.stringify(frame);
    for (const subscriber of this.dashboardSubscribers()) {
      try {
        subscriber.send(message);
      } catch {
        this.subscribers.delete(subscriber);
      }
    }
  }

  private dashboardSubscribers(): WebSocket[] {
    const sockets = new Set(this.subscribers);
    for (const socket of this.state.getWebSockets?.("dashboard") ?? []) {
      sockets.add(socket);
    }
    return [...sockets];
  }

  private addWorkerDispatchSubscriber(workerId: string, socket: WebSocket): void {
    const sockets = this.workerDispatchSubscribers.get(workerId) ?? new Set<WebSocket>();
    sockets.add(socket);
    this.workerDispatchSubscribers.set(workerId, sockets);

    const removeSubscriber = () => {
      sockets.delete(socket);
      if (sockets.size === 0) {
        this.workerDispatchSubscribers.delete(workerId);
      }
    };
    socket.addEventListener("close", removeSubscriber);
    socket.addEventListener("error", removeSubscriber);
  }

  private hasWorkerDispatchSubscriber(workerId: string): boolean {
    return (this.workerDispatchSubscribers.get(workerId)?.size ?? 0) > 0;
  }

  private sendToWorker(workerId: string, frame: Record<string, unknown>): void {
    const sockets = this.workerDispatchSubscribers.get(workerId);
    if (sockets === undefined) {
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

  private async deliverLongPollDispatch(workerId: string, dispatch: TeamCoordinatorDispatchFrame): Promise<void> {
    const waiters = this.workerLongPollWaiters.get(workerId);
    const waiter = waiters?.values().next().value;
    if (waiter !== undefined) {
      waiters?.delete(waiter);
      if (waiters?.size === 0) {
        this.workerLongPollWaiters.delete(workerId);
      }
      waiter(dispatch);
      return;
    }

    const pending = await this.state.storage.get<Record<string, TeamCoordinatorDispatchFrame[]>>(
      WORKER_PENDING_DISPATCHES_KEY,
    ) ?? {};
    const workerQueue = pending[workerId] ?? [];
    await this.state.storage.put(WORKER_PENDING_DISPATCHES_KEY, {
      ...pending,
      [workerId]: [...workerQueue, dispatch],
    });
  }

  private async takePendingDispatch(workerId: string): Promise<TeamCoordinatorDispatchFrame | undefined> {
    const pending = await this.state.storage.get<Record<string, TeamCoordinatorDispatchFrame[]>>(
      WORKER_PENDING_DISPATCHES_KEY,
    );
    const workerQueue = pending?.[workerId];
    if (pending === undefined || workerQueue === undefined || workerQueue.length === 0) {
      return undefined;
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

  private waitForWorkerDispatch(
    workerId: string,
    waitMs: number,
  ): Promise<TeamCoordinatorDispatchFrame | undefined> {
    return new Promise((resolve) => {
      const waiters = this.workerLongPollWaiters.get(workerId) ?? new Set();
      const timeout = setTimeout(() => {
        waiters.delete(resolveOnce);
        if (waiters.size === 0) {
          this.workerLongPollWaiters.delete(workerId);
        }
        resolve(undefined);
      }, waitMs);
      const resolveOnce = (dispatch: TeamCoordinatorDispatchFrame | undefined) => {
        clearTimeout(timeout);
        resolve(dispatch);
      };

      waiters.add(resolveOnce);
      this.workerLongPollWaiters.set(workerId, waiters);
    });
  }

  private async issueRunStub(
    request: Request,
    body: Record<string, unknown>,
    entry: TeamCoordinatorBoardEntry,
  ): Promise<DurableObjectStub | undefined> {
    if (this.env.ISSUE_RUN === undefined) {
      return undefined;
    }

    const record = await this.ensureRecord(request);
    const teamId = getStringField(body, "teamId") ?? getStringField(body, "team_id") ?? record.teamId ?? getTeamId(request);
    if (teamId === undefined) {
      return undefined;
    }

    const id = this.env.ISSUE_RUN.idFromName(`${teamId}:${entry.issueRef}`);
    return this.env.ISSUE_RUN.get(id);
  }
}

function notificationTypeForPath(pathname: string): TeamCoordinatorNotification["type"] {
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

function createWebSocketPair(): [WebSocket, WebSocket] | undefined {
  const Pair = (globalThis as unknown as { WebSocketPair?: WebSocketPairConstructor }).WebSocketPair;
  if (Pair === undefined) {
    return undefined;
  }

  const pair = new Pair();
  return [pair[0], pair[1]];
}

function emptyBoard(): TeamCoordinatorBoard {
  return {
    open: [],
    claimed: [],
    running: [],
    done: [],
  };
}

function normalizeBoard(raw: Partial<TeamCoordinatorBoard>): TeamCoordinatorBoard {
  return {
    open: normalizeBoardEntries(raw.open, "open"),
    claimed: normalizeBoardEntries(raw.claimed, "claimed"),
    running: normalizeBoardEntries(raw.running, "running"),
    done: normalizeBoardEntries(raw.done, "done"),
  };
}

function normalizeBoardEntries(
  entries: TeamCoordinatorBoardEntry[] | undefined,
  phase: TeamCoordinatorBoardPhase,
): TeamCoordinatorBoardEntry[] {
  return (entries ?? []).flatMap((entry) => {
    const normalized = normalizeBoardEntry(entry, phase, Date.now());
    return normalized === undefined ? [] : [normalized];
  });
}

function isFullBoardRefreshBody(body: Record<string, unknown>): boolean {
  const maybeBoard = getObjectField(body, "board") ?? body;
  return hasBoardLists(maybeBoard);
}

function boardRefreshStats(existing: TeamCoordinatorBoard, updates: TeamCoordinatorBoard): BoardRefreshStats {
  const updatedEntries = BOARD_PHASES.flatMap((phase) => updates[phase]);
  let issuesNew = 0;
  let issuesUpdated = 0;

  for (const update of updatedEntries) {
    const existingEntry = BOARD_PHASES
      .flatMap((phase) => existing[phase])
      .find((entry) => boardEntriesReferToSameIssue(entry, update));
    if (existingEntry === undefined) {
      issuesNew += 1;
    } else if (!boardEntriesEqual(existingEntry, update)) {
      issuesUpdated += 1;
    }
  }

  return { issuesNew, issuesUpdated };
}

function boardEntriesEqual(left: TeamCoordinatorBoardEntry, right: TeamCoordinatorBoardEntry): boolean {
  return left.issueRef === right.issueRef
    && left.externalId === right.externalId
    && left.runId === right.runId
    && left.assignedWorkerId === right.assignedWorkerId
    && left.phase === right.phase
    && left.lastUpdated === right.lastUpdated;
}

function mergeBoard(existing: TeamCoordinatorBoard, updates: TeamCoordinatorBoard): TeamCoordinatorBoard {
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

function boardEntriesReferToSameIssue(
  existing: TeamCoordinatorBoardEntry,
  update: TeamCoordinatorBoardEntry,
): boolean {
  if (existing.externalId !== undefined && update.externalId !== undefined) {
    return existing.externalId === update.externalId;
  }
  return existing.issueRef === update.issueRef;
}

function boardFromRefreshBody(body: Record<string, unknown>, now: number): TeamCoordinatorBoard | undefined {
  const maybeBoard = getObjectField(body, "board") ?? body;
  if (hasBoardLists(maybeBoard)) {
    const board = emptyBoard();
    for (const phase of BOARD_PHASES) {
      const entries = maybeBoard[phase];
      if (!Array.isArray(entries)) {
        return undefined;
      }
      board[phase] = entries.flatMap((entry) => {
        const normalized = normalizeBoardEntry(entry, phase, now);
        return normalized === undefined ? [] : [normalized];
      });
    }
    return board;
  }

  const entries = Array.isArray(body.entries) ? body.entries : Array.isArray(body.issues) ? body.issues : undefined;
  if (entries === undefined) {
    const single = normalizeBoardEntry(body, phaseFromUnknown(body.phase) ?? "open", now);
    return single === undefined ? undefined : boardWithEntries([single]);
  }

  const normalizedEntries = entries.flatMap((entry) => {
    const normalized = normalizeBoardEntry(entry, undefined, now);
    return normalized === undefined ? [] : [normalized];
  });
  return boardWithEntries(normalizedEntries);
}

function hasBoardLists(value: Record<string, unknown>): boolean {
  return BOARD_PHASES.every((phase) => Array.isArray(value[phase]));
}

function boardWithEntries(entries: TeamCoordinatorBoardEntry[]): TeamCoordinatorBoard {
  const board = emptyBoard();
  for (const entry of entries) {
    board[entry.phase].push(entry);
  }
  return board;
}

function findBoardEntryByRunId(
  board: TeamCoordinatorBoard,
  runId: string,
): TeamCoordinatorBoardEntry | undefined {
  for (const phase of BOARD_PHASES) {
    const entry = board[phase].find((candidate) => candidate.runId === runId);
    if (entry !== undefined) {
      return entry;
    }
  }
  return undefined;
}

function moveBoardEntry(
  board: TeamCoordinatorBoard,
  runId: string,
  updates: Partial<TeamCoordinatorBoardEntry> & { phase: TeamCoordinatorBoardPhase },
): TeamCoordinatorBoard {
  const existing = findBoardEntryByRunId(board, runId);
  if (existing === undefined) {
    return board;
  }

  const moved = {
    ...existing,
    ...updates,
  };
  const next = emptyBoard();
  for (const phase of BOARD_PHASES) {
    next[phase] = board[phase].filter((entry) => entry.runId !== runId);
  }
  next[moved.phase].push(moved);
  return next;
}

function normalizeBoardEntry(
  value: unknown,
  defaultPhase: TeamCoordinatorBoardPhase | undefined,
  now: number,
): TeamCoordinatorBoardEntry | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const entry = value as Record<string, unknown>;
  const issueRef = getStringField(entry, "issueRef") ?? getStringField(entry, "issue_ref") ?? getStringField(entry, "id");
  if (issueRef === undefined) {
    return undefined;
  }

  const externalId = getStringField(entry, "externalId") ?? getStringField(entry, "external_id");
  const phase = phaseFromUnknown(entry.phase) ?? defaultPhase ?? "open";
  const externalId = getStringField(entry, "externalId") ?? getStringField(entry, "external_id");
  const runId = getStringField(entry, "runId") ?? getStringField(entry, "run_id");
  const assignedWorkerId = getStringField(entry, "assignedWorkerId")
    ?? getStringField(entry, "assigned_worker_id")
    ?? getStringField(entry, "workerId")
    ?? getStringField(entry, "worker_id");

  return {
    issueRef,
    ...(externalId === undefined ? {} : { externalId }),
    ...(runId === undefined ? {} : { runId }),
    ...(assignedWorkerId === undefined ? {} : { assignedWorkerId }),
    phase,
    lastUpdated: getNumberField(entry, "lastUpdated") ?? getNumberField(entry, "last_updated") ?? now,
  };
}

function phaseFromUnknown(value: unknown): TeamCoordinatorBoardPhase | undefined {
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
  return undefined;
}

function boardUpdateFrame(board: TeamCoordinatorBoard): Record<string, unknown> {
  return {
    type: "board-update",
    protocol_version: PROTOCOL_VERSION,
    board,
  };
}

function workerStatusFrame(worker: TeamCoordinatorWorkerRecord): Record<string, unknown> {
  return {
    type: "worker-status",
    protocol_version: PROTOCOL_VERSION,
    worker,
  };
}

function notificationFrame(notification: TeamCoordinatorNotification): Record<string, unknown> {
  if (notification.payload.type === notification.type) {
    return {
      protocol_version: PROTOCOL_VERSION,
      ...notification.payload,
      type: notification.type,
      event_id: notification.eventId,
      receivedAt: notification.receivedAt,
    };
  }

  return {
    type: notification.type,
    protocol_version: PROTOCOL_VERSION,
    event_id: notification.eventId,
    receivedAt: notification.receivedAt,
    payload: notification.payload,
  };
}

function appendNotification(
  notifications: TeamCoordinatorNotification[],
  notification: TeamCoordinatorNotification,
): TeamCoordinatorNotification[] {
  return [...notifications, notification].slice(-EVENT_RING_BUFFER_LIMIT);
}

function nextNotificationEventId(notifications: TeamCoordinatorNotification[]): string {
  const last = notifications.at(-1);
  const lastEventId = last === undefined ? 0 : Number.parseInt(last.eventId, 10);
  return String((Number.isFinite(lastEventId) ? lastEventId : 0) + 1);
}

function replayNotifications(
  notifications: TeamCoordinatorNotification[],
  lastEventId: number | undefined,
): TeamCoordinatorNotification[] {
  if (lastEventId === undefined) {
    return notifications;
  }

  return notifications.filter((notification) => {
    const eventId = Number.parseInt(notification.eventId, 10);
    return Number.isFinite(eventId) && eventId > lastEventId;
  });
}

function selectDispatchWorker(
  registry: TeamCoordinatorWorkerRegistry,
  requiredCapabilities: readonly string[],
): TeamCoordinatorWorkerRecord | undefined {
  const candidates = Object.values(registry)
    .filter((worker) => isDispatchCandidate(worker, requiredCapabilities))
    .sort(compareDispatchWorkers);

  return candidates[0];
}

function isDispatchCandidate(
  worker: TeamCoordinatorWorkerRecord,
  requiredCapabilities: readonly string[],
): boolean {
  if (worker.status !== "idle" && !(worker.status === "busy" && worker.currentLoad < worker.maxConcurrency)) {
    return false;
  }

  const capabilities = new Set(worker.capabilities);
  return requiredCapabilities.every((capability) => capabilities.has(capability));
}

function exceedsActiveWorkerCap(
  registry: TeamCoordinatorWorkerRegistry,
  usageCaps: TeamCoordinatorUsageCaps,
): boolean {
  if (usageCaps.max_active_workers === undefined) {
    return false;
  }

  return Object.keys(registry).length >= usageCaps.max_active_workers;
}

function compareDispatchWorkers(a: TeamCoordinatorWorkerRecord, b: TeamCoordinatorWorkerRecord): number {
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

function workerKindRank(kind: TeamCoordinatorWorkerKind): number {
  return kind === "local" ? 0 : 1;
}

function incrementWorkerLoad(worker: TeamCoordinatorWorkerRecord): TeamCoordinatorWorkerRecord {
  const currentLoad = clampWorkerLoad(worker.currentLoad + 1, worker.maxConcurrency);
  return {
    ...worker,
    currentLoad,
    status: statusForWorkerLoad(currentLoad),
  };
}

function decrementWorkerLoad(worker: TeamCoordinatorWorkerRecord | undefined): TeamCoordinatorWorkerRecord | undefined {
  if (worker === undefined) {
    return undefined;
  }

  const currentLoad = clampWorkerLoad(worker.currentLoad - 1, worker.maxConcurrency);
  return {
    ...worker,
    currentLoad,
    status: statusForWorkerLoad(currentLoad),
  };
}

function dispatchFrameFromBody(
  body: Record<string, unknown>,
  workerId: string,
  runId: string,
  issueRef: string,
): TeamCoordinatorDispatchFrame {
  const branch = getStringField(body, "branch");
  const prompt = getStringField(body, "prompt");
  const configHash = getStringField(body, "configHash") ?? getStringField(body, "config_hash");
  const leaseSec = getPositiveIntegerField(body, "leaseSec") ?? getPositiveIntegerField(body, "lease_sec");
  const artifactUploadURLs = getObjectField(body, "artifactUploadURLs") ?? getObjectField(body, "artifact_upload_urls");

  return {
    type: "dispatch",
    protocol_version: PROTOCOL_VERSION,
    runId,
    issueRef,
    workerId,
    ...(branch === undefined ? {} : { branch }),
    ...(prompt === undefined ? {} : { prompt }),
    ...(configHash === undefined ? {} : { configHash }),
    ...(leaseSec === undefined ? {} : { leaseSec }),
    ...(artifactUploadURLs === undefined ? {} : { artifactUploadURLs }),
  };
}

function getDispatchRequiredCapabilities(body: Record<string, unknown>): string[] | undefined {
  for (const key of ["requiredCapabilities", "required_capabilities", "capabilities"]) {
    if (hasOwnField(body, key)) {
      return getStringArrayField(body, key);
    }
  }

  const requirements = getObjectField(body, "requirements");
  if (requirements === undefined) {
    return [];
  }
  if (!hasOwnField(requirements, "capabilities")) {
    return [];
  }

  return getStringArrayField(requirements, "capabilities");
}

function parseWaitMs(value: string | null): number {
  if (value === null || value.trim() === "") {
    return 0;
  }

  const trimmed = value.trim().toLowerCase();
  const match = /^(\d+)(ms|s)?$/u.exec(trimmed);
  if (match?.[1] === undefined) {
    return 0;
  }

  const amount = Number.parseInt(match[1], 10);
  if (!Number.isFinite(amount) || amount < 0) {
    return 0;
  }

  const waitMs = match[2] === "ms" ? amount : amount * 1000;
  return Math.min(waitMs, 25_000);
}

function hasOwnField(body: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key);
}

function getTeamId(request: Request): string | undefined {
  const header = request.headers.get("x-contrabass-team-id");
  if (header !== null && header.trim() !== "") {
    return header;
  }

  const url = new URL(request.url);
  const query = url.searchParams.get("teamId");
  if (query !== null && query.trim() !== "") {
    return query;
  }

  return undefined;
}

function getSubscriptionWorkerId(request: Request): string | undefined {
  const header = request.headers.get("x-contrabass-worker-id");
  if (header !== null && header.trim() !== "") {
    return header;
  }

  const url = new URL(request.url);
  const query = url.searchParams.get("workerId") ?? url.searchParams.get("worker_id");
  if (query !== null && query.trim() !== "") {
    return query;
  }

  return undefined;
}

function getLastEventId(request: Request): number | undefined {
  const raw = new URL(request.url).searchParams.get("last_event_id");
  if (raw === null || raw.trim() === "") {
    return undefined;
  }

  const eventId = Number.parseInt(raw, 10);
  return Number.isFinite(eventId) ? eventId : undefined;
}

function usageDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

async function readObjectBody(request: Request): Promise<Record<string, unknown> | undefined> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return undefined;
  }

  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }

  return body as Record<string, unknown>;
}

function getObjectField(body: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = body[key];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function getStringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function getNumberField(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function workerRecordFromRegistrationBody(
  body: Record<string, unknown>,
  now: number,
): TeamCoordinatorWorkerRecord | undefined {
  const workerId = getStringField(body, "workerId") ?? getStringField(body, "worker_id");
  const capabilities = getStringArrayField(body, "capabilities");
  const maxConcurrency = getPositiveIntegerField(body, "maxConcurrency")
    ?? getPositiveIntegerField(body, "max_concurrency");
  const kind = getWorkerKindField(body);
  const version = getStringField(body, "version");
  if (
    workerId === undefined
    || capabilities === undefined
    || maxConcurrency === undefined
    || kind === undefined
    || version === undefined
  ) {
    return undefined;
  }

  return {
    workerId,
    capabilities,
    maxConcurrency,
    currentLoad: 0,
    lastHeartbeatTs: now,
    kind,
    version,
    status: "idle",
  };
}

function normalizeWorkerRegistry(
  raw: Partial<TeamCoordinatorWorkerRegistry>,
  now: number,
): TeamCoordinatorWorkerRegistry {
  const registry: TeamCoordinatorWorkerRegistry = {};
  for (const [workerId, worker] of Object.entries(raw)) {
    const normalized = normalizeWorkerRecord(workerId, worker, now);
    if (normalized !== undefined) {
      registry[normalized.workerId] = normalized;
    }
  }
  return evaluateWorkerHealth(registry, now).registry;
}

function normalizeWorkerRecord(
  fallbackWorkerId: string,
  value: unknown,
  now: number,
): TeamCoordinatorWorkerRecord | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const workerId = getStringField(record, "workerId") ?? getStringField(record, "worker_id") ?? fallbackWorkerId;
  const capabilities = getStringArrayField(record, "capabilities") ?? [];
  const maxConcurrency = getPositiveIntegerField(record, "maxConcurrency")
    ?? getPositiveIntegerField(record, "max_concurrency")
    ?? DEFAULT_WORKER_MAX_CONCURRENCY;
  const currentLoad = clampWorkerLoad(
    getNumberField(record, "currentLoad") ?? getNumberField(record, "current_load") ?? 0,
    maxConcurrency,
  );
  const kind = getWorkerKindField(record) ?? "local";
  const version = getStringField(record, "version") ?? "unknown";
  const lastHeartbeatTs = getNumberField(record, "lastHeartbeatTs")
    ?? getNumberField(record, "last_heartbeat_ts")
    ?? now;

  return {
    workerId,
    capabilities,
    maxConcurrency,
    currentLoad,
    lastHeartbeatTs,
    kind,
    version,
    status: isWorkerUnhealthy(lastHeartbeatTs, now) ? "unhealthy" : statusForWorkerLoad(currentLoad),
  };
}

function evaluateWorkerHealth(
  registry: TeamCoordinatorWorkerRegistry,
  now: number,
): { registry: TeamCoordinatorWorkerRegistry; changed: boolean } {
  let changed = false;
  const evaluated: TeamCoordinatorWorkerRegistry = {};
  for (const [workerId, worker] of Object.entries(registry)) {
    const status = isWorkerUnhealthy(worker.lastHeartbeatTs, now)
      ? "unhealthy"
      : statusForWorkerLoad(worker.currentLoad);
    if (status !== worker.status) {
      changed = true;
    }
    evaluated[workerId] = {
      ...worker,
      status,
    };
  }
  return { registry: evaluated, changed };
}

function isWorkerUnhealthy(lastHeartbeatTs: number, now: number): boolean {
  return now - lastHeartbeatTs >= DEFAULT_REGISTRY_HEARTBEAT_INTERVAL_SEC * 3 * 1000;
}

function statusForWorkerLoad(currentLoad: number): TeamCoordinatorWorkerStatus {
  return currentLoad > 0 ? "busy" : "idle";
}

function clampWorkerLoad(value: number, maxConcurrency: number): number {
  return Math.max(0, Math.min(Math.trunc(value), maxConcurrency));
}

function getStringArrayField(body: Record<string, unknown>, key: string): string[] | undefined {
  const value = body[key];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    return undefined;
  }
  return value;
}

function getPositiveIntegerField(body: Record<string, unknown>, key: string): number | undefined {
  const value = getNumberField(body, key);
  if (value === undefined || !Number.isInteger(value) || value < 1) {
    return undefined;
  }
  return value;
}

function parseUsageCaps(body: Record<string, unknown>): TeamCoordinatorUsageCaps | undefined {
  const source = getObjectField(body, "usageCaps")
    ?? getObjectField(body, "usage_caps")
    ?? getObjectField(body, "config")
    ?? getObjectField(body, "limits")
    ?? getObjectField(body, "team")
    ?? body;
  return normalizeUsageCaps(source);
}

function normalizeUsageCaps(body: Record<string, unknown>): TeamCoordinatorUsageCaps | undefined {
  const caps: TeamCoordinatorUsageCaps = {};
  const maxActiveWorkers = getPositiveIntegerField(body, "max_active_workers")
    ?? getPositiveIntegerField(body, "maxActiveWorkers");
  const maxRunsPerDay = getPositiveIntegerField(body, "max_runs_per_day")
    ?? getPositiveIntegerField(body, "maxRunsPerDay");
  const maxEventsPerDay = getPositiveIntegerField(body, "max_events_per_day")
    ?? getPositiveIntegerField(body, "maxEventsPerDay");

  if (maxActiveWorkers !== undefined) {
    caps.max_active_workers = maxActiveWorkers;
  }
  if (maxRunsPerDay !== undefined) {
    caps.max_runs_per_day = maxRunsPerDay;
  }
  if (maxEventsPerDay !== undefined) {
    caps.max_events_per_day = maxEventsPerDay;
  }

  return Object.keys(caps).length === 0 ? undefined : caps;
}

function usageCapsFromHeaders(headers: Headers): TeamCoordinatorUsageCaps | undefined {
  const caps: TeamCoordinatorUsageCaps = {};
  const maxActiveWorkers = positiveIntegerHeader(headers, "x-contrabass-max-active-workers");
  const maxRunsPerDay = positiveIntegerHeader(headers, "x-contrabass-max-runs-per-day");
  const maxEventsPerDay = positiveIntegerHeader(headers, "x-contrabass-max-events-per-day");

  if (maxActiveWorkers !== undefined) {
    caps.max_active_workers = maxActiveWorkers;
  }
  if (maxRunsPerDay !== undefined) {
    caps.max_runs_per_day = maxRunsPerDay;
  }
  if (maxEventsPerDay !== undefined) {
    caps.max_events_per_day = maxEventsPerDay;
  }

  return Object.keys(caps).length === 0 ? undefined : caps;
}

function positiveIntegerHeader(headers: Headers, key: string): number | undefined {
  const value = headers.get(key);
  if (value === null || value.trim() === "") {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : undefined;
}

function getWorkerKindField(body: Record<string, unknown>): TeamCoordinatorWorkerKind | undefined {
  const kind = getStringField(body, "kind");
  if (kind === "local" || kind === "container") {
    return kind;
  }
  return undefined;
}

function webSocketResponse(client: WebSocket): Response {
  try {
    return new Response(null, { status: 101, webSocket: client });
  } catch (error) {
    if (error instanceof RangeError) {
      return new Response(null, { status: 200, webSocket: client });
    }
    throw error;
  }
}

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

function teamWorkerCapExceededResponse(maxActiveWorkers: number | undefined): Response {
  return jsonResponse({
    error: "team_worker_cap_exceeded",
    max_active_workers: maxActiveWorkers ?? 0,
    message: "team has reached the active worker limit",
    protocol_version: PROTOCOL_VERSION,
  }, 429);
}

function usageCapExceededResponse(error: string, capKey: string, cap: number): Response {
  return jsonResponse({
    error,
    [capKey]: cap,
    message: "team has reached the daily usage limit",
    protocol_version: PROTOCOL_VERSION,
  }, 429);
}

async function forwardErrorResponse(response: Response): Promise<Response> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = { error: "upstream_error" };
  }

  return Response.json(
    body === null || typeof body !== "object" || Array.isArray(body) ? { error: "upstream_error" } : body,
    { status: response.status },
  );
}
