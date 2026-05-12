import type { JsonValue, LiteLLMPortalEnv, PortalIdentity } from "./types";

interface ServerImpl {
  renderPortalSSR(
    env: LiteLLMPortalEnv,
    identity: PortalIdentity,
    initialData: JsonValue | null,
    nonce: string,
    requestUrl?: string,
  ): Promise<string>;
}

const implPath = "./server-impl";

async function loadImpl(): Promise<ServerImpl> {
  return import(implPath) as Promise<ServerImpl>;
}

export async function renderPortalSSR(
  env: LiteLLMPortalEnv,
  identity: PortalIdentity,
  initialData: JsonValue | null,
  nonce: string,
  requestUrl?: string,
): Promise<string> {
  const impl = await loadImpl();
  return impl.renderPortalSSR(env, identity, initialData, nonce, requestUrl);
}
