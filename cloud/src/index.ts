export interface Env {}

export function handleRequest(): Response {
  return Response.json(
    {
      service: "contrabass-cloud",
      status: "not_configured",
    },
    { status: 503 },
  );
}

const worker: ExportedHandler<Env> = {
  fetch() {
    return handleRequest();
  },
};

export default worker;
