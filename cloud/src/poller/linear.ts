import type { PollerAdapter, PollerEnv, PollerInvocation } from "./index";

export type LinearPollIssueState = "unclaimed" | "claimed";

export type LinearPollIssue = {
  id: string;
  external_id: string;
  identifier: string;
  title: string;
  description: string;
  state: LinearPollIssueState;
  priority: number;
  labels: string[];
  url: string;
  branch_name: string;
  blocked_by: string[];
  model_override?: string;
  created_at?: string;
  updated_at?: string;
  tracker_meta: {
    provider: "linear";
    linear_state: string;
    linear_state_type: string;
  };
};

export type LinearAdapterResult = {
  teamId: string;
  issuesSeen: number;
  issuesPosted: number;
};

type LinearAdapterConfig = {
  token: string;
  endpoint: string;
  query: string;
  variables: Record<string, unknown>;
  pageSize: number;
};

type LinearClientOptions = {
  token: string;
  endpoint?: string;
  fetcher?: Fetcher;
  pageSize?: number;
};

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type GraphQLRequestBody = {
  query: string;
  variables?: Record<string, unknown>;
};

type GraphQLResponseBody = {
  data?: unknown;
  errors?: unknown;
};

type LinearPageInfo = {
  hasNextPage: boolean;
  endCursor: string;
};

const DEFAULT_LINEAR_ENDPOINT = "https://api.linear.app/graphql";
const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_FETCH_ISSUES_QUERY = `query FetchIssues($projectSlug: String!, $first: Int!, $after: String) {
  issues(filter: {project: {slugId: {eq: $projectSlug}}}, first: $first, after: $after) {
    nodes {
      id
      identifier
      title
      description
      priority
      state { name type }
      url
      labels { nodes { name } }
      createdAt
      updatedAt
      inverseRelations {
        nodes {
          type
          issue { identifier }
        }
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}`;

const TERMINAL_LINEAR_STATE_TYPES = new Set(["completed", "canceled", "backlog"]);
const MODEL_OVERRIDE_PATTERN = /<!--\s*model:\s*(\S+)\s*-->/gu;

export class LinearRateLimitError extends Error {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super(retryAfterMs > 0 ? `linear API rate limited, retry after ${retryAfterMs}ms` : "linear API rate limited");
    this.name = "LinearRateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

export class LinearAuthError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(`linear API auth error (status ${statusCode}): ${message}`);
    this.name = "LinearAuthError";
    this.statusCode = statusCode;
  }
}

export class LinearClient {
  private readonly endpoint: string;
  private readonly fetcher: Fetcher;
  private readonly pageSize: number;

  constructor(private readonly options: LinearClientOptions) {
    if (options.token.trim() === "") {
      throw new Error("linear API token required");
    }
    this.endpoint = options.endpoint ?? DEFAULT_LINEAR_ENDPOINT;
    this.fetcher = options.fetcher ?? fetch;
    this.pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  }

  async fetchIssues(query: string, variables: Record<string, unknown>): Promise<LinearPollIssue[]> {
    const issues: LinearPollIssue[] = [];
    let cursor: string | undefined;

    for (;;) {
      const data = await this.doGraphQL(query, { ...variables, first: this.pageSize, after: cursor });
      const { nodes, pageInfo } = decodeIssuesResponse(data);

      for (const node of nodes) {
        const issue = normalizeLinearIssue(node);
        if (isClaimableLinearStateType(issue.tracker_meta.linear_state_type)) {
          issues.push(issue);
        }
      }

      if (!pageInfo.hasNextPage || pageInfo.endCursor === "") {
        return issues;
      }
      cursor = pageInfo.endCursor;
    }
  }

  private async doGraphQL(query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> {
    const body: GraphQLRequestBody = { query, variables };
    const response = await this.fetcher(this.endpoint, {
      method: "POST",
      headers: {
        Authorization: this.options.token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const responseText = await response.text();

    if (response.status === 429) {
      throw new LinearRateLimitError(parseRetryAfterMs(response.headers.get("Retry-After")));
    }
    if (response.status === 401) {
      throw new LinearAuthError(response.status, responseText);
    }
    if (response.status !== 200) {
      throw new Error(`linear API error (status ${response.status}): ${truncateBody(responseText)}`);
    }

    const parsed = parseJsonObject<GraphQLResponseBody>(responseText, "linear API response");
    if (parsed.errors !== undefined) {
      throw new Error(`linear GraphQL errors: ${JSON.stringify(parsed.errors)}`);
    }
    if (parsed.data === null || typeof parsed.data !== "object" || Array.isArray(parsed.data)) {
      throw new Error("linear API: missing or invalid data field");
    }
    return parsed.data as Record<string, unknown>;
  }
}

export async function pollLinear(invocation: PollerInvocation, fetcher?: Fetcher): Promise<LinearAdapterResult> {
  const config = linearAdapterConfigFromInvocation(invocation);
  const client = new LinearClient({
    token: config.token,
    endpoint: config.endpoint,
    fetcher,
    pageSize: config.pageSize,
  });
  const issues = await client.fetchIssues(config.query, config.variables);
  await postIssuesToTeamCoordinator(invocation.env, invocation.team.teamId, issues);

  return {
    teamId: invocation.team.teamId,
    issuesSeen: issues.length,
    issuesPosted: issues.length,
  };
}

export const linearAdapter: PollerAdapter = async (invocation) => {
  await pollLinear(invocation);
};

export function normalizeLinearIssue(node: Record<string, unknown>): LinearPollIssue {
  const state = getObjectField(node, "state");
  const linearState = state === undefined ? "" : getStringField(state, "name") ?? "";
  const linearStateType = state === undefined ? "" : getStringField(state, "type") ?? "";
  const identifier = getStringField(node, "identifier") ?? "";
  const description = getStringField(node, "description") ?? "";
  const modelOverride = parseModelOverride(description);

  return {
    id: getStringField(node, "id") ?? "",
    external_id: getStringField(node, "id") ?? "",
    identifier,
    title: getStringField(node, "title") ?? "",
    description,
    state: issueStateFromLinearStateType(linearStateType),
    priority: getNumberField(node, "priority") ?? 0,
    labels: extractLabels(node),
    url: getStringField(node, "url") ?? "",
    branch_name: identifier === "" ? "" : `symphony/${identifier.toLowerCase()}`,
    blocked_by: extractBlockedBy(node),
    ...(modelOverride === "" ? {} : { model_override: modelOverride }),
    ...(getStringField(node, "createdAt") === undefined ? {} : { created_at: getStringField(node, "createdAt") }),
    ...(getStringField(node, "updatedAt") === undefined ? {} : { updated_at: getStringField(node, "updatedAt") }),
    tracker_meta: {
      provider: "linear",
      linear_state: linearState,
      linear_state_type: linearStateType,
    },
  };
}

function linearAdapterConfigFromInvocation(invocation: PollerInvocation): LinearAdapterConfig {
  const trackerYaml = scopedYamlBlock(invocation.team.contentYaml, ["tracker"]);
  const linearYaml = scopedYamlBlock(invocation.team.contentYaml, ["tracker", "linear"]);
  const projectSlug = firstDefinedScalar(linearYaml, trackerYaml, ["project_slug", "projectSlug", "project"]);
  const query = firstDefinedScalar(linearYaml, trackerYaml, ["query", "graphql_query", "graphqlQuery"])
    ?? DEFAULT_FETCH_ISSUES_QUERY;
  const endpoint = firstDefinedScalar(linearYaml, trackerYaml, ["endpoint"])
    ?? DEFAULT_LINEAR_ENDPOINT;
  const pageSize = parsePositiveInt(firstDefinedScalar(linearYaml, trackerYaml, ["page_size", "pageSize"]))
    ?? DEFAULT_PAGE_SIZE;
  const tokenRef = firstDefinedScalar(linearYaml, trackerYaml, ["token", "api_key", "apiKey"]);
  const token = resolveLinearToken(invocation.env, invocation.team.teamId, tokenRef);
  const variables: Record<string, unknown> = {};
  if (projectSlug !== undefined) {
    variables.projectSlug = projectSlug;
  }

  if (query === DEFAULT_FETCH_ISSUES_QUERY && projectSlug === undefined) {
    throw new Error(`linear tracker config for team ${invocation.team.teamId} requires project_slug`);
  }

  return { token, endpoint, query, variables, pageSize };
}

function resolveLinearToken(env: PollerEnv, teamId: string, tokenRef: string | undefined): string {
  if (tokenRef !== undefined) {
    if (tokenRef.startsWith("$")) {
      const token = getStringEnv(env, tokenRef.slice(1));
      if (token !== undefined && token !== "") {
        return token;
      }
      throw new Error(`linear tracker secret binding not found: ${tokenRef.slice(1)}`);
    }
    return tokenRef;
  }

  const bindingNames = [
    `TRACKER_${bindingSafeTeamId(teamId)}_LINEAR_TOKEN`,
    `TRACKER_${bindingSafeTeamId(teamId)}_LINEAR_API_KEY`,
    "TRACKER_LINEAR_TOKEN",
    "LINEAR_API_KEY",
  ];
  for (const binding of bindingNames) {
    const token = getStringEnv(env, binding);
    if (token !== undefined && token !== "") {
      return token;
    }
  }
  throw new Error(`linear tracker secret binding not found for team ${teamId}`);
}

async function postIssuesToTeamCoordinator(env: PollerEnv, teamId: string, issues: LinearPollIssue[]): Promise<void> {
  if (issues.length === 0) {
    return;
  }
  if (env.TEAM_COORDINATOR === undefined) {
    throw new Error("TEAM_COORDINATOR binding required for Linear poller");
  }

  const id = env.TEAM_COORDINATOR.idFromName(teamId);
  const stub = env.TEAM_COORDINATOR.get(id);
  const response = await stub.fetch(new Request("https://team-coordinator.internal/board/refresh", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-contrabass-team-id": teamId,
      "x-contrabass-source": "tracker-poller-linear",
    },
    body: JSON.stringify({
      issues: issues.map((issue) => ({
        issueRef: issue.identifier === "" ? issue.id : issue.identifier,
        external_id: issue.external_id,
        phase: "open",
        lastUpdated: Date.parse(issue.updated_at ?? ""),
        tracker: "linear",
        issue,
      })),
    }),
  }));

  if (!response.ok) {
    throw new Error(`TeamCoordinator rejected Linear issues for team ${teamId}: ${response.status}`);
  }
}

function decodeIssuesResponse(data: Record<string, unknown>): { nodes: Record<string, unknown>[]; pageInfo: LinearPageInfo } {
  const issues = getObjectField(data, "issues");
  if (issues === undefined) {
    throw new Error("missing issues field in response");
  }

  const nodesValue = issues.nodes;
  const nodes = Array.isArray(nodesValue)
    ? nodesValue.flatMap((node) => (node !== null && typeof node === "object" && !Array.isArray(node) ? [node] : []))
    : [];
  const rawPageInfo = getObjectField(issues, "pageInfo");
  const pageInfo = rawPageInfo === undefined
    ? { hasNextPage: false, endCursor: "" }
    : {
      hasNextPage: getBooleanField(rawPageInfo, "hasNextPage") ?? false,
      endCursor: getStringField(rawPageInfo, "endCursor") ?? "",
    };

  return { nodes, pageInfo };
}

function isClaimableLinearStateType(linearStateType: string): boolean {
  const normalized = linearStateType.trim().toLowerCase();
  return normalized === "" || !TERMINAL_LINEAR_STATE_TYPES.has(normalized);
}

function issueStateFromLinearStateType(linearStateType: string): LinearPollIssueState {
  switch (linearStateType.trim().toLowerCase()) {
    case "":
    case "unstarted":
      return "unclaimed";
    default:
      return "claimed";
  }
}

function extractLabels(node: Record<string, unknown>): string[] {
  const labels = getObjectField(node, "labels");
  if (labels === undefined || !Array.isArray(labels.nodes)) {
    return [];
  }
  return labels.nodes.flatMap((label) => {
    if (label === null || typeof label !== "object" || Array.isArray(label)) {
      return [];
    }
    const name = getStringField(label, "name");
    return name === undefined || name === "" ? [] : [name.toLowerCase()];
  });
}

function extractBlockedBy(node: Record<string, unknown>): string[] {
  const inverseRelations = getObjectField(node, "inverseRelations");
  if (inverseRelations === undefined || !Array.isArray(inverseRelations.nodes)) {
    return [];
  }

  return inverseRelations.nodes.flatMap((relation) => {
    if (relation === null || typeof relation !== "object" || Array.isArray(relation)) {
      return [];
    }
    if (getStringField(relation, "type") !== "blocks") {
      return [];
    }
    const issue = getObjectField(relation, "issue");
    if (issue === undefined) {
      return [];
    }
    const identifier = getStringField(issue, "identifier");
    return identifier === undefined || identifier === "" ? [] : [identifier];
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
  if (value === null || value === "") {
    return 0;
  }
  const seconds = Number.parseInt(value, 10);
  return Number.isNaN(seconds) ? 0 : seconds * 1000;
}

function truncateBody(body: string): string {
  const maxLength = 1000;
  return body.length > maxLength ? `${body.slice(0, maxLength)}...<truncated>` : body;
}

function parseJsonObject<T extends Record<string, unknown>>(text: string, name: string): T {
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON object`);
  }
  return parsed as T;
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
    if (value !== undefined) {
      return value;
    }
  }
  for (const key of keys) {
    const value = yamlScalar(fallback, key);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function scopedYamlBlock(yaml: string, path: string[]): string[] {
  let lines = yaml.split(/\r?\n/u);
  let parentIndent = -1;
  for (const segment of path) {
    const found = findYamlKey(lines, segment, parentIndent);
    if (found === undefined) {
      return [];
    }
    lines = childBlock(lines, found.index, found.indent);
    parentIndent = found.indent;
  }
  return lines;
}

function findYamlKey(lines: string[], key: string, parentIndent: number): { index: number; indent: number } | undefined {
  for (let index = 0; index < lines.length; index += 1) {
    const line = stripYamlComment(lines[index] ?? "");
    if (line.trim() === "") {
      continue;
    }
    const indent = countLeadingSpaces(line);
    if (indent <= parentIndent) {
      continue;
    }
    if (isYamlKey(line.trim(), key)) {
      return { index, indent };
    }
  }
  return undefined;
}

function childBlock(lines: string[], keyIndex: number, keyIndent: number): string[] {
  const out: string[] = [];
  for (let index = keyIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() === "") {
      out.push(line);
      continue;
    }
    const indent = countLeadingSpaces(line);
    if (indent <= keyIndent) {
      break;
    }
    out.push(line);
  }
  return out;
}

function yamlScalar(lines: string[], key: string): string | undefined {
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] ?? "";
    const line = stripYamlComment(rawLine);
    const trimmed = line.trim();
    if (!isYamlKey(trimmed, key)) {
      continue;
    }
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
    if (rawLine.trim() === "") {
      blockLines.push("");
      continue;
    }
    const indent = countLeadingSpaces(rawLine);
    if (indent <= keyIndent) {
      break;
    }
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
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function getObjectField(value: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const field = value[key];
  return field !== null && typeof field === "object" && !Array.isArray(field) ? field as Record<string, unknown> : undefined;
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
