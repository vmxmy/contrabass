import { useEffect, useReducer, useRef } from "react";
import { apiUrl } from "../lib/api";

const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const RECONNECTING_INDICATOR_DELAY_MS = 5_000;
const MAX_STORED_FRAMES = 500;

export type DashboardSubscriptionFrameType =
  | "board-update"
  | "run-event"
  | "worker-status"
  | "config-changed";

export interface DashboardSubscriptionFrame {
  type: DashboardSubscriptionFrameType;
  protocol_version?: string;
  event_id?: string;
  receivedAt?: number;
  [key: string]: unknown;
}

export interface TeamSubscriptionStatus {
  connected: boolean;
  reconnecting: boolean;
  error: string | null;
  lastEventId: string | null;
}

export interface TeamSubscriptionState extends TeamSubscriptionStatus {
  frames: DashboardSubscriptionFrame[];
  latestFrame: DashboardSubscriptionFrame | null;
}

export interface TeamSubscriptionClientOptions {
  onFrame: (frame: DashboardSubscriptionFrame) => void;
  onStatus: (status: TeamSubscriptionStatus) => void;
  createWebSocket?: (url: string) => WebSocketLike;
  setTimeout?: (handler: () => void, timeout: number) => TimeoutHandle;
  clearTimeout?: (handle: TimeoutHandle) => void;
}

type TimeoutHandle = ReturnType<typeof setTimeout>;

type WebSocketLike = Pick<WebSocket, "close" | "send"> & {
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
};

type TeamSubscriptionAction =
  | { type: "status"; status: TeamSubscriptionStatus }
  | { type: "frame"; frame: DashboardSubscriptionFrame }
  | { type: "reset" };

export const INITIAL_TEAM_SUBSCRIPTION_STATE: TeamSubscriptionState = {
  connected: false,
  reconnecting: false,
  error: null,
  lastEventId: null,
  frames: [],
  latestFrame: null,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isDashboardSubscriptionFrame(
  value: unknown,
): value is DashboardSubscriptionFrame {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.type === "board-update" ||
    value.type === "run-event" ||
    value.type === "worker-status" ||
    value.type === "config-changed"
  );
}

export function nextLastEventId(
  current: string | null,
  incoming: string | undefined,
): string | null {
  const next = incoming?.trim();
  return next ? next : current;
}

function browserUrlBase(): string {
  return window.location.protocol === "http:" ||
    window.location.protocol === "https:"
    ? window.location.href
    : "http://localhost/";
}

export function createTeamSubscriptionUrl(
  teamId: string,
  lastEventId?: string | null,
): string {
  const encodedTeamId = encodeURIComponent(teamId);
  const requestUrl = new URL(
    apiUrl(`/v1/teams/${encodedTeamId}/subscribe`),
    browserUrlBase(),
  );

  if (lastEventId) {
    requestUrl.searchParams.set("last_event_id", lastEventId);
  }

  requestUrl.protocol = requestUrl.protocol === "https:" ? "wss:" : "ws:";
  return requestUrl.toString();
}

export function teamSubscriptionReducer(
  state: TeamSubscriptionState,
  action: TeamSubscriptionAction,
): TeamSubscriptionState {
  switch (action.type) {
    case "status":
      return { ...state, ...action.status };
    case "frame": {
      const frames = [...state.frames, action.frame];
      if (frames.length > MAX_STORED_FRAMES) {
        frames.splice(0, frames.length - MAX_STORED_FRAMES);
      }

      return {
        ...state,
        frames,
        latestFrame: action.frame,
        lastEventId: nextLastEventId(state.lastEventId, action.frame.event_id),
      };
    }
    case "reset":
      return INITIAL_TEAM_SUBSCRIPTION_STATE;
    default:
      return state;
  }
}

export class TeamSubscriptionClient {
  private readonly onFrame: (frame: DashboardSubscriptionFrame) => void;
  private readonly onStatus: (status: TeamSubscriptionStatus) => void;
  private readonly createSocket: (url: string) => WebSocketLike;
  private readonly setTimer: (
    handler: () => void,
    timeout: number,
  ) => TimeoutHandle;
  private readonly clearTimer: (handle: TimeoutHandle) => void;
  private teamId: string | null = null;
  private socket: WebSocketLike | null = null;
  private reconnectTimer: TimeoutHandle | null = null;
  private reconnectingTimer: TimeoutHandle | null = null;
  private reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
  private stopped = true;
  private lastEventId: string | null = null;

  constructor(options: TeamSubscriptionClientOptions) {
    this.onFrame = options.onFrame;
    this.onStatus = options.onStatus;
    this.createSocket =
      options.createWebSocket ?? ((url) => new WebSocket(url));
    this.setTimer = options.setTimeout ?? window.setTimeout.bind(window);
    this.clearTimer = options.clearTimeout ?? window.clearTimeout.bind(window);
  }

  start(teamId: string): void {
    this.stop();
    this.teamId = teamId;
    this.stopped = false;
    this.lastEventId = null;
    this.reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.teamId = null;
    this.clearReconnectTimer();
    this.clearReconnectingTimer();
    this.socket?.close();
    this.socket = null;
    this.onStatus({
      connected: false,
      reconnecting: false,
      error: null,
      lastEventId: this.lastEventId,
    });
  }

  private connect(): void {
    if (this.teamId === null || this.stopped) {
      return;
    }

    const socket = this.createSocket(
      createTeamSubscriptionUrl(this.teamId, this.lastEventId),
    );
    this.socket = socket;

    socket.onopen = () => {
      if (this.socket !== socket || this.stopped) {
        return;
      }

      this.reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
      this.clearReconnectTimer();
      this.clearReconnectingTimer();
      this.onStatus({
        connected: true,
        reconnecting: false,
        error: null,
        lastEventId: this.lastEventId,
      });
    };

    socket.onmessage = (event) => {
      if (this.socket !== socket || this.stopped) {
        return;
      }

      try {
        const payload = JSON.parse(String(event.data)) as unknown;
        if (!isDashboardSubscriptionFrame(payload)) {
          this.onStatus({
            connected: true,
            reconnecting: false,
            error: "Received an unknown dashboard update frame",
            lastEventId: this.lastEventId,
          });
          return;
        }

        this.lastEventId = nextLastEventId(this.lastEventId, payload.event_id);
        this.onFrame(payload);
        this.onStatus({
          connected: true,
          reconnecting: false,
          error: null,
          lastEventId: this.lastEventId,
        });
      } catch {
        this.onStatus({
          connected: true,
          reconnecting: false,
          error: "Could not parse dashboard update frame",
          lastEventId: this.lastEventId,
        });
      }
    };

    socket.onerror = () => {
      this.handleDisconnect(socket, "Dashboard subscription failed");
    };

    socket.onclose = () => {
      this.handleDisconnect(socket, null);
    };
  }

  private handleDisconnect(socket: WebSocketLike, error: string | null): void {
    if (this.socket !== socket || this.stopped) {
      return;
    }

    this.onStatus({
      connected: false,
      reconnecting: false,
      error,
      lastEventId: this.lastEventId,
    });
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null || this.teamId === null || this.stopped) {
      return;
    }

    if (this.reconnectingTimer === null) {
      this.reconnectingTimer = this.setTimer(() => {
        this.reconnectingTimer = null;
        this.onStatus({
          connected: false,
          reconnecting: true,
          error: null,
          lastEventId: this.lastEventId,
        });
      }, RECONNECTING_INDICATOR_DELAY_MS);
    }

    const delayMs = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(
      this.reconnectDelayMs * 2,
      MAX_RECONNECT_DELAY_MS,
    );
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      this.clearTimer(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearReconnectingTimer(): void {
    if (this.reconnectingTimer !== null) {
      this.clearTimer(this.reconnectingTimer);
      this.reconnectingTimer = null;
    }
  }
}

export function useTeamSubscription(
  teamId: string | null | undefined,
): TeamSubscriptionState {
  const [state, dispatch] = useReducer(
    teamSubscriptionReducer,
    INITIAL_TEAM_SUBSCRIPTION_STATE,
  );
  const clientRef = useRef<TeamSubscriptionClient | null>(null);

  useEffect(() => {
    clientRef.current ??= new TeamSubscriptionClient({
      onFrame: (frame) => dispatch({ type: "frame", frame }),
      onStatus: (status) => dispatch({ type: "status", status }),
    });

    if (!teamId) {
      clientRef.current.stop();
      dispatch({ type: "reset" });
      return undefined;
    }

    dispatch({ type: "reset" });
    clientRef.current.start(teamId);

    return () => {
      clientRef.current?.stop();
    };
  }, [teamId]);

  return state;
}
