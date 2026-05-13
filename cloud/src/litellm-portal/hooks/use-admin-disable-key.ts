import { useMutation, useQueryClient } from "@tanstack/react-query";
import { DisableKeyResultSchema } from "../schemas";
import { ADMIN_USERS_QUERY_KEY } from "./use-admin-users";

export type DisableKeyInput = {
  keyId: string;
  disabled: boolean;
  reason: string;
  dryRun?: boolean;
};

export function useAdminDisableKey() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: DisableKeyInput) => {
      const url = `/api/admin/keys/${encodeURIComponent(input.keyId)}/disable${input.dryRun === true ? "?dryRun=true" : ""}`;
      const res = await fetch(url, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: input.reason, disabled: input.disabled }),
      });
      const json = await res.json().catch(() => ({})) as Record<string, unknown>;
      if (!res.ok) {
        throw Object.assign(new Error(typeof json.error === "string" ? json.error : "disable_key_failed"), json);
      }
      return DisableKeyResultSchema.parse(json);
    },
    onMutate: async (_input) => {
      await queryClient.cancelQueries({ queryKey: ADMIN_USERS_QUERY_KEY(1, 50) });
      return {};
    },
    onError: (_err, _input, _context) => {
      void queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
    },
  });
}
