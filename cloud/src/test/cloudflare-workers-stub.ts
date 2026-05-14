/** Minimal stub for `cloudflare:workers` so vitest can load DO modules without the CF runtime. */
export class DurableObject {
  ctx: unknown;
  env: unknown;
  constructor(ctx: unknown, env: unknown) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class WorkerEntrypoint {}
export class DurableObjectStub {}
