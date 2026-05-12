import { useQuery } from "@tanstack/react-query";
import { MeSchema } from "../schemas";
import { client } from "../rpc";

export const ME_QUERY_KEY = ["me"] as const;

export function useMe() {
  return useQuery({
    queryKey: ME_QUERY_KEY,
    queryFn: async () => {
      const res = await client.api.me.$get();
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "request_failed" })) as Record<string, unknown>;
        throw new Error(typeof body.error === "string" ? body.error : "request_failed");
      }
      // Defensive Zod parse guards against schema drift at the hook boundary.
      return MeSchema.parse(await res.json());
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}
