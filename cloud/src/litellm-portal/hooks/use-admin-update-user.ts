import { useMutation, useQueryClient } from "@tanstack/react-query";
import { UpdateUserResultSchema } from "../schemas";
import { ADMIN_USERS_QUERY_KEY } from "./use-admin-users";
import type { AdminUsers } from "../schemas";

export type UpdateUserInput = {
  userId: string;
  reason: string;
  role?: string;
  maxBudget?: number | null;
  dryRun?: boolean;
};

export function useAdminUpdateUser() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: UpdateUserInput) => {
      const url = `/api/admin/users/${encodeURIComponent(input.userId)}${input.dryRun === true ? "?dryRun=true" : ""}`;
      const body: Record<string, unknown> = { reason: input.reason };
      if (input.role !== undefined) body.role = input.role;
      if (input.maxBudget !== undefined) body.maxBudget = input.maxBudget;
      const res = await fetch(url, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({})) as Record<string, unknown>;
      if (!res.ok) {
        throw Object.assign(new Error(typeof json.error === "string" ? json.error : "update_user_failed"), json);
      }
      return UpdateUserResultSchema.parse(json);
    },
    onMutate: async (input) => {
      // Dry-run is a server-side preview; do not mutate the cache so the
      // ConfirmDialog does not silently change the UI before the operator commits.
      if (input.dryRun === true) return { previous: undefined };
      await queryClient.cancelQueries({ queryKey: ADMIN_USERS_QUERY_KEY(1, 50) });
      const previous = queryClient.getQueryData<AdminUsers>(ADMIN_USERS_QUERY_KEY(1, 50));
      queryClient.setQueryData<AdminUsers>(ADMIN_USERS_QUERY_KEY(1, 50), (old) => {
        if (!old) return old;
        return {
          ...old,
          users: old.users.map((u) =>
            u.userId === input.userId
              ? {
                  ...u,
                  role: input.role !== undefined ? input.role : u.role,
                  maxBudget: input.maxBudget !== undefined ? input.maxBudget : u.maxBudget,
                }
              : u,
          ),
        };
      });
      return { previous };
    },
    onError: (_err, _input, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData<AdminUsers>(ADMIN_USERS_QUERY_KEY(1, 50), context.previous);
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
    },
  });
}
