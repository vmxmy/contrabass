import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CreateKeyResultSchema } from "../schemas";
import { DASHBOARD_QUERY_KEY } from "./use-dashboard";

export type CreateKeyInput = {
  keyAlias: string;
  models?: string[];
  maxBudget?: number | null;
  duration?: string;
};

export function useCreateKey() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateKeyInput): Promise<import("../schemas").CreateKeyResult> => {
      const body: Record<string, unknown> = { keyAlias: input.keyAlias };
      if (input.models && input.models.length > 0) body.models = input.models;
      if (input.maxBudget != null && Number.isFinite(input.maxBudget) && input.maxBudget >= 0) {
        body.maxBudget = input.maxBudget;
      }
      if (input.duration) body.duration = input.duration;

      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

      const json = await res.json().catch(() => ({})) as Record<string, unknown>;

      if (!res.ok) {
        const error = Object.assign(new Error(typeof json.error === "string" ? json.error : "create_key_failed"), json);
        throw error;
      }

      return CreateKeyResultSchema.parse(json);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: DASHBOARD_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: ["keys"] });
    },
  });
}
