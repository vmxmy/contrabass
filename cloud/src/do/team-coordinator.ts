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

export type TeamCoordinatorNotification = {
  type: "run-event" | "run-complete" | "lease-revoked";
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
const INTERNAL_NOTIFICATION_PATHS = new Set(["/run-event", "/run-complete", "/lease-revoked"]);
const BOARD_PHASES: TeamCoordinatorBoardPhase[] = ["open", "claimed", "running", "done"];
const PROTOCOL_VERSION = "1.0.0";

export class TeamCoordinator {
  private readonly subscribers = new Set<WebSocket>();

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
