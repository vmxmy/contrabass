const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_REQUESTS = 60;

export class RateLimitDO {
  private readonly state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const key = url.searchParams.get("key") ?? "unknown";
    const windowMs = Number(url.searchParams.get("windowMs") ?? DEFAULT_WINDOW_MS);
    const maxRequests = Number(url.searchParams.get("max") ?? DEFAULT_MAX_REQUESTS);
    const now = Date.now();
    const windowStart = now - windowMs;

    const stored = await this.state.storage.get<number[]>(key) ?? [];
    const recent = stored.filter((ts) => ts > windowStart);

    if (recent.length >= maxRequests) {
      const oldest = recent[0] ?? now;
      const retryAfter = Math.ceil((oldest + windowMs - now) / 1000);
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

    return new Response(JSON.stringify({ ok: true, remaining: maxRequests - recent.length }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
}
