import { Liquid } from "liquidjs";
import { isMap, parseDocument } from "yaml";

export type ConfigValidationDetail = {
  path: string;
  message: string;
};

export type ParseConfigOptions = {
  boundSecrets?: readonly string[];
};

export type ParsedWorkflowConfig = {
  promptTemplate: string;
  frontMatter: Record<string, unknown>;
};

const ENV_REF_PATTERN = /^\$([A-Za-z_][A-Za-z0-9_]*)$/u;
const ALLOWED_TRACKER_TYPES = new Set(["", "internal", "local", "linear", "github"]);
const ALLOWED_LINEAR_SYNC_MODES = new Set(["", "reply_thread", "top_level"]);
const ALLOWED_WORKER_MODES = new Set(["", "tmux", "goroutine"]);
const liquidEngine = new Liquid();

export function parseWorkflowConfig(content: string, options: ParseConfigOptions = {}): ParsedWorkflowConfig {
  const split = splitFrontMatter(content);
  const promptTemplate = split.prompt.trim();
  const liquidDetails = validateLiquidTemplates(promptTemplate);

  if (!split.hasFrontMatter) {
    if (liquidDetails.length > 0) {
      throw configParseError(liquidDetails);
    }
    return { promptTemplate, frontMatter: {} };
  }

  if (split.frontMatter.trim() === "") {
    const details = [...liquidDetails];
    if (!split.terminated) {
      details.push({ path: "$", message: "unterminated front matter" });
    }
    if (details.length > 0) {
      throw configParseError(details);
    }
    return { promptTemplate, frontMatter: {} };
  }

  const document = parseDocument(split.frontMatter, { prettyErrors: false });
  if (document.errors.length > 0) {
    throw configParseError(document.errors.map((error) => ({
      path: "$",
      message: `invalid workflow yaml: ${error.message}`,
    })));
  }
  if (!isMap(document.contents)) {
    throw configParseError([{ path: "$", message: "workflow front matter must be a map" }]);
  }

  const frontMatter = getRecord(document.toJSON());
  if (frontMatter === undefined) {
    throw configParseError([{ path: "$", message: "workflow front matter must be a map" }]);
  }
  const details = [
    ...validateWorkflowConfig(frontMatter, options),
    ...liquidDetails,
  ];
  if (!split.terminated) {
    details.push({ path: "$", message: "unterminated front matter" });
  }
  if (details.length > 0) {
    throw configParseError(details);
  }

  return { promptTemplate, frontMatter };
}

export function configParseError(details: ConfigValidationDetail[]): Error & { details: ConfigValidationDetail[] } {
  const error = new Error("config_invalid") as Error & { details: ConfigValidationDetail[] };
  error.details = details;
  return error;
}

export function isConfigParseError(error: unknown): error is Error & { details: ConfigValidationDetail[] } {
  const details = getErrorDetails(error);
  return error instanceof Error
    && details !== undefined
    && details.every(isValidationDetail);
}

function splitFrontMatter(content: string): {
  frontMatter: string;
  prompt: string;
  hasFrontMatter: boolean;
  terminated: boolean;
} {
  if (!content.startsWith("---")) {
    return { frontMatter: "", prompt: content, hasFrontMatter: false, terminated: false };
  }

  if (content.length > 3) {
    const next = content.charAt(3);
    if (next !== "\n" && next !== "\r") {
      return { frontMatter: "", prompt: content, hasFrontMatter: false, terminated: false };
    }
  }

  const startOffset = content.startsWith("---\r\n") ? 5 : 4;
  if (content.length <= startOffset) {
    return { frontMatter: "", prompt: "", hasFrontMatter: true, terminated: true };
  }

  const remainder = content.slice(startOffset);
  const lines = remainder.match(/[^\n]*\n|[^\n]+/gu) ?? [];
  let offset = 0;
  let frontMatter = "";

  for (const line of lines) {
    offset += line.length;
    if (line.replace(/[\r\n]+$/u, "") === "---") {
      return {
        frontMatter,
        prompt: remainder.slice(offset),
        hasFrontMatter: true,
        terminated: true,
      };
    }
    frontMatter += line;
  }

  return { frontMatter, prompt: "", hasFrontMatter: true, terminated: false };
}

function validateWorkflowConfig(frontMatter: Record<string, unknown>, options: ParseConfigOptions): ConfigValidationDetail[] {
  const details: ConfigValidationDetail[] = [];
  const tracker = getRecord(frontMatter.tracker);
  const trackerType = getString(tracker?.type)?.trim().toLowerCase() ?? "";
  const boundSecrets = new Set(options.boundSecrets ?? []);

  if (!ALLOWED_TRACKER_TYPES.has(trackerType)) {
    details.push({ path: "tracker.type", message: `unknown tracker type: ${String(tracker?.type)}` });
  }

  const tokenSecret = getEnvReference(getString(tracker?.token));
  if (tokenSecret !== undefined && !boundSecrets.has(tokenSecret)) {
    details.push({ path: `tracker.${trackerType === "" ? "token" : `${trackerType}.token`}`, message: `secret not bound: ${tokenSecret}` });
  }

  const linear = getRecord(frontMatter.linear);
  const syncComments = getRecord(linear?.sync_comments);
  const syncEnabled = syncComments?.enabled === true;
  const mode = getString(syncComments?.mode)?.trim().toLowerCase() ?? "";
  if (trackerType === "linear" && syncEnabled && !ALLOWED_LINEAR_SYNC_MODES.has(mode)) {
    details.push({ path: "linear.sync_comments.mode", message: "invalid linear.sync_comments.mode" });
  }

  const team = getRecord(frontMatter.team);
  const workerMode = getString(team?.worker_mode)?.trim().toLowerCase() ?? "";
  if (!ALLOWED_WORKER_MODES.has(workerMode)) {
    details.push({ path: "team.worker_mode", message: `unknown worker_mode: ${String(team?.worker_mode)} (valid values: goroutine, tmux)` });
  }

  return details;
}

function validateLiquidTemplates(promptTemplate: string): ConfigValidationDetail[] {
  try {
    liquidEngine.parse(promptTemplate);
    return [];
  } catch (error) {
    return [{ path: "prompt", message: `invalid liquid template: ${getErrorMessage(error)}` }];
  }
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getEnvReference(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return ENV_REF_PATTERN.exec(value)?.[1];
}

function isValidationDetail(value: unknown): value is ConfigValidationDetail {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.path === "string" && typeof record.message === "string";
}

function getErrorDetails(error: unknown): unknown[] | undefined {
  if (error === null || typeof error !== "object" || Array.isArray(error)) {
    return undefined;
  }
  const details = (error as { details?: unknown }).details;
  return Array.isArray(details) ? details : undefined;
}
