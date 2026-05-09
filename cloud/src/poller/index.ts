import { linearAdapter } from "./linear";

export type PollerEnv = {
  CONTROL_PLANE_DB?: D1Database;
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

export type PollerAdapter = (invocation: PollerInvocation) => Promise<void> | void;

export type PollerAdapters = Partial<Record<PollerAdapterName, PollerAdapter>>;

export type PollerResult = {
  scheduledTime: number;
  cron: string;
  teamsSeen: number;
  teamsEnabled: number;
  adapterCalls: number;
};

type TeamConfigRow = {
  teamId: string;
  contentHash: string;
  contentYaml: string;
};

type TrackerBlockState = {
  inTracker: boolean;
  indent: number;
  enabled: boolean;
  trackers: Set<PollerAdapterName>;
};

const TRACKER_POLL_CRON = "* * * * *";
const DEFAULT_ADAPTERS: PollerAdapters = { linear: linearAdapter };

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
  let adapterCalls = 0;

  for (const team of teams) {
    const enabledTrackers = enabledTrackersFromConfig(team.contentYaml);
    if (enabledTrackers.length === 0) {
      continue;
    }

    teamsEnabled += 1;
    for (const adapter of enabledTrackers) {
      const pollAdapter = adapters[adapter];
      if (pollAdapter === undefined) {
        continue;
      }
      adapterCalls += 1;
      try {
        await pollAdapter({ team, adapter, scheduledTime: controller.scheduledTime, cron: controller.cron, env });
      } catch (error) {
        console.error(JSON.stringify({
          event: "tracker_poller_adapter_error",
          teamId: team.teamId,
          adapter,
          message: error instanceof Error ? error.message : String(error),
        }));
      }
    }
  }

  return {
    scheduledTime: controller.scheduledTime,
    cron: controller.cron,
    teamsSeen: teams.length,
    teamsEnabled,
    adapterCalls,
  };
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
