const WINDOW_MS = 60_000;
const MAX_REQUESTS = 60;

export class RateLimitDO {
  private readonly state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const key = url.searchParams.get("key") ?? "unknown";
    const now = Date.now();
    const windowStart = now - WINDOW_MS;

    const stored = await this.state.storage.get<number[]>(key) ?? [];
    const recent = stored.filter((ts) => ts > windowStart);

    if (recent.length >= MAX_REQUESTS) {
      const oldest = recent[0] ?? now;
      const retryAfter = Math.ceil((oldest + WINDOW_MS - now) / 1000);
      return new Response(
        JSON.stringify({ error: "rate_limit_exceeded" }),
        {
          status: 429,
          headers: {
            "content-type": "application/json",
            "retry-after": String(Math.max(1, retryAfter)),
          },
        },
      );
    }

    recent.push(now);
    await this.state.storage.put(key, recent);

    return new Response(JSON.stringify({ ok: true, remaining: MAX_REQUESTS - recent.length }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
}
