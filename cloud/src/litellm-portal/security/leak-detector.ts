const SK_PATTERN = /\bsk-[A-Za-z0-9_-]{8,}/u;

export async function detectLeakInResponse(response: Response): Promise<Response> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return response;
  }

  let body: string;
  try {
    body = await response.text();
  } catch {
    return response;
  }

  if (SK_PATTERN.test(body)) {
    return new Response(
      JSON.stringify({ error: "response_blocked" }),
      {
        status: 500,
        headers: { "content-type": "application/json" },
      },
    );
  }

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
