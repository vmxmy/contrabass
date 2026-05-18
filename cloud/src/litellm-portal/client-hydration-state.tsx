import type { Dashboard } from "./schemas";
import type { UserPreferences } from "./schemas";
import type { JsonValue } from "./types";

export type PortalRole = "admin" | "user" | "none";

export type ClientHydrationState = {
  title: string;
  nonce: string;
  initialData: Dashboard | null;
  shellInitialData: JsonValue | null;
  dehydratedState: unknown;
  role: PortalRole | undefined;
  initialTheme: UserPreferences["theme"];
};

const PREFERENCES_QUERY_KEY = ["me", "preferences"] as const;

export function readClientHydrationState(doc: Document): ClientHydrationState {
  let initialData: Dashboard | null = null;
  let shellInitialData: JsonValue | null = null;
  let dehydratedState: unknown = undefined;

  const dataEl = doc.getElementById("initial-data");
  if (dataEl?.textContent) {
    try {
      const parsed = JSON.parse(dataEl.textContent) as Dashboard & { queryClient?: unknown };
      shellInitialData = parsed as JsonValue;
      dehydratedState = parsed.queryClient;
      const { queryClient: _queryClient, ...rest } = parsed;
      void _queryClient;
      initialData = rest as Dashboard;
    } catch {
      // Malformed JSON — hydrate without preloaded data.
    }
  }

  const roleRaw = initialData?.role;
  const role: PortalRole | undefined =
    roleRaw === "admin" || roleRaw === "user" || roleRaw === "none" ? roleRaw : undefined;

  return {
    title: doc.title,
    nonce: readNonce(doc),
    initialData,
    shellInitialData,
    dehydratedState,
    role,
    initialTheme: readInitialTheme(dehydratedState),
  };
}

function readNonce(doc: Document): string {
  const script = doc.head.querySelector("script[nonce]") as HTMLScriptElement | null;
  return script?.nonce || script?.getAttribute("nonce") || "";
}

function readInitialTheme(dehydratedState: unknown): UserPreferences["theme"] {
  const theme = readPreferencesTheme(dehydratedState);
  return theme ?? "auto";
}

function readPreferencesTheme(dehydratedState: unknown): UserPreferences["theme"] | undefined {
  if (!isRecord(dehydratedState) || !Array.isArray(dehydratedState.queries)) return undefined;

  for (const query of dehydratedState.queries) {
    if (!isRecord(query) || !queryKeyEquals(query.queryKey, PREFERENCES_QUERY_KEY)) continue;
    const state = query.state;
    if (!isRecord(state)) return undefined;
    const data = state.data;
    if (!isRecord(data)) return undefined;
    const theme = data.theme;
    return theme === "auto" || theme === "dark" || theme === "light" ? theme : undefined;
  }

  return undefined;
}

function queryKeyEquals(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) &&
    value.length === expected.length &&
    value.every((item, index) => item === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
