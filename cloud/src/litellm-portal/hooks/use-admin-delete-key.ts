import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AdminDeleteKeyResultSchema } from "../schemas";

export type AdminDeleteKeyInput = {
  keyId: string;
  reason: string;
  confirmAlias: string;
  dryRun?: boolean;
};

export function useAdminDeleteKey() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: AdminDeleteKeyInput) => {
      const url = `/api/admin/keys/${encodeURIComponent(input.keyId)}${input.dryRun === true ? "?dryRun=true" : ""}`;
      const res = await fetch(url, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: input.reason, confirmAlias: input.confirmAlias }),
      });
      const json = await res.json().catch(() => ({})) as Record<string, unknown>;
      if (!res.ok) {
        throw Object.assign(new Error(typeof json.error === "string" ? json.error : "admin_delete_key_failed"), json);
      }
      return AdminDeleteKeyResultSchema.parse(json);
    },
    onMutate: async (_input) => {
      await queryClient.cancelQueries({ queryKey: ["admin", "users"] });
      return {};
    },
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
    },
  });
}
