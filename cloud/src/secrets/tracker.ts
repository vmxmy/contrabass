export const TRACKER_SECRETS_STORE_NAME = "default_secrets_store";

export const TRACKER_SECRET_PROVIDERS = ["linear", "github", "plane"] as const;

export type TrackerSecretProvider = (typeof TRACKER_SECRET_PROVIDERS)[number];

export function trackerSecretName(teamId: string, provider: TrackerSecretProvider): string {
  const normalizedTeamId = teamId.trim();
  if (normalizedTeamId.length === 0) {
    throw new Error("teamId is required");
  }
  if (normalizedTeamId.includes("/")) {
    throw new Error("teamId must not contain '/'");
  }

  return `tracker/${normalizedTeamId}/${provider}`;
}
