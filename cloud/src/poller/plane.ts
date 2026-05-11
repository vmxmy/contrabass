import type { PollerAdapter, PollerEnv, PollerInvocation } from "./index";

export type PlanePollIssueState = "unclaimed" | "claimed";

export type PlanePollIssue = {
  id: string;
  external_id: string;
  identifier: string;
  title: string;
  description: string;
  state: PlanePollIssueState;
  priority: number;
  labels: string[];
  url: string;
  branch_name: string;
  blocked_by: string[];
  model_override?: string;
  created_at?: string;
  updated_at?: string;
  tracker_meta: {
    provider: "plane";
    plane_state_id: string;
    plane_state_group: string;
    workspace_slug: string;
    project_id: string;
  };
};

export type PlaneAdapterResult = {
  teamId: string;
  issuesSeen: number;
  issuesNew: number;
  issuesUpdated: number;
};

type PlaneAdapterConfig = {
  token: string;
  host: string;
  workspaceSlug: string;
  projectId: string;
  pageSize: number;
};

type PlaneClientOptions = {
  token: string;
  host?: string;
  fetcher?: Fetcher;
  pageSize?: number;
};

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type CoordinatorRefreshStats = {
  issuesNew: number;
  issuesUpdated: number;
};

type PlaneStateInline = {
  id: string;
  name: string;
  group: string;
};

type PlaneWorkItemResponse = {
  id: string;
  sequence_id: string;
  name: string;
  description_html?: string;
  state: string | PlaneStateInline;
  labels?: Array<{ id: string; name: string }>;
  assignees?: string[];
  created_at?: string;
  updated_at?: string;
  priority?: string;
};

const DEFAULT_PLANE_HOST = "https://api.plane.so";
const DEFAULT_PAGE_SIZE = 50;
const MODEL_OVERRIDE_PATTERN = /<!--\s*model:\s*(\S+)\s*-->/gu;
const TERMINAL_STATE_GROUPS = new Set(["completed", "cancelled"]);

export class PlaneRateLimitError extends Error {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super(retryAfterMs > 0 ? `plane API rate limited, retry after ${retryAfterMs}ms` : "plane API rate limited");
    this.name = "PlaneRateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

export class PlaneClient {
  private readonly host: string;
  private readonly fetcher: Fetcher;
  private readonly pageSize: number;

  constructor(private readonly options: PlaneClientOptions) {
    if (options.token.trim() === "") {
      throw new Error("plane API token required");
    }
    this.host = (options.host ?? DEFAULT_PLANE_HOST).replace(/\/+$/u, "");
    this.fetcher = options.fetcher ?? fetch;
    this.pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  }

  async fetchWorkItems(workspaceSlug: string, projectId: string): Promise<PlanePollIssue[]> {
    const issues: PlanePollIssue[] = [];
    let cursor: string | undefined;

    for (;;) {
      const params = new URLSearchParams({
        per_page: String(this.pageSize),
        expand: "state,labels",
      });
      if (cursor !== undefined) {
        params.set("cursor", cursor);
      }

      const url = `${this.host}/api/v1/workspaces/${workspaceSlug}/projects/${projectId}/work-items/?${params.toString()}`;
      const response = await this.fetcher(url, {
        method: "GET",
        headers: { "x-api-key": this.options.token },
      });
      const responseText = await response.text();
      this.assertResponse(response, responseText);

      const parsed: unknown = JSON.parse(responseText);
      const results = extractResults(parsed);
      const nextPage = isRecord(parsed) ? getBooleanField(parsed, "next_page_results") ?? false : false;
      const nextCursor = isRecord(parsed) ? getStringField(parsed, "next_cursor") : undefined;

      for (const item of results) {
        if (!isRecord(item)) continue;
        const planeIssue = itemToPlaneWorkItem(item);
        const stateGroup = resolveStateGroup(planeIssue.state);

        if (TERMINAL_STATE_GROUPS.has(stateGroup)) continue;

        const stateId = resolveStateId(planeIssue.state);
        issues.push(normalizePlaneIssue(planeIssue, stateId, stateGroup, workspaceSlug, projectId));
      }

      if (!nextPage || nextCursor === undefined || nextCursor === "") break;
      cursor = nextCursor;
    }

    return issues;
  }

  private assertResponse(response: Response, body: string): void {
    if (response.status === 429) {
      throw new PlaneRateLimitError(parseRetryAfterMs(response.headers.get("Retry-After")));
    }
    if (response.status === 401) {
      throw new Error(`plane API auth error (status 401): ${truncateBody(body)}`);
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`plane API error (status ${response.status}): ${truncateBody(body)}`);
    }
  }
}

export async function pollPlane(invocation: PollerInvocation, fetcher?: Fetcher): Promise<PlaneAdapterResult> {
  const config = planeAdapterConfigFromInvocation(invocation);

  const client = new PlaneClient({
    token: config.token,
    host: config.host,
    fetcher,
    pageSize: config.pageSize,
  });

  const issues = await client.fetchWorkItems(config.workspaceSlug, config.projectId);
  const refreshStats = await postIssuesToTeamCoordinator(invocation.env, invocation.team.teamId, issues);

  return {
    teamId: invocation.team.teamId,
    issuesSeen: issues.length,
    issuesNew: refreshStats.issuesNew,
    issuesUpdated: refreshStats.issuesUpdated,
  };
}

export const planeAdapter: PollerAdapter = async (invocation) => {
  const result = await pollPlane(invocation);
  return {
    teamId: result.teamId,
    issuesSeen: result.issuesSeen,
    issuesNew: result.issuesNew,
    issuesUpdated: result.issuesUpdated,
  };
};

export function normalizePlaneIssue(
  item: PlaneWorkItemResponse,
  stateId: string,
  stateGroup: string,
  workspaceSlug: string,
  projectId: string,
): PlanePollIssue {
  const identifier = item.sequence_id ?? "";
  const description = item.description_html ?? "";
  const modelOverride = parseModelOverride(description);

  return {
    id: item.id,
    external_id: item.id,
    identifier,
    title: item.name ?? "",
    description,
    state: issueStateFromGroup(stateGroup),
    priority: planePriorityToNumber(item.priority),
    labels: extractPlaneLabels(item),
    url: identifier === "" ? "" : `${DEFAULT_PLANE_HOST}/${workspaceSlug}/projects/${projectId}/issues/${identifier}`,
    branch_name: identifier === "" ? "" : `symphony/${identifier.toLowerCase()}`,
    blocked_by: [],
    ...(modelOverride === "" ? {} : { model_override: modelOverride }),
    ...(item.created_at === undefined ? {} : { created_at: item.created_at }),
    ...(item.updated_at === undefined ? {} : { updated_at: item.updated_at }),
    tracker_meta: {
      provider: "plane",
      plane_state_id: stateId,
      plane_state_group: stateGroup,
      workspace_slug: workspaceSlug,
      project_id: projectId,
    },
  };
}

function resolveStateGroup(state: string | PlaneStateInline): string {
  if (isRecord(state)) {
    return getStringField(state, "group") ?? "";
  }
  return "";
}

function resolveStateId(state: string | PlaneStateInline): string {
  if (isRecord(state)) {
    return getStringField(state, "id") ?? "";
  }
  if (typeof state === "string") {
    return state;
  }
  return "";
}

function issueStateFromGroup(stateGroup: string): PlanePollIssueState {
  const normalized = stateGroup.trim().toLowerCase();
  if (normalized === "backlog" || normalized === "unstarted" || normalized === "") {
    return "unclaimed";
  }
  return "claimed";
}

function planePriorityToNumber(priority: string | undefined): number {
  switch (priority) {
    case "urgent": return 1;
    case "high": return 2;
    case "medium": return 3;
    case "low": return 4;
    case "none": return 0;
    default: return 0;
  }
}

function extractPlaneLabels(item: PlaneWorkItemResponse): string[] {
  if (!Array.isArray(item.labels)) return [];
  return item.labels.flatMap((label) => {
    if (isRecord(label)) {
      const name = getStringField(label, "name");
      return name === undefined || name === "" ? [] : [name.toLowerCase()];
    }
    return [];
  });
}

function planeAdapterConfigFromInvocation(invocation: PollerInvocation): PlaneAdapterConfig {
  const trackerYaml = scopedYamlBlock(invocation.team.contentYaml, ["tracker"]);
  const planeYaml = scopedYamlBlock(invocation.team.contentYaml, ["tracker", "plane"]);

  const host = firstDefinedScalar(planeYaml, trackerYaml, ["host", "endpoint"])
    ?? DEFAULT_PLANE_HOST;
  const workspaceSlug = firstDefinedScalar(planeYaml, trackerYaml, ["workspace_slug", "workspace", "workspaceSlug"]);
  const projectId = firstDefinedScalar(planeYaml, trackerYaml, ["project_id", "projectId", "project"]);
  const pageSize = parsePositiveInt(firstDefinedScalar(planeYaml, trackerYaml, ["page_size", "pageSize"]))
    ?? DEFAULT_PAGE_SIZE;
  const tokenRef = firstDefinedScalar(planeYaml, trackerYaml, ["token", "api_key", "apiKey"]);
  const token = resolvePlaneToken(invocation.env, invocation.team.teamId, tokenRef);

  if (workspaceSlug === undefined) {
    throw new Error(`plane tracker config for team ${invocation.team.teamId} requires workspace_slug`);
  }
  if (projectId === undefined) {
    throw new Error(`plane tracker config for team ${invocation.team.teamId} requires project_id`);
  }

  return { token, host, workspaceSlug, projectId, pageSize };
}

function resolvePlaneToken(env: PollerEnv, teamId: string, tokenRef: string | undefined): string {
  if (tokenRef !== undefined) {
    if (tokenRef.startsWith("$")) {
      const token = getStringEnv(env, tokenRef.slice(1));
      if (token !== undefined && token !== "") {
        return token;
      }
      throw new Error(`plane tracker secret binding not found: ${tokenRef.slice(1)}`);
    }
    return tokenRef;
  }

  const bindingNames = [
    `TRACKER_${bindingSafeTeamId(teamId)}_PLANE_API_KEY`,
    "TRACKER_PLANE_API_KEY",
    "PLANE_API_KEY",
  ];
  for (const binding of bindingNames) {
    const token = getStringEnv(env, binding);
    if (token !== undefined && token !== "") {
      return token;
    }
  }
  throw new Error(`plane tracker secret binding not found for team ${teamId}`);
}

async function postIssuesToTeamCoordinator(
  env: PollerEnv,
  teamId: string,
  issues: PlanePollIssue[],
): Promise<CoordinatorRefreshStats> {
  if (issues.length === 0) {
    return { issuesNew: 0, issuesUpdated: 0 };
  }
  if (env.TEAM_COORDINATOR === undefined) {
    throw new Error("TEAM_COORDINATOR binding required for Plane poller");
  }

  const id = env.TEAM_COORDINATOR.idFromName(teamId);
  const stub = env.TEAM_COORDINATOR.get(id);
  const response = await stub.fetch(new Request("https://team-coordinator.internal/board/refresh", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-contrabass-team-id": teamId,
      "x-contrabass-source": "tracker-poller-plane",
    },
    body: JSON.stringify({
      issues: issues.map((issue) => ({
        issueRef: issue.identifier === "" ? issue.id : issue.identifier,
        external_id: issue.external_id,
        phase: "open",
        lastUpdated: safeDateParse(issue.updated_at),
        tracker: "plane",
        issue,
      })),
    }),
  }));

  if (!response.ok) {
    throw new Error(`TeamCoordinator rejected Plane issues for team ${teamId}: ${response.status}`);
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

function itemToPlaneWorkItem(item: Record<string, unknown>): PlaneWorkItemResponse {
  const stateField = item.state;
  let state: string | PlaneStateInline = getStringField(item, "state") ?? "";
  if (isRecord(stateField)) {
    state = {
      id: getStringField(stateField, "id") ?? "",
      name: getStringField(stateField, "name") ?? "",
      group: getStringField(stateField, "group") ?? "",
    };
  }

  return {
    id: getStringField(item, "id") ?? "",
    sequence_id: String(getNumberField(item, "sequence_id") ?? getStringField(item, "sequence_id") ?? ""),
    name: getStringField(item, "name") ?? "",
    ...(getStringField(item, "description_html") === undefined ? {} : { description_html: getStringField(item, "description_html") }),
    state,
    priority: getStringField(item, "priority"),
    labels: extractRawLabels(item),
    created_at: getStringField(item, "created_at"),
    updated_at: getStringField(item, "updated_at"),
  };
}

function extractResults(parsed: unknown): Record<string, unknown>[] {
  if (isRecord(parsed) && Array.isArray(parsed.results)) {
    return parsed.results;
  }
  if (Array.isArray(parsed)) {
    return parsed;
  }
  return [];
}

function extractRawLabels(item: Record<string, unknown>): Array<{ id: string; name: string }> {
  const labels = item.labels;
  if (!Array.isArray(labels)) return [];
  return labels.flatMap((label) => {
    if (isRecord(label)) {
      return [{ id: getStringField(label, "id") ?? "", name: getStringField(label, "name") ?? "" }];
    }
    return [];
  });
}

function parseModelOverride(body: string): string {
  for (const match of body.matchAll(MODEL_OVERRIDE_PATTERN)) {
    const model = match[1]?.trim();
    if (model !== undefined && model !== "") {
      return model;
    }
  }
  return "";
}

function parseRetryAfterMs(value: string | null): number {
  if (value === null || value === "") return 0;
  const seconds = Number.parseInt(value, 10);
  if (!Number.isNaN(seconds)) return seconds * 1000;
  const retryAtMs = Date.parse(value);
  return Number.isNaN(retryAtMs) ? 0 : Math.max(0, retryAtMs - Date.now());
}

function truncateBody(body: string): string {
  const maxLength = 1000;
  return body.length > maxLength ? `${body.slice(0, maxLength)}...<truncated>` : body;
}

function safeDateParse(value: string | undefined): number {
  if (value === undefined || value === "") return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function getStringEnv(env: PollerEnv, key: string): string | undefined {
  const value = env[key];
  return typeof value === "string" ? value : undefined;
}

function bindingSafeTeamId(teamId: string): string {
  return teamId.toUpperCase().replace(/[^A-Z0-9]/gu, "_");
}

function firstDefinedScalar(primary: string[], fallback: string[], keys: string[]): string | undefined {
  for (const key of keys) {
    const value = yamlScalar(primary, key);
    if (value !== undefined) return value;
  }
  for (const key of keys) {
    const value = yamlScalar(fallback, key);
    if (value !== undefined) return value;
  }
  return undefined;
}

function scopedYamlBlock(yaml: string, path: string[]): string[] {
  let lines = yaml.split(/\r?\n/u);
  let parentIndent = -1;
  for (const segment of path) {
    const found = findYamlKey(lines, segment, parentIndent);
    if (found === undefined) return [];
    lines = childBlock(lines, found.index, found.indent);
    parentIndent = found.indent;
  }
  return lines;
}

function findYamlKey(lines: string[], key: string, parentIndent: number): { index: number; indent: number } | undefined {
  for (let index = 0; index < lines.length; index += 1) {
    const line = stripYamlComment(lines[index] ?? "");
    if (line.trim() === "") continue;
    const indent = countLeadingSpaces(line);
    if (indent <= parentIndent) continue;
    if (isYamlKey(line.trim(), key)) return { index, indent };
  }
  return undefined;
}

function childBlock(lines: string[], keyIndex: number, keyIndent: number): string[] {
  const out: string[] = [];
  for (let index = keyIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() === "") { out.push(line); continue; }
    const indent = countLeadingSpaces(line);
    if (indent <= keyIndent) break;
    out.push(line);
  }
  return out;
}

function yamlScalar(lines: string[], key: string): string | undefined {
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] ?? "";
    const line = stripYamlComment(rawLine);
    const trimmed = line.trim();
    if (!isYamlKey(trimmed, key)) continue;
    const value = trimmed.slice(key.length + 1).trim();
    if (value === "|" || value === ">") {
      return readYamlBlockScalar(lines, index, countLeadingSpaces(rawLine));
    }
    return value === "" ? undefined : stripYamlQuotes(value);
  }
  return undefined;
}

function readYamlBlockScalar(lines: string[], keyIndex: number, keyIndent: number): string {
  const blockLines: string[] = [];
  for (let index = keyIndex + 1; index < lines.length; index += 1) {
    const rawLine = lines[index] ?? "";
    if (rawLine.trim() === "") { blockLines.push(""); continue; }
    const indent = countLeadingSpaces(rawLine);
    if (indent <= keyIndent) break;
    blockLines.push(rawLine.slice(Math.min(indent, keyIndent + 2)));
  }
  return blockLines.join("\n").trimEnd();
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

function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getStringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

function getNumberField(value: Record<string, unknown>, key: string): number | undefined {
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function getBooleanField(value: Record<string, unknown>, key: string): boolean | undefined {
  const field = value[key];
  return typeof field === "boolean" ? field : undefined;
}
