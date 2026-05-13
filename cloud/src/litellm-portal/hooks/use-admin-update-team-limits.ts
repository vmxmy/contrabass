import { useMutation, useQueryClient } from "@tanstack/react-query";
import { UpdateTeamLimitsResultSchema } from "../schemas";
import { ADMIN_TEAMS_QUERY_KEY } from "./use-admin-teams";
import type { AdminTeams } from "../schemas";

export type UpdateTeamLimitsInput = {
  teamId: string;
  reason: string;
  tpmLimit?: number | null;
  rpmLimit?: number | null;
  maxBudget?: number | null;
  dryRun?: boolean;
};

export function useAdminUpdateTeamLimits() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: UpdateTeamLimitsInput) => {
      const url = `/api/admin/teams/${encodeURIComponent(input.teamId)}/limits${input.dryRun === true ? "?dryRun=true" : ""}`;
      const body: Record<string, unknown> = { reason: input.reason };
      if (input.tpmLimit !== undefined) body.tpmLimit = input.tpmLimit;
      if (input.rpmLimit !== undefined) body.rpmLimit = input.rpmLimit;
      if (input.maxBudget !== undefined) body.maxBudget = input.maxBudget;
      const res = await fetch(url, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({})) as Record<string, unknown>;
      if (!res.ok) {
        throw Object.assign(new Error(typeof json.error === "string" ? json.error : "update_team_limits_failed"), json);
      }
      return UpdateTeamLimitsResultSchema.parse(json);
    },
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: ADMIN_TEAMS_QUERY_KEY });
      const previous = queryClient.getQueryData<AdminTeams>(ADMIN_TEAMS_QUERY_KEY);
      queryClient.setQueryData<AdminTeams>(ADMIN_TEAMS_QUERY_KEY, (old) => {
        if (!old) return old;
        return {
          ...old,
          teams: old.teams.map((t) =>
            t.id === input.teamId
              ? {
                  ...t,
                  tpmLimit: input.tpmLimit !== undefined ? input.tpmLimit : t.tpmLimit,
                  rpmLimit: input.rpmLimit !== undefined ? input.rpmLimit : t.rpmLimit,
                  maxBudget: input.maxBudget !== undefined ? input.maxBudget : t.maxBudget,
                }
              : t,
          ),
        };
      });
      return { previous };
    },
    onError: (_err, _input, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData<AdminTeams>(ADMIN_TEAMS_QUERY_KEY, context.previous);
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ADMIN_TEAMS_QUERY_KEY });
    },
  });
}
