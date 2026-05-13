import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { UserPreferencesPatchSchema, UserPreferencesSchema, type UserPreferences, type UserPreferencesPatch } from "../schemas";

export const ADMIN_PREFERENCES_DEFAULTS_QUERY_KEY = ["admin", "preferences-defaults"] as const;

export function useAdminPreferencesDefaults() {
  return useQuery({
    queryKey: ADMIN_PREFERENCES_DEFAULTS_QUERY_KEY,
    queryFn: async () => {
      const res = await fetch("/api/admin/preferences-defaults", { headers: { "content-type": "application/json" } });
      const json = await res.json().catch(() => ({})) as unknown;
      if (!res.ok) {
        throw new Error(extractError(json, "preferences_defaults_request_failed"));
      }
      return UserPreferencesSchema.parse(json);
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}

export function useUpdateAdminPreferencesDefaults() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (patch: UserPreferencesPatch): Promise<UserPreferences> => {
      const parsedPatch = UserPreferencesPatchSchema.parse(patch);
      const res = await fetch("/api/admin/preferences-defaults", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(parsedPatch),
      });
      const json = await res.json().catch(() => ({})) as unknown;
      if (!res.ok) {
        throw new Error(extractError(json, "preferences_defaults_update_failed"));
      }
      return UserPreferencesSchema.parse(json);
    },
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: ADMIN_PREFERENCES_DEFAULTS_QUERY_KEY });
      const previous = queryClient.getQueryData<UserPreferences>(ADMIN_PREFERENCES_DEFAULTS_QUERY_KEY);
      const optimistic = mergePreferencePatch(previous ?? UserPreferencesSchema.parse({}), patch);
      queryClient.setQueryData<UserPreferences>(ADMIN_PREFERENCES_DEFAULTS_QUERY_KEY, optimistic);
      return { previous };
    },
    onError: (_error, _patch, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData<UserPreferences>(ADMIN_PREFERENCES_DEFAULTS_QUERY_KEY, context.previous);
      }
    },
    onSuccess: (next) => {
      queryClient.setQueryData<UserPreferences>(ADMIN_PREFERENCES_DEFAULTS_QUERY_KEY, next);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ADMIN_PREFERENCES_DEFAULTS_QUERY_KEY });
    },
  });
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
