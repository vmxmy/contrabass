import type { PollerAdapter, PollerEnv, PollerInvocation } from "./index";

export type InternalBoardStatus = "todo" | "in_progress" | "retry" | "done";
export type InternalBoardIssueState = "unclaimed" | "claimed";

export type InternalBoardIssue = {
  id: string;
  external_id: string;
  identifier: string;
  title: string;
  description: string;
  state: InternalBoardIssueState;
  priority: number;
  labels: string[];
  url: string;
  branch_name: string;
  blocked_by: string[];
  assignee?: string;
  created_at?: string;
  updated_at?: string;
  tracker_meta: {
    provider: "internal-board";
    internal_status: InternalBoardStatus;
    parent_id?: string;
    child_ids: string[];
    claimed_by?: string;
    raw: Record<string, unknown>;
  };
};

export type InternalBoardAdapterResult = {
  teamId: string;
  issuesSeen: number;
  issuesNew: number;
  issuesUpdated: number;
};

type InternalBoardPhase = "open" | "claimed" | "done";

type CoordinatorRefreshStats = {
  issuesNew: number;
  issuesUpdated: number;
};

type InternalBoardRow = {
  id: string;
  externalId: string;
  title: string;
  body: string;
  labels: string;
  status: InternalBoardStatus;
  priority: number;
  assignee: string | null;
  blockers: string;
  parentId: string | null;
  childIds: string;
  branchName: string | null;
  claimedBy: string | null;
  trackerMeta: string;
  createdAt: string;
  updatedAt: string;
};

const INTERNAL_BOARD_SOURCE = "tracker-poller-internal-board";

export async function pollInternalBoard(invocation: PollerInvocation): Promise<InternalBoardAdapterResult> {
  if (invocation.env.CONTROL_PLANE_DB === undefined) {
    throw new Error("CONTROL_PLANE_DB binding required for Internal Board poller");
  }

  const rows = await listInternalBoardRows(invocation.env, invocation.team.teamId);
  const issues = rows.map(normalizeInternalBoardIssue);
  const refreshStats = await postIssuesToTeamCoordinator(invocation.env, invocation.team.teamId, issues);

  return {
    teamId: invocation.team.teamId,
    issuesSeen: issues.length,
    issuesNew: refreshStats.issuesNew,
    issuesUpdated: refreshStats.issuesUpdated,
  };
}

export const internalBoardAdapter: PollerAdapter = async (invocation) => {
  const result = await pollInternalBoard(invocation);
  return {
    teamId: result.teamId,
    issuesSeen: result.issuesSeen,
    issuesNew: result.issuesNew,
    issuesUpdated: result.issuesUpdated,
  };
};

export function normalizeInternalBoardIssue(row: InternalBoardRow): InternalBoardIssue {
  const labels = parseStringArray(row.labels, "labels", row.id).map((label) => label.toLowerCase());
  const blockers = parseStringArray(row.blockers, "blockers", row.id);
  const childIds = parseStringArray(row.childIds, "child_ids", row.id);
  const rawTrackerMeta = parseJsonObject(row.trackerMeta, "tracker_meta", row.id);
  const externalId = row.externalId.trim() === "" ? row.id : row.externalId;

  return {
    id: row.id,
    external_id: externalId,
    identifier: row.id,
    title: row.title,
    description: row.body,
    state: stateFromStatus(row.status),
    priority: row.priority,
    labels,
    url: "",
    branch_name: row.branchName ?? `symphony/${row.id.toLowerCase()}`,
    blocked_by: blockers,
    ...(row.assignee === null || row.assignee === "" ? {} : { assignee: row.assignee }),
    ...(row.createdAt === "" ? {} : { created_at: row.createdAt }),
    ...(row.updatedAt === "" ? {} : { updated_at: row.updatedAt }),
    tracker_meta: {
      provider: "internal-board",
      internal_status: row.status,
      ...(row.parentId === null || row.parentId === "" ? {} : { parent_id: row.parentId }),
      child_ids: childIds,
      ...(row.claimedBy === null || row.claimedBy === "" ? {} : { claimed_by: row.claimedBy }),
      raw: rawTrackerMeta,
    },
  };
}

async function listInternalBoardRows(env: PollerEnv, teamId: string): Promise<InternalBoardRow[]> {
  if (env.CONTROL_PLANE_DB === undefined) {
    return [];
  }

  const result = await env.CONTROL_PLANE_DB.prepare(`
    SELECT
      id,
      external_id AS externalId,
      title,
      body,
      labels,
      status,
      priority,
      assignee,
      blockers,
      parent_id AS parentId,
      child_ids AS childIds,
      branch_name AS branchName,
      claimed_by AS claimedBy,
      tracker_meta AS trackerMeta,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM internal_board
    WHERE team_id = ?
    ORDER BY updated_at ASC, id ASC
  `).bind(teamId).all<InternalBoardRow>();

  return result.results ?? [];
}

async function postIssuesToTeamCoordinator(
  env: PollerEnv,
  teamId: string,
  issues: InternalBoardIssue[],
): Promise<CoordinatorRefreshStats> {
  if (issues.length === 0) {
    return { issuesNew: 0, issuesUpdated: 0 };
  }
  if (env.TEAM_COORDINATOR === undefined) {
    throw new Error("TEAM_COORDINATOR binding required for Internal Board poller");
  }

  const id = env.TEAM_COORDINATOR.idFromName(teamId);
  const stub = env.TEAM_COORDINATOR.get(id);
  const response = await stub.fetch(new Request("https://team-coordinator.internal/board/refresh", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-contrabass-team-id": teamId,
      "x-contrabass-source": INTERNAL_BOARD_SOURCE,
    },
    body: JSON.stringify({
      issues: issues.map((issue) => ({
        issueRef: issue.identifier,
        external_id: issue.external_id,
        phase: phaseFromStatus(issue.tracker_meta.internal_status),
        lastUpdated: safeDateParse(issue.updated_at),
        tracker: "internal-board",
        issue,
      })),
    }),
  }));

  if (!response.ok) {
    throw new Error(`TeamCoordinator rejected Internal Board issues for team ${teamId}: ${response.status}`);
  }
  return coordinatorRefreshStatsFromResponse(response, issues.length);
}

async function coordinatorRefreshStatsFromResponse(
  response: Response,
  fallbackIssuesNew: number,
): Promise<CoordinatorRefreshStats> {
  const fallback = { issuesNew: fallbackIssuesNew, issuesUpdated: 0 };
  const body: unknown = await response.json().catch(() => undefined);
  if (!isRecord(body)) {
    return fallback;
  }

  const stats = isRecord(body.issueStats) ? body.issueStats : body;
  const issuesNew = getNumberField(stats, "issuesNew");
  const issuesUpdated = getNumberField(stats, "issuesUpdated");
  if (issuesNew === undefined || issuesUpdated === undefined) {
    return fallback;
  }
  return { issuesNew, issuesUpdated };
}

function stateFromStatus(status: InternalBoardStatus): InternalBoardIssueState {
  return status === "todo" || status === "retry" ? "unclaimed" : "claimed";
}

function phaseFromStatus(status: InternalBoardStatus): InternalBoardPhase {
  switch (status) {
    case "todo":
    case "retry":
      return "open";
    case "in_progress":
      return "claimed";
    case "done":
      return "done";
  }
}

function parseStringArray(value: string, fieldName: string, rowId: string): string[] {
  const parsed = parseJsonValue(value, fieldName, rowId);
  if (!Array.isArray(parsed)) {
    throw new Error(`internal board row ${rowId} ${fieldName} must be a JSON array`);
  }
  return parsed.flatMap((item) => typeof item === "string" && item !== "" ? [item] : []);
}

function parseJsonObject(value: string, fieldName: string, rowId: string): Record<string, unknown> {
  const parsed = parseJsonValue(value, fieldName, rowId);
  if (!isRecord(parsed)) {
    throw new Error(`internal board row ${rowId} ${fieldName} must be a JSON object`);
  }
  return parsed;
}

function parseJsonValue(value: string, fieldName: string, rowId: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`internal board row ${rowId} ${fieldName} is invalid JSON: ${message}`);
  }
}

function safeDateParse(value: string | undefined): number {
  if (value === undefined || value === "") {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getNumberField(value: Record<string, unknown>, key: string): number | undefined {
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}
