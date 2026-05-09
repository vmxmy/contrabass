export type TeamCoordinatorRecord = {
  teamId?: string;
  createdAt: number;
  updatedAt: number;
  paused: boolean;
};

export type TeamCoordinatorBoardPhase = "open" | "claimed" | "running" | "done";

export type TeamCoordinatorBoardEntry = {
  issueRef: string;
  runId?: string;
  assignedWorkerId?: string;
  phase: TeamCoordinatorBoardPhase;
  lastUpdated: number;
};

export type TeamCoordinatorBoard = Record<TeamCoordinatorBoardPhase, TeamCoordinatorBoardEntry[]>;

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
  type: "run-event" | "run-complete" | "lease-revoked" | "no-worker-available";
  receivedAt: number;
  payload: Record<string, unknown>;
};

export type TeamCoordinatorStorage = {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
};

type TeamCoordinatorDurableState = {
  storage: TeamCoordinatorStorage;
};

type WebSocketPairConstructor = new () => {
  0: WebSocket;
  1: WebSocket;
};

const TEAM_RECORD_KEY = "team-coordinator:record";
const BOARD_KEY = "team-coordinator:board";
const NOTIFICATIONS_KEY = "team-coordinator:notifications";
const WORKER_REGISTRY_KEY = "team-coordinator:worker-registry";
const INTERNAL_NOTIFICATION_PATHS = new Set(["/run-event", "/run-complete", "/lease-revoked"]);
const BOARD_PHASES: TeamCoordinatorBoardPhase[] = ["open", "claimed", "running", "done"];
const PROTOCOL_VERSION = "1.0.0";
const DEFAULT_WORKER_MAX_CONCURRENCY = 1;
const DEFAULT_REGISTRY_HEARTBEAT_INTERVAL_SEC = 30;

export class TeamCoordinator {
  private readonly subscribers = new Set<WebSocket>();
  private readonly workerDispatchSubscribers = new Map<string, Set<WebSocket>>();
  private workerRegistry: TeamCoordinatorWorkerRegistry | undefined;

  constructor(private readonly state: TeamCoordinatorDurableState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/state")) {
      const record = await this.ensureRecord(request);
      return jsonResponse({ team: record });
    }

    if (request.method === "GET" && url.pathname === "/board") {
      return jsonResponse({ board: await this.ensureBoard() });
    }

    if (request.method === "GET" && url.pathname === "/workers") {
      return jsonResponse({ registry: await this.ensureWorkerRegistry() });
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
      [worker.workerId]: worker,
    };
    await this.persistWorkerRegistry(registry);
    await this.touchRecord(request);
    this.broadcast(workerStatusFrame(worker));

    return jsonResponse({ worker, registry });
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

    const registry = await this.ensureWorkerRegistry();
    const selectedWorker = selectDispatchWorker(registry, requiredCapabilities);
    if (selectedWorker === undefined) {
      const event = await this.emitNoWorkerAvailable(request, body, requiredCapabilities);
      return jsonResponse({ dispatched: false, event }, 202);
    }

    const worker = incrementWorkerLoad(selectedWorker);
    const updatedRegistry = {
      ...registry,
      [worker.workerId]: worker,
    };
    await this.persistWorkerRegistry(updatedRegistry);

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
    this.sendToWorker(worker.workerId, dispatch);

    return jsonResponse({ dispatched: true, worker, dispatch, board });
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

    const board = isFullBoardRefreshBody(body) ? refreshedBoard : mergeBoard(await this.ensureBoard(), refreshedBoard);
    await this.state.storage.put(BOARD_KEY, board);
    await this.touchRecord(request);
    this.broadcast(boardUpdateFrame(board));

    return jsonResponse({ board });
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
    server.accept();
    const workerId = getSubscriptionWorkerId(request);
    if (workerId !== undefined) {
      this.addWorkerDispatchSubscriber(workerId, server);
    } else {
      this.subscribers.add(server);
      const removeSubscriber = () => {
        this.subscribers.delete(server);
      };
      server.addEventListener("close", removeSubscriber);
      server.addEventListener("error", removeSubscriber);

      server.send(JSON.stringify(boardUpdateFrame(await this.ensureBoard())));
      const notifications = await this.state.storage.get<TeamCoordinatorNotification[]>(NOTIFICATIONS_KEY);
      for (const notification of notifications ?? []) {
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
    const notification: TeamCoordinatorNotification = {
      type: notificationTypeForPath(pathname),
      receivedAt: now,
      payload: body,
    };
    const notifications = await this.state.storage.get<TeamCoordinatorNotification[]>(NOTIFICATIONS_KEY);

    await this.state.storage.put(NOTIFICATIONS_KEY, [...(notifications ?? []), notification]);
    await this.state.storage.put(TEAM_RECORD_KEY, {
      ...record,
      updatedAt: now,
    });
    this.broadcast(notificationFrame(notification));

    return jsonResponse({ accepted: true, type: notification.type });
  }

  private async emitNoWorkerAvailable(
    request: Request,
    payload: Record<string, unknown>,
    requiredCapabilities: string[],
  ): Promise<TeamCoordinatorNotification> {
    const record = await this.ensureRecord(request);
    const now = Date.now();
    const notification: TeamCoordinatorNotification = {
      type: "no-worker-available",
      receivedAt: now,
      payload: {
        ...payload,
        requiredCapabilities,
      },
    };
    const notifications = await this.state.storage.get<TeamCoordinatorNotification[]>(NOTIFICATIONS_KEY);

    await this.state.storage.put(NOTIFICATIONS_KEY, [...(notifications ?? []), notification]);
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

  private broadcast(frame: Record<string, unknown>): void {
    const message = JSON.stringify(frame);
    for (const subscriber of this.subscribers) {
      try {
        subscriber.send(message);
      } catch {
        this.subscribers.delete(subscriber);
      }
    }
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
}

function notificationTypeForPath(pathname: string): TeamCoordinatorNotification["type"] {
  if (pathname === "/run-complete") {
    return "run-complete";
  }
  if (pathname === "/lease-revoked") {
    return "lease-revoked";
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

function mergeBoard(existing: TeamCoordinatorBoard, updates: TeamCoordinatorBoard): TeamCoordinatorBoard {
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

  const phase = phaseFromUnknown(entry.phase) ?? defaultPhase ?? "open";
  const runId = getStringField(entry, "runId") ?? getStringField(entry, "run_id");
  const assignedWorkerId = getStringField(entry, "assignedWorkerId")
    ?? getStringField(entry, "assigned_worker_id")
    ?? getStringField(entry, "workerId")
    ?? getStringField(entry, "worker_id");

  return {
    issueRef,
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
      receivedAt: notification.receivedAt,
    };
  }

  return {
    type: notification.type,
    protocol_version: PROTOCOL_VERSION,
    receivedAt: notification.receivedAt,
    payload: notification.payload,
  };
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
  const direct = getStringArrayField(body, "requiredCapabilities")
    ?? getStringArrayField(body, "required_capabilities")
    ?? getStringArrayField(body, "capabilities");
  if (direct !== undefined) {
    return direct;
  }

  const requirements = getObjectField(body, "requirements");
  if (requirements === undefined) {
    return [];
  }

  return getStringArrayField(requirements, "capabilities");
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
