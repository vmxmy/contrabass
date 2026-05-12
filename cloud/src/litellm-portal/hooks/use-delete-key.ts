import { useMutation, useQueryClient } from "@tanstack/react-query";
import { DASHBOARD_QUERY_KEY } from "./use-dashboard";
import type { Dashboard } from "../schemas";

export function useDeleteKey() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (keyId: string): Promise<void> => {
      const res = await fetch(`/api/keys/${encodeURIComponent(keyId)}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
      });
      if (res.status === 204) return;
      const json = await res.json().catch(() => ({})) as Record<string, unknown>;
      throw Object.assign(new Error(typeof json.error === "string" ? json.error : "delete_key_failed"), json);
    },
    onMutate: async (keyId: string) => {
      // Optimistic update: remove key from dashboard cache
      await queryClient.cancelQueries({ queryKey: DASHBOARD_QUERY_KEY });
      const previous = queryClient.getQueryData<Dashboard>(DASHBOARD_QUERY_KEY);
      queryClient.setQueryData<Dashboard>(DASHBOARD_QUERY_KEY, (old) => {
        if (!old) return old;
        return {
          ...old,
          keys: old.keys
            ? {
                ...old.keys,
                items: old.keys.items?.filter((k) => k.id !== keyId),
                totalCount: (old.keys.totalCount ?? 1) - 1,
              }
            : old.keys,
        };
      });
      return { previous };
    },
    onError: (_err, _keyId, context) => {
      // Roll back on error
      if (context?.previous !== undefined) {
        queryClient.setQueryData<Dashboard>(DASHBOARD_QUERY_KEY, context.previous);
      }
      console.error("Delete key failed:", _err);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: DASHBOARD_QUERY_KEY });
    },
  });
}
