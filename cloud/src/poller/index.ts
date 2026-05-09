import { githubAdapter } from "./github";
import { internalBoardAdapter } from "./internal-board";
import { linearAdapter } from "./linear";

export type PollerEnv = {
  CONTROL_PLANE_DB?: D1Database;
  TRACKER_POLLER_METRICS?: AnalyticsEngineDataset;
  TEAM_COORDINATOR?: DurableObjectNamespace;
  [binding: string]: unknown;
};

export type PollerAdapterName = "linear" | "github" | "internal-board";

export type PollerTeamConfig = {
  teamId: string;
  contentHash: string;
  contentYaml: string;
};

export type PollerInvocation = {
  team: PollerTeamConfig;
  adapter: PollerAdapterName;
  scheduledTime: number;
  cron: string;
  env: PollerEnv;
};

export type PollerAdapterResult = {
  teamId: string;
  issuesSeen: number;
  issuesNew?: number;
  issuesUpdated?: number;
};

export type PollerAdapter = (
  invocation: PollerInvocation,
) => Promise<PollerAdapterResult | void> | PollerAdapterResult | void;

export type PollerAdapters = Partial<Record<PollerAdapterName, PollerAdapter>>;

export type PollerResult = {
  scheduledTime: number;
  cron: string;
  teamsSeen: number;
  teamsEnabled: number;
  teamsSkippedBackoff: number;
  adapterCalls: number;
};

type TeamBackoff = {
  retryAtMs: number;
  adapter: PollerAdapterName;
  backoffCount: number;
};

type RateLimitLikeError = Error & {
  retryAfterMs: number;
};

type TeamConfigRow = {
  teamId: string;
  contentHash: string;
  contentYaml: string;
};

type TeamBackoffRow = {
  retryAtMs: number;
  adapter: string;
  backoffCount: number;
};

type TrackerBlockState = {
  inTracker: boolean;
  indent: number;
  enabled: boolean;
  trackers: Set<PollerAdapterName>;
};

const TRACKER_POLL_CRON = "* * * * *";
const DEFAULT_ADAPTERS: PollerAdapters = {
  github: githubAdapter,
  "internal-board": internalBoardAdapter,
  linear: linearAdapter,
};

const worker: ExportedHandler<PollerEnv> = {
  fetch() {
    return Response.json({ service: "contrabass-tracker-poller", status: "ok" });
  },

  scheduled(controller, env, context) {
    context.waitUntil(runTrackerPoller(env, controller, DEFAULT_ADAPTERS));
  },
};

export default worker;

export async function runTrackerPoller(
  env: PollerEnv,
  controller: Pick<ScheduledController, "scheduledTime" | "cron"> = {
    scheduledTime: Date.now(),
    cron: TRACKER_POLL_CRON,
  },
  adapters: PollerAdapters = DEFAULT_ADAPTERS,
): Promise<PollerResult> {
  const teams = await listActiveTeamConfigs(env);
  let teamsEnabled = 0;
  let teamsSkippedBackoff = 0;
  let adapterCalls = 0;

  for (const team of teams) {
    const enabledTrackers = enabledTrackersFromConfig(team.contentYaml);
    if (enabledTrackers.length === 0) {
      continue;
    }

    teamsEnabled += 1;
    const activeBackoff = await getTeamBackoff(env, team.teamId);
    const nowMs = Date.now();
    if (activeBackoff !== undefined && activeBackoff.retryAtMs > nowMs) {
      teamsSkippedBackoff += 1;
      console.warn(JSON.stringify({
        event: "tracker_poller_team_backoff_skip",
        teamId: team.teamId,
        adapter: activeBackoff.adapter,
        retryAtMs: activeBackoff.retryAtMs,
        backoffCount: activeBackoff.backoffCount,
      }));
      continue;
    }
    if (activeBackoff !== undefined) {
      await deleteTeamBackoff(env, team.teamId);
    }

    for (const adapter of enabledTrackers) {
      const pollAdapter = adapters[adapter];
      if (pollAdapter === undefined) {
        continue;
      }
      adapterCalls += 1;
      const startedAt = Date.now();
      try {
        const adapterResult = await pollAdapter({
          team,
          adapter,
          scheduledTime: controller.scheduledTime,
          cron: controller.cron,
          env,
        });
        emitPollerMetric(env, {
          teamId: team.teamId,
          adapter,
          cron: controller.cron,
          scheduledTime: controller.scheduledTime,
          durationMs: Date.now() - startedAt,
          issuesSeen: adapterResult?.issuesSeen ?? 0,
          issuesNew: adapterResult?.issuesNew ?? 0,
          issuesUpdated: adapterResult?.issuesUpdated ?? 0,
          errors: 0,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        emitPollerMetric(env, {
          teamId: team.teamId,
          adapter,
          cron: controller.cron,
          scheduledTime: controller.scheduledTime,
          durationMs: Date.now() - startedAt,
          issuesSeen: 0,
          issuesNew: 0,
          issuesUpdated: 0,
          errors: 1,
          errorMessage: message,
        });
        if (isRateLimitError(error)) {
          const retryAfterMs = Math.max(0, error.retryAfterMs);
          const retryAtMs = Date.now() + retryAfterMs;
          const backoffCount = (activeBackoff?.backoffCount ?? 0) + 1;
          await setTeamBackoff(env, team.teamId, { retryAtMs, adapter, backoffCount });
          console.warn(JSON.stringify({
            event: "tracker_poller_team_backoff_set",
            teamId: team.teamId,
            adapter,
            retryAfterMs,
            retryAtMs,
            backoffCount,
            message,
          }));
          break;
        }
        console.error(JSON.stringify({
          event: "tracker_poller_adapter_error",
          teamId: team.teamId,
          adapter,
          message,
        }));
      }
    }
  }

  return {
    scheduledTime: controller.scheduledTime,
    cron: controller.cron,
    teamsSeen: teams.length,
    teamsEnabled,
    teamsSkippedBackoff,
    adapterCalls,
  };
}

type PollerMetric = {
  teamId: string;
  adapter: PollerAdapterName;
  cron: string;
  scheduledTime: number;
  durationMs: number;
  issuesSeen: number;
  issuesNew: number;
  issuesUpdated: number;
  errors: number;
  errorMessage?: string;
};

function emitPollerMetric(env: PollerEnv, metric: PollerMetric): void {
  try {
    env.TRACKER_POLLER_METRICS?.writeDataPoint({
      indexes: [metric.teamId],
      doubles: [
        metric.durationMs,
        metric.issuesSeen,
        metric.issuesNew,
        metric.issuesUpdated,
        metric.errors,
        metric.scheduledTime,
      ],
      blobs: [
        "tracker_poller_adapter",
        metric.teamId,
        metric.adapter,
        metric.cron,
        metric.errorMessage ?? "",
      ],
    });
  } catch (error) {
    console.warn(JSON.stringify({
      event: "tracker_poller_metrics_error",
      teamId: metric.teamId,
      adapter: metric.adapter,
      message: error instanceof Error ? error.message : String(error),
    }));
  }
}

export function enabledTrackersFromConfig(contentYaml: string): PollerAdapterName[] {
  const state: TrackerBlockState = {
    inTracker: false,
    indent: 0,
    enabled: true,
    trackers: new Set<PollerAdapterName>(),
  };

  for (const rawLine of contentYaml.split(/\r?\n/u)) {
    const line = stripYamlComment(rawLine);
    if (line.trim() === "") {
      continue;
    }

    const indent = countLeadingSpaces(line);
    const trimmed = line.trim();
    if (state.inTracker && indent <= state.indent && !trimmed.startsWith("-")) {
      state.inTracker = false;
    }

    if (isYamlKey(trimmed, "tracker")) {
      state.inTracker = true;
      state.indent = indent;
      const inlineTracker = adapterNameFromValue(valueForYamlKey(trimmed, "tracker"));
      if (inlineTracker !== undefined) {
        state.trackers.add(inlineTracker);
      }
      continue;
    }

    if (!state.inTracker || indent <= state.indent) {
      continue;
    }

    if (isYamlKey(trimmed, "enabled")) {
      state.enabled = valueForYamlKey(trimmed, "enabled") !== "false";
      continue;
    }

    const typedAdapter = adapterNameFromValue(valueForYamlKey(trimmed, "type"));
    if (typedAdapter !== undefined) {
      state.trackers.add(typedAdapter);
      continue;
    }

    const nestedAdapter = adapterNameFromKey(trimmed.split(":", 1)[0] ?? "");
    if (nestedAdapter !== undefined) {
      state.trackers.add(nestedAdapter);
    }
  }

  if (!state.enabled) {
    return [];
  }

  return [...state.trackers].sort();
}

async function listActiveTeamConfigs(env: PollerEnv): Promise<PollerTeamConfig[]> {
  if (env.CONTROL_PLANE_DB === undefined) {
    return [];
  }

  const result = await env.CONTROL_PLANE_DB.prepare(`
    SELECT
      active.team_id AS teamId,
      active.active_content_hash AS contentHash,
      config.content_yaml AS contentYaml
    FROM team_configs_active AS active
    INNER JOIN team_configs AS config
      ON config.team_id = active.team_id
      AND config.version = active.active_version
      AND config.content_hash = active.active_content_hash
    ORDER BY active.team_id
  `).all<TeamConfigRow>();

  return (result.results ?? []).map((row) => ({
    teamId: row.teamId,
    contentHash: row.contentHash,
    contentYaml: row.contentYaml,
  }));
}

async function getTeamBackoff(env: PollerEnv, teamId: string): Promise<TeamBackoff | undefined> {
  if (env.CONTROL_PLANE_DB === undefined) {
    return undefined;
  }

  const row = await env.CONTROL_PLANE_DB.prepare(`
    SELECT
      retry_at_ms AS retryAtMs,
      adapter,
      backoff_count AS backoffCount
    FROM tracker_poller_backoffs
    WHERE team_id = ?
    LIMIT 1
  `).bind(teamId).first<TeamBackoffRow>();

  if (row === null) {
    return undefined;
  }

  const adapter = adapterNameFromValue(row.adapter);
  if (adapter === undefined) {
    return undefined;
  }

  return {
    retryAtMs: row.retryAtMs,
    adapter,
    backoffCount: row.backoffCount,
  };
}

async function setTeamBackoff(env: PollerEnv, teamId: string, backoff: TeamBackoff): Promise<void> {
  if (env.CONTROL_PLANE_DB === undefined) {
    return;
  }

  await env.CONTROL_PLANE_DB.prepare(`
    INSERT INTO tracker_poller_backoffs (
      team_id,
      retry_at_ms,
      adapter,
      backoff_count,
      updated_at
    )
    VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT(team_id) DO UPDATE SET
      retry_at_ms = excluded.retry_at_ms,
      adapter = excluded.adapter,
      backoff_count = excluded.backoff_count,
      updated_at = excluded.updated_at
  `).bind(teamId, backoff.retryAtMs, backoff.adapter, backoff.backoffCount).run();
}

async function deleteTeamBackoff(env: PollerEnv, teamId: string): Promise<void> {
  if (env.CONTROL_PLANE_DB === undefined) {
    return;
  }

  await env.CONTROL_PLANE_DB.prepare(`
    DELETE FROM tracker_poller_backoffs
    WHERE team_id = ?
  `).bind(teamId).run();
}

function stripYamlComment(line: string): string {
  const commentStart = line.indexOf("#");
  return commentStart === -1 ? line : line.slice(0, commentStart);
}

function countLeadingSpaces(line: string): number {
  return line.length - line.trimStart().length;
}

function isYamlKey(line: string, key: string): boolean {
  return line === `${key}:` || line.startsWith(`${key}: `);
}

function valueForYamlKey(line: string, key: string): string | undefined {
  if (!isYamlKey(line, key)) {
    return undefined;
  }
  const value = line.slice(key.length + 1).trim();
  return value === "" ? undefined : stripYamlQuotes(value);
}

function stripYamlQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === "'" && last === "'") || (first === "\"" && last === "\"")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function adapterNameFromValue(value: string | undefined): PollerAdapterName | undefined {
  return value === undefined ? undefined : adapterNameFromKey(value);
}

function adapterNameFromKey(key: string): PollerAdapterName | undefined {
  const normalized = key.trim().replace(/_/gu, "-");
  if (normalized === "linear" || normalized === "github" || normalized === "internal-board") {
    return normalized;
  }
  return undefined;
}

function isRateLimitError(error: unknown): error is RateLimitLikeError {
  return error instanceof Error
    && typeof (error as { retryAfterMs?: unknown }).retryAfterMs === "number";
}
