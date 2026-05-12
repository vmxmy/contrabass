import type { Context } from "hono";
import type { LiteLLMPortalEnv, PortalIdentity } from "../types";

type HonoEnv = { Bindings: LiteLLMPortalEnv; Variables: { identity: PortalIdentity } };

export async function applyAdminRateLimit(
  c: Context<HonoEnv>,
  next: () => Promise<void>,
): Promise<Response | void> {
  const rateLimitDO = c.env.RATE_LIMIT_DO;
  if (rateLimitDO === undefined) {
    await next();
    return;
  }

  const identity = c.get("identity");
  const clientIp = c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for") ?? "unknown";
  const key = `${identity.email}:${clientIp}`;

  const doId = rateLimitDO.idFromName("admin-rate-limit");
  const stub = rateLimitDO.get(doId);

  const checkUrl = `https://rate-limit-do/check?key=${encodeURIComponent(key)}`;
  const doResponse = await stub.fetch(new Request(checkUrl));

  if (doResponse.status === 429) {
    const retryAfter = doResponse.headers.get("retry-after") ?? "60";
    return new Response(
      JSON.stringify({ error: "rate_limit_exceeded" }),
      {
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": retryAfter,
        },
      },
    );
  }

  await next();
}
