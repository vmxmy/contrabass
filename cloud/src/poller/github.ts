import type { PollerAdapter, PollerEnv, PollerInvocation } from "./index";

export type GitHubPollIssueState = "unclaimed" | "claimed";

export type GitHubPollIssue = {
  id: string;
  external_id: string;
  identifier: string;
  title: string;
  description: string;
  state: GitHubPollIssueState;
  priority: number;
  labels: string[];
  url: string;
  branch_name: string;
  blocked_by: string[];
  model_override?: string;
  created_at?: string;
  updated_at?: string;
  tracker_meta: {
    provider: "github";
    github_node_id: string;
    github_state: string;
    repository: string;
  };
};

export type GitHubAdapterResult = {
  teamId: string;
  issuesSeen: number;
  issuesPosted: number;
};

type GitHubRepoConfig = {
  owner: string;
  repo: string;
};

type GitHubAdapterConfig = {
  token: string;
  endpoint: string;
  repos: GitHubRepoConfig[];
  labels: string[];
  assignees: string[];
  pageSize: number;
};

type GitHubClientOptions = {
  token: string;
  endpoint?: string;
  repos: GitHubRepoConfig[];
  labels?: string[];
  assignees?: string[];
  assignee?: string;
  fetcher?: Fetcher;
  pageSize?: number;
};

type GitHubAuthFailureMarker = {
  targetId: string;
  details: Record<string, unknown>;
};

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type GitHubIssueResponse = {
  number: number;
  node_id?: string;
  title?: string;
  body?: string | null;
  state?: string;
  labels?: Array<{ name?: string }>;
  html_url?: string;
  created_at?: string;
  updated_at?: string;
  pull_request?: unknown;
};

const DEFAULT_GITHUB_ENDPOINT = "https://api.github.com";
const DEFAULT_PAGE_SIZE = 50;
const MODEL_OVERRIDE_PATTERN = /<!--\s*model:\s*(\S+)\s*-->/gu;
const DEPENDENCY_LINE_PATTERN = /(?:blocked\s+by|depends[\s-]on|requires):\s*(.+)/giu;
const ISSUE_REF_PATTERN = /#(\d+)/gu;

export class GitHubRateLimitError extends Error {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super(retryAfterMs > 0 ? `github API rate limited, retry after ${retryAfterMs}ms` : "github API rate limited");
    this.name = "GitHubRateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

export class GitHubAuthError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(`github API auth error (status ${statusCode}): ${message}`);
    this.name = "GitHubAuthError";
    this.statusCode = statusCode;
  }
}

export class GitHubClient {
  private readonly endpoint: string;
  private readonly fetcher: Fetcher;
  private readonly pageSize: number;
  private readonly labels: string[];
  private readonly assignees: string[];

  constructor(private readonly options: GitHubClientOptions) {
    if (options.token.trim() === "") {
      throw new Error("github API token required");
    }
    if (options.repos.length === 0) {
      throw new Error("github tracker config requires at least one repo");
    }
    for (const repo of options.repos) {
      if (repo.owner.trim() === "" || repo.repo.trim() === "") {
        throw new Error("github tracker repo entries must include owner and repo");
      }
    }
    this.endpoint = (options.endpoint ?? DEFAULT_GITHUB_ENDPOINT).replace(/\/+$/u, "");
    this.fetcher = options.fetcher ?? fetch;
    this.pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    this.labels = options.labels ?? [];
    this.assignees = dedupeList([
      ...(options.assignees ?? []),
      ...(options.assignee === undefined ? [] : [options.assignee]),
    ]);
  }

  async fetchIssues(): Promise<GitHubPollIssue[]> {
    const issues: GitHubPollIssue[] = [];
    for (const repo of this.options.repos) {
      issues.push(...await this.fetchRepoIssues(repo));
    }
    return issues;
  }

  private async fetchRepoIssues(repo: GitHubRepoConfig): Promise<GitHubPollIssue[]> {
    const issuesByExternalId = new Map<string, GitHubPollIssue>();
    const assignees: Array<string | undefined> = this.assignees.length === 0 ? [undefined] : this.assignees;

    for (const assignee of assignees) {
      for (let page = 1; ; page += 1) {
        const pageItems = await this.fetchRepoIssuePage(repo, page, assignee);
        for (const item of pageItems) {
          if (item.pull_request !== undefined) {
            continue;
          }
          const issue = normalizeGitHubIssue(repo, item);
          if (!issuesByExternalId.has(issue.external_id)) {
            issuesByExternalId.set(issue.external_id, issue);
          }
        }

        if (pageItems.length < this.pageSize) {
          break;
        }
      }
    }
    return [...issuesByExternalId.values()];
  }

  private async fetchRepoIssuePage(
    repo: GitHubRepoConfig,
    page: number,
    assignee?: string,
  ): Promise<GitHubIssueResponse[]> {
    const params = new URLSearchParams({
      state: "open",
      per_page: String(this.pageSize),
      page: String(page),
    });
    if (this.labels.length > 0) {
      params.set("labels", this.labels.join(","));
    }
    if (assignee !== undefined && assignee !== "") {
      params.set("assignee", assignee);
    }

    const response = await this.fetcher(
      `${this.endpoint}/repos/${encodePathSegment(repo.owner)}/${encodePathSegment(repo.repo)}/issues?${params.toString()}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.options.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    const responseText = await response.text();

    if (response.status === 429) {
      throw new GitHubRateLimitError(parseRetryAfterMs(response.headers.get("Retry-After")));
    }
    if (response.status === 403 && response.headers.get("X-RateLimit-Remaining") === "0") {
      throw new GitHubRateLimitError(parseGitHubRateLimitResetMs(response.headers.get("X-RateLimit-Reset")));
    }
    if (response.status === 401) {
      throw new GitHubAuthError(response.status, responseText);
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`github API error (status ${response.status}): ${truncateBody(responseText)}`);
    }

    const parsed: unknown = JSON.parse(responseText);
    if (!Array.isArray(parsed)) {
      throw new Error("github API issues response must be a JSON array");
    }
    return parsed.flatMap((item) => isRecord(item) ? [itemToGitHubIssueResponse(item)] : []);
  }
}

export async function pollGitHub(invocation: PollerInvocation, fetcher?: Fetcher): Promise<GitHubAdapterResult> {
  const config = githubAdapterConfigFromInvocation(invocation);
  const authFailureMarker = await gitHubAuthFailureMarkerForInvocation(invocation, config);
  if (await hasGitHubAuthFailureMarker(invocation.env, invocation.team.teamId, authFailureMarker)) {
    return {
      teamId: invocation.team.teamId,
      issuesSeen: 0,
      issuesPosted: 0,
    };
  }

  const client = new GitHubClient({
    token: config.token,
    endpoint: config.endpoint,
    repos: config.repos,
    labels: config.labels,
    assignees: config.assignees,
    fetcher,
    pageSize: config.pageSize,
  });

  try {
    const issues = await client.fetchIssues();
    await postIssuesToTeamCoordinator(invocation.env, invocation.team.teamId, issues);
    return {
      teamId: invocation.team.teamId,
      issuesSeen: issues.length,
      issuesPosted: issues.length,
    };
  } catch (error) {
    if (error instanceof GitHubAuthError) {
      await writeGitHubAuthAuditLog(invocation.env, invocation.team.teamId, error, authFailureMarker);
      return {
        teamId: invocation.team.teamId,
        issuesSeen: 0,
        issuesPosted: 0,
      };
    }
    throw error;
  }
}

export const githubAdapter: PollerAdapter = async (invocation) => {
  await pollGitHub(invocation);
};

export function normalizeGitHubIssue(repo: GitHubRepoConfig, item: GitHubIssueResponse): GitHubPollIssue {
  const issueNumber = Number.isFinite(item.number) ? item.number : 0;
  const numberString = String(issueNumber);
  const repository = `${repo.owner}/${repo.repo}`;
  const body = item.body ?? "";
  const modelOverride = parseModelOverride(body);

  return {
    id: numberString,
    external_id: `${repository}#${issueNumber}`,
    identifier: `${repository}#${issueNumber}`,
    title: item.title ?? "",
    description: body,
    state: "unclaimed",
    priority: 0,
    labels: (item.labels ?? []).flatMap((label) => {
      const name = label.name;
      return name === undefined || name === "" ? [] : [name.toLowerCase()];
    }),
    url: item.html_url ?? "",
    branch_name: `symphony/${repo.repo.toLowerCase()}-${issueNumber}`,
    blocked_by: parseDependencies(body),
    ...(modelOverride === "" ? {} : { model_override: modelOverride }),
    ...(item.created_at === undefined ? {} : { created_at: item.created_at }),
    ...(item.updated_at === undefined ? {} : { updated_at: item.updated_at }),
    tracker_meta: {
      provider: "github",
      github_node_id: item.node_id ?? "",
      github_state: item.state ?? "",
      repository,
    },
  };
}

function githubAdapterConfigFromInvocation(invocation: PollerInvocation): GitHubAdapterConfig {
  const trackerYaml = scopedYamlBlock(invocation.team.contentYaml, ["tracker"]);
  const githubYaml = scopedYamlBlock(invocation.team.contentYaml, ["tracker", "github"]);
  const endpoint = firstDefinedScalar(githubYaml, trackerYaml, ["endpoint"])
    ?? DEFAULT_GITHUB_ENDPOINT;
  const pageSize = parsePositiveInt(firstDefinedScalar(githubYaml, trackerYaml, ["page_size", "pageSize"]))
    ?? DEFAULT_PAGE_SIZE;
  const tokenRef = firstDefinedScalar(githubYaml, trackerYaml, ["token", "api_key", "apiKey"]);
  const token = resolveGitHubToken(invocation.env, invocation.team.teamId, tokenRef);
  const repos = parseRepoConfigs(githubYaml, trackerYaml);
  const labels = firstDefinedList(githubYaml, trackerYaml, ["labels", "label"]);
  const assignees = parseAssigneeConfig(githubYaml, trackerYaml);

  if (repos.length === 0) {
    throw new Error(`github tracker config for team ${invocation.team.teamId} requires repo or repos`);
  }

  return { token, endpoint, repos, labels, assignees, pageSize };
}

function parseAssigneeConfig(primary: string[], fallback: string[]): string[] {
  const pluralAssignees = firstDefinedList(primary, fallback, ["assignees"]);
  if (pluralAssignees.length > 0) {
    return dedupeList(pluralAssignees);
  }
  const assignee = firstDefinedScalar(primary, fallback, ["assignee"]);
  return assignee === undefined ? [] : dedupeList(splitListValue(assignee));
}

function parseRepoConfigs(primary: string[], fallback: string[]): GitHubRepoConfig[] {
  const repoValues = firstDefinedList(primary, fallback, ["repos", "repositories"]);
  const repos = repoValues.flatMap(parseRepoSpec);
  if (repos.length > 0) {
    return repos;
  }

  const repo = firstDefinedScalar(primary, fallback, ["repo", "repository"]);
  if (repo !== undefined && repo.includes("/")) {
    return parseRepoSpec(repo);
  }

  const owner = firstDefinedScalar(primary, fallback, ["owner"]);
  if (owner !== undefined && repo !== undefined) {
    return [{ owner, repo }];
  }
  return [];
}

function parseRepoSpec(value: string): GitHubRepoConfig[] {
  return splitListValue(value).flatMap((entry) => {
    const slash = entry.indexOf("/");
    if (slash <= 0 || slash === entry.length - 1) {
      return [];
    }
    return [{ owner: entry.slice(0, slash), repo: entry.slice(slash + 1) }];
  });
}

function resolveGitHubToken(env: PollerEnv, teamId: string, tokenRef: string | undefined): string {
  if (tokenRef !== undefined) {
    if (tokenRef.startsWith("$")) {
      const token = getStringEnv(env, tokenRef.slice(1));
      if (token !== undefined && token !== "") {
        return token;
      }
      throw new Error(`github tracker secret binding not found: ${tokenRef.slice(1)}`);
    }
    throw new Error("github tracker token must reference a secret binding with $NAME");
  }

  const bindingNames = [
    `TRACKER_${bindingSafeTeamId(teamId)}_GITHUB_TOKEN`,
    `TRACKER_${bindingSafeTeamId(teamId)}_GITHUB_PAT`,
    "TRACKER_GITHUB_TOKEN",
    "GITHUB_TOKEN",
  ];
  for (const binding of bindingNames) {
    const token = getStringEnv(env, binding);
    if (token !== undefined && token !== "") {
      return token;
    }
  }
  throw new Error(`github tracker secret binding not found for team ${teamId}`);
}

async function postIssuesToTeamCoordinator(env: PollerEnv, teamId: string, issues: GitHubPollIssue[]): Promise<void> {
  if (issues.length === 0) {
    return;
  }
  if (env.TEAM_COORDINATOR === undefined) {
    throw new Error("TEAM_COORDINATOR binding required for GitHub poller");
  }

  const id = env.TEAM_COORDINATOR.idFromName(teamId);
  const stub = env.TEAM_COORDINATOR.get(id);
  const response = await stub.fetch(new Request("https://team-coordinator.internal/board/refresh", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-contrabass-team-id": teamId,
      "x-contrabass-source": "tracker-poller-github",
    },
    body: JSON.stringify({
      issues: issues.map((issue) => ({
        issueRef: issue.identifier,
        external_id: issue.external_id,
        phase: "open",
        lastUpdated: safeDateParse(issue.updated_at),
        tracker: "github",
        issue,
      })),
    }),
  }));

  if (!response.ok) {
    throw new Error(`TeamCoordinator rejected GitHub issues for team ${teamId}: ${response.status}`);
  }
}

async function gitHubAuthFailureMarkerForInvocation(
  invocation: PollerInvocation,
  config: GitHubAdapterConfig,
): Promise<GitHubAuthFailureMarker> {
  const secretFingerprint = await sha256Hex(config.token);
  const markerFingerprint = await sha256Hex([
    invocation.team.teamId,
    "github",
    invocation.team.contentHash,
    secretFingerprint,
  ].join("\0"));

  return {
    targetId: `tracker/${invocation.team.teamId}/github/auth-failure/${markerFingerprint}`,
    details: {
      markerKey: markerFingerprint,
      teamId: invocation.team.teamId,
      provider: "github",
      contentHash: invocation.team.contentHash,
      secretFingerprint,
      secretTarget: `tracker/${invocation.team.teamId}/github`,
    },
  };
}

async function hasGitHubAuthFailureMarker(
  env: PollerEnv,
  teamId: string,
  marker: GitHubAuthFailureMarker,
): Promise<boolean> {
  if (env.CONTROL_PLANE_DB === undefined) {
    return false;
  }

  const row = await env.CONTROL_PLANE_DB.prepare(`
    SELECT id
    FROM audit_log
    WHERE team_id = ?
      AND actor_type = 'poller'
      AND action = 'tracker.github.auth_error'
      AND target_type = 'tracker_secret'
      AND target_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).bind(teamId, marker.targetId).first<{ id: string }>();
  return row !== null;
}

async function writeGitHubAuthAuditLog(
  env: PollerEnv,
  teamId: string,
  error: GitHubAuthError,
  marker: GitHubAuthFailureMarker,
): Promise<void> {
  if (env.CONTROL_PLANE_DB === undefined) {
    console.error(JSON.stringify({
      event: "github_tracker_auth_error",
      teamId,
      statusCode: error.statusCode,
      message: error.message,
      marker: marker.details,
    }));
    return;
  }

  await env.CONTROL_PLANE_DB.prepare(`
    INSERT INTO audit_log (
      id,
      team_id,
      actor_id,
      actor_type,
      action,
      target_type,
      target_id,
      severity,
      message,
      details
    ) VALUES (?, ?, ?, 'poller', 'tracker.github.auth_error', 'tracker_secret', ?, 'error', ?, ?)
  `).bind(
    `audit_${teamId}_github_auth_${Date.now()}_${crypto.randomUUID()}`,
    teamId,
    "tracker-poller:github",
    marker.targetId,
    "GitHub tracker authentication failed; refresh the team's GitHub secret before the next successful poll",
    JSON.stringify({ ...marker.details, statusCode: error.statusCode, error: error.message }),
  ).run();
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function itemToGitHubIssueResponse(item: Record<string, unknown>): GitHubIssueResponse {
  return {
    number: getNumberField(item, "number") ?? 0,
    ...(getStringField(item, "node_id") === undefined ? {} : { node_id: getStringField(item, "node_id") }),
    ...(getStringField(item, "title") === undefined ? {} : { title: getStringField(item, "title") }),
    ...(getNullableStringField(item, "body") === undefined ? {} : { body: getNullableStringField(item, "body") }),
    ...(getStringField(item, "state") === undefined ? {} : { state: getStringField(item, "state") }),
    labels: extractGitHubLabels(item),
    ...(getStringField(item, "html_url") === undefined ? {} : { html_url: getStringField(item, "html_url") }),
    ...(getStringField(item, "created_at") === undefined ? {} : { created_at: getStringField(item, "created_at") }),
    ...(getStringField(item, "updated_at") === undefined ? {} : { updated_at: getStringField(item, "updated_at") }),
    ...(item.pull_request === undefined ? {} : { pull_request: item.pull_request }),
  };
}

function extractGitHubLabels(item: Record<string, unknown>): Array<{ name?: string }> {
  const labels = item.labels;
  if (!Array.isArray(labels)) {
    return [];
  }
  return labels.flatMap((label) => {
    if (!isRecord(label)) {
      return [];
    }
    const name = getStringField(label, "name");
    return name === undefined ? [{}] : [{ name }];
  });
}

function parseDependencies(body: string): string[] {
  const deps: string[] = [];
  const seen = new Set<string>();
  for (const dependencyLine of body.matchAll(DEPENDENCY_LINE_PATTERN)) {
    const refs = dependencyLine[1] ?? "";
    for (const ref of refs.matchAll(ISSUE_REF_PATTERN)) {
      const id = ref[1] ?? "";
      if (id !== "" && !seen.has(id)) {
        deps.push(id);
        seen.add(id);
      }
    }
  }
  return deps;
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

function parseGitHubRateLimitResetMs(value: string | null): number {
  if (value === null || value === "") {
    return 0;
  }
  const resetSeconds = Number.parseInt(value, 10);
  if (Number.isNaN(resetSeconds)) {
    return 0;
  }
  return Math.max(0, (resetSeconds * 1000) - Date.now());
}

function truncateBody(body: string): string {
  const maxLength = 1000;
  return body.length > maxLength ? `${body.slice(0, maxLength)}...<truncated>` : body;
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}

function safeDateParse(value: string | undefined): number {
  if (value === undefined || value === "") {
    return 0;
  }
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

function firstDefinedList(primary: string[], fallback: string[], keys: string[]): string[] {
  for (const key of keys) {
    const value = yamlListOrScalar(primary, key);
    if (value.length > 0) {
      return value;
    }
  }
  for (const key of keys) {
    const value = yamlListOrScalar(fallback, key);
    if (value.length > 0) {
      return value;
    }
  }
  return [];
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

function yamlListOrScalar(lines: string[], key: string): string[] {
  const scalar = yamlScalar(lines, key);
  if (scalar !== undefined) {
    return splitListValue(scalar);
  }

  const keyLine = findYamlKey(lines, key, -1);
  if (keyLine === undefined) {
    return [];
  }

  return childBlock(lines, keyLine.index, keyLine.indent).flatMap((rawLine) => {
    const trimmed = stripYamlComment(rawLine).trim();
    if (!trimmed.startsWith("- ")) {
      return [];
    }
    return splitListValue(stripYamlQuotes(trimmed.slice(2).trim()));
  });
}

function splitListValue(value: string): string[] {
  const trimmed = value.trim();
  const withoutBrackets = trimmed.startsWith("[") && trimmed.endsWith("]")
    ? trimmed.slice(1, -1)
    : trimmed;
  return withoutBrackets.split(",").map((entry) => stripYamlQuotes(entry.trim())).filter((entry) => entry !== "");
}

function dedupeList(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed !== "" && !seen.has(trimmed)) {
      out.push(trimmed);
      seen.add(trimmed);
    }
  }
  return out;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getStringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

function getNullableStringField(value: Record<string, unknown>, key: string): string | null | undefined {
  const field = value[key];
  return field === null || typeof field === "string" ? field : undefined;
}

function getNumberField(value: Record<string, unknown>, key: string): number | undefined {
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}
