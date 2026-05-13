import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { UserPreferencesPatchSchema, UserPreferencesSchema, type UserPreferences, type UserPreferencesPatch } from "../schemas";

export const PREFERENCES_QUERY_KEY = ["me", "preferences"] as const;
export const PREFERENCES_CACHE_KEY = "litellm-portal-preferences-cache";
export const LEGACY_THEME_KEY = "litellm-portal-mode";

export function usePreferences() {
  return useQuery({
    queryKey: PREFERENCES_QUERY_KEY,
    queryFn: async () => {
      const res = await fetch("/api/me/preferences", { headers: { "content-type": "application/json" } });
      const json = await res.json().catch(() => ({})) as unknown;
      if (!res.ok) {
        const message = extractError(json, "preferences_request_failed");
        throw new Error(message);
      }
      const parsed = UserPreferencesSchema.parse(json);
      writeCachedPreferences(parsed);
      return parsed;
    },
    initialData: readCachedPreferences,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}

export function useUpdatePreferences() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (patch: UserPreferencesPatch): Promise<UserPreferences> => {
      const parsedPatch = UserPreferencesPatchSchema.parse(patch);
      const res = await fetch("/api/me/preferences", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(parsedPatch),
      });
      const json = await res.json().catch(() => ({})) as unknown;
      if (!res.ok) {
        throw new Error(extractError(json, "preferences_update_failed"));
      }
      return UserPreferencesSchema.parse(json);
    },
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: PREFERENCES_QUERY_KEY });
      const previous = queryClient.getQueryData<UserPreferences>(PREFERENCES_QUERY_KEY);
      const optimistic = mergePreferencePatch(previous ?? UserPreferencesSchema.parse({}), patch);
      queryClient.setQueryData<UserPreferences>(PREFERENCES_QUERY_KEY, optimistic);
      writeCachedPreferences(optimistic);
      return { previous };
    },
    onError: (_err, _patch, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData<UserPreferences>(PREFERENCES_QUERY_KEY, context.previous);
        writeCachedPreferences(context.previous);
      }
    },
    onSuccess: (next) => {
      queryClient.setQueryData<UserPreferences>(PREFERENCES_QUERY_KEY, next);
      writeCachedPreferences(next);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: PREFERENCES_QUERY_KEY });
    },
  });
}

export function useLegacyThemeMigration() {
  const updatePreferences = useUpdatePreferences();

  useEffect(() => {
    if (typeof window === "undefined") return;
    let legacy: string | null = null;
    try {
      legacy = window.localStorage.getItem(LEGACY_THEME_KEY);
    } catch {
      return;
    }
    if (legacy !== "dark" && legacy !== "light") return;

    updatePreferences.mutate({ theme: legacy }, {
      onSuccess: () => {
        try {
          window.localStorage.removeItem(LEGACY_THEME_KEY);
        } catch {
          // ignore unavailable storage
        }
      },
    });
  }, []);
}

export function applyThemePreference(theme: UserPreferences["theme"]): void {
  if (typeof document === "undefined") return;
  const resolved = theme === "auto" ? systemTheme() : theme;
  document.documentElement.dataset.mode = resolved;
}

export function readCachedPreferences(): UserPreferences | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = window.localStorage.getItem(PREFERENCES_CACHE_KEY);
    if (raw === null) return undefined;
    return UserPreferencesSchema.parse(JSON.parse(raw) as unknown);
  } catch {
    return undefined;
  }
}

function writeCachedPreferences(preferences: UserPreferences): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PREFERENCES_CACHE_KEY, JSON.stringify(preferences));
  } catch {
    // localStorage is a cache only; failures should not affect server persistence.
  }
}

function mergePreferencePatch(base: UserPreferences, patch: UserPreferencesPatch): UserPreferences {
  return UserPreferencesSchema.parse({
    ...base,
    ...patch,
    notifications: {
      ...base.notifications,
      ...(patch.notifications ?? {}),
    },
  });
}

function extractError(json: unknown, fallback: string): string {
  if (json !== null && typeof json === "object" && "error" in json) {
    const value = json.error;
    if (typeof value === "string") return value;
  }
  return fallback;
}

function systemTheme(): "dark" | "light" {
  if (typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches) {
    return "dark";
  }
  return "light";
}
