import { afterEach, describe, expect, it } from "bun:test";
import {
  INITIAL_TEAM_SUBSCRIPTION_STATE,
  TeamSubscriptionClient,
  createTeamSubscriptionUrl,
  nextLastEventId,
  teamSubscriptionReducer,
  type DashboardSubscriptionFrame,
  type TeamSubscriptionStatus,
} from "./useTeamSubscription";

class MockSocket {
  static instances: MockSocket[] = [];

  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    MockSocket.instances.push(this);
  }

  send(): void {}

  close(): void {
    this.closed = true;
  }

  open(): void {
    this.onopen?.(new Event("open"));
  }

  message(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent);
  }

  closeFromServer(): void {
    this.onclose?.(new CloseEvent("close"));
  }
}

class TimerHarness {
  private nextId = 1;
  private readonly timers = new Map<
    number,
    { handler: () => void; timeout: number }
  >();

  setTimeout = (
    handler: () => void,
    timeout: number,
  ): ReturnType<typeof setTimeout> => {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { handler, timeout });
    return id as unknown as ReturnType<typeof setTimeout>;
  };

  clearTimeout = (handle: ReturnType<typeof setTimeout>): void => {
    this.timers.delete(Number(handle));
  };

  runNext(): void {
    const next = [...this.timers.entries()].sort(
      (left, right) => left[1].timeout - right[1].timeout,
    )[0];
    if (!next) {
      throw new Error("expected a pending timer");
    }

    const [id, timer] = next;
    this.timers.delete(id);
    timer.handler();
  }

  runTimeout(timeout: number): void {
    const next = [...this.timers.entries()].find(
      ([, timer]) => timer.timeout === timeout,
    );
    if (!next) {
      throw new Error(`expected a pending ${timeout}ms timer`);
    }

    const [id, timer] = next;
    this.timers.delete(id);
    timer.handler();
  }

  get pendingCount(): number {
    return this.timers.size;
  }

  get pendingTimeouts(): number[] {
    return [...this.timers.values()]
      .map((timer) => timer.timeout)
      .sort((left, right) => left - right);
  }
}

function makeClient(
  timers: TimerHarness,
  frames: DashboardSubscriptionFrame[],
  statuses: TeamSubscriptionStatus[],
) {
  return new TeamSubscriptionClient({
    createWebSocket: (url) => new MockSocket(url),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    onFrame: (frame) => frames.push(frame),
    onStatus: (status) => statuses.push(status),
  });
}

describe("team dashboard WebSocket subscription", () => {
  it("builds WebSocket URLs with encoded team and last_event_id replay cursor", () => {
    expect(createTeamSubscriptionUrl("team 1", "42")).toBe(
      "ws://localhost/v1/teams/team%201/subscribe?last_event_id=42",
    );
  });

  it("stores the latest non-empty event id from dashboard frames", () => {
    expect(nextLastEventId(null, "10")).toBe("10");
    expect(nextLastEventId("10", "9")).toBe("9");
    expect(nextLastEventId("10", "evt-001")).toBe("evt-001");
    expect(nextLastEventId("evt-001", "  evt-002  ")).toBe("evt-002");
    expect(nextLastEventId("evt-001", "")).toBe("evt-001");
    expect(nextLastEventId("evt-001", "   ")).toBe("evt-001");
  });

  it("reduces received frames and keeps the replay cursor", () => {
    const frame: DashboardSubscriptionFrame = {
      type: "run-event",
      protocol_version: "1.0.0",
      event_id: "7",
      payload: { runId: "run-1" },
    };

    const next = teamSubscriptionReducer(INITIAL_TEAM_SUBSCRIPTION_STATE, {
      type: "frame",
      frame,
    });

    expect(next.latestFrame).toEqual(frame);
    expect(next.frames).toEqual([frame]);
    expect(next.lastEventId).toBe("7");
  });

  it("reconnects with last_event_id after a disconnect", () => {
    const timers = new TimerHarness();
    const frames: DashboardSubscriptionFrame[] = [];
    const statuses: TeamSubscriptionStatus[] = [];
    const client = makeClient(timers, frames, statuses);

    client.start("team-1");
    MockSocket.instances[0]?.open();
    MockSocket.instances[0]?.message({
      type: "run-event",
      event_id: "evt-005",
      payload: { runId: "run-5" },
    });
    MockSocket.instances[0]?.closeFromServer();

    expect(timers.pendingCount).toBe(2);
    timers.runNext();

    expect(MockSocket.instances[1]?.url).toBe(
      "ws://localhost/v1/teams/team-1/subscribe?last_event_id=evt-005",
    );
    expect(frames).toEqual([
      { type: "run-event", event_id: "evt-005", payload: { runId: "run-5" } },
    ]);
  });

  it("keeps replay cursor through a missed-event replay after reconnect", () => {
    const timers = new TimerHarness();
    const frames: DashboardSubscriptionFrame[] = [];
    const statuses: TeamSubscriptionStatus[] = [];
    const client = makeClient(timers, frames, statuses);

    client.start("team-1");
    MockSocket.instances[0]?.open();
    MockSocket.instances[0]?.message({
      type: "board-update",
      event_id: "evt-010",
      board: { open: [], claimed: [], running: [], done: [] },
    });
    MockSocket.instances[0]?.closeFromServer();
    timers.runNext();
    MockSocket.instances[1]?.open();
    MockSocket.instances[1]?.message({
      type: "worker-status",
      event_id: "evt-011",
      worker: { workerId: "local-1", status: "idle" },
    });

    expect(MockSocket.instances[1]?.url).toBe(
      "ws://localhost/v1/teams/team-1/subscribe?last_event_id=evt-010",
    );
    expect(statuses[statuses.length - 1]).toMatchObject({
      connected: true,
      reconnecting: false,
      lastEventId: "evt-011",
    });
    expect(frames.map((frame) => frame.event_id)).toEqual([
      "evt-010",
      "evt-011",
    ]);
  });

  it("uses exponential reconnect backoff while preserving the 5 second indicator timer", () => {
    const timers = new TimerHarness();
    const frames: DashboardSubscriptionFrame[] = [];
    const statuses: TeamSubscriptionStatus[] = [];
    const client = makeClient(timers, frames, statuses);

    client.start("team-1");
    MockSocket.instances[0]?.open();
    MockSocket.instances[0]?.closeFromServer();

    expect(timers.pendingTimeouts).toEqual([1_000, 5_000]);
    timers.runNext();
    MockSocket.instances[1]?.closeFromServer();

    expect(timers.pendingTimeouts).toEqual([2_000, 5_000]);
  });

  it("caps reconnect backoff at 30 seconds", () => {
    const timers = new TimerHarness();
    const frames: DashboardSubscriptionFrame[] = [];
    const statuses: TeamSubscriptionStatus[] = [];
    const client = makeClient(timers, frames, statuses);

    client.start("team-1");
    MockSocket.instances[0]?.open();
    MockSocket.instances[0]?.closeFromServer();

    for (const delayMs of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
      const attempt = MockSocket.instances.length;
      timers.runTimeout(delayMs);
      MockSocket.instances[attempt]?.closeFromServer();
    }

    expect(timers.pendingTimeouts).toEqual([5_000, 30_000]);
  });

  it("surfaces parse and unknown-frame errors without advancing the cursor", () => {
    const timers = new TimerHarness();
    const frames: DashboardSubscriptionFrame[] = [];
    const statuses: TeamSubscriptionStatus[] = [];
    const client = makeClient(timers, frames, statuses);

    client.start("team-1");
    MockSocket.instances[0]?.open();
    MockSocket.instances[0]?.message({
      type: "run-event",
      event_id: "evt-020",
      payload: { runId: "run-20" },
    });
    MockSocket.instances[0]?.onmessage?.({ data: "not json" } as MessageEvent);
    MockSocket.instances[0]?.message({
      type: "unknown",
      event_id: "evt-021",
    });

    expect(frames).toHaveLength(1);
    expect(statuses.slice(-2)).toEqual([
      {
        connected: true,
        reconnecting: false,
        error: "Could not parse dashboard update frame",
        lastEventId: "evt-020",
      },
      {
        connected: true,
        reconnecting: false,
        error: "Received an unknown dashboard update frame",
        lastEventId: "evt-020",
      },
    ]);
  });

  it("reports reconnecting only after the 5 second down indicator timer fires", () => {
    const timers = new TimerHarness();
    const frames: DashboardSubscriptionFrame[] = [];
    const statuses: TeamSubscriptionStatus[] = [];
    const client = makeClient(timers, frames, statuses);

    client.start("team-1");
    MockSocket.instances[0]?.open();
    MockSocket.instances[0]?.closeFromServer();

    expect(statuses[statuses.length - 1]?.reconnecting).toBe(false);
    timers.runNext();
    timers.runNext();

    expect(statuses[statuses.length - 1]).toMatchObject({
      connected: false,
      reconnecting: true,
    });
  });

  it("closes the old socket and resets replay cursor when teams switch", () => {
    const timers = new TimerHarness();
    const frames: DashboardSubscriptionFrame[] = [];
    const statuses: TeamSubscriptionStatus[] = [];
    const client = makeClient(timers, frames, statuses);

    client.start("team-1");
    MockSocket.instances[0]?.open();
    MockSocket.instances[0]?.message({
      type: "config-changed",
      event_id: "9",
      activeContentHash: "cfg-9",
    });
    client.start("team-2");

    expect(MockSocket.instances[0]?.closed).toBe(true);
    expect(MockSocket.instances[1]?.url).toBe(
      "ws://localhost/v1/teams/team-2/subscribe",
    );
  });
});

afterEach(() => {
  MockSocket.instances = [];
});
