#!/usr/bin/env node
// Helper for the litellm-portal long-term roadmap stored as Plane issues.
//
// Maps CONTRABASS-N sequence IDs to issues; resolves openspec-change dependencies
// for blocked/start commands; flips Plane state and prepares git branches.
//
// Usage:
//   plane-issue list
//   plane-issue info    CONTRABASS-N
//   plane-issue blocked CONTRABASS-N
//   plane-issue start   CONTRABASS-N       (interactive: creates git branch)
//   plane-issue done    CONTRABASS-N       (interactive: prints archive cmd)
//
// Requires: PLANE_API_KEY env var (PLANE_BASE_URL defaults to https://plane.ziikoo.com).

import { execSync, spawnSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WORKSPACE = "ziikoo";
const PROJECT_ID = "268c17c6-9399-4bdc-a335-68a7ee6eda6a";
const STATES = {
  Backlog: "98ee3422-ac9e-4ee3-a426-3fadbda26886",
  Todo: "b75ec74f-2b94-4da4-af1a-80fc353dbe03",
  "In Progress": "8b01cb03-b377-4bf0-9987-9206bd9eea15",
  Done: "1c9aaec0-ff95-4993-9f52-54a5017c17ee",
  Cancelled: "e51ebd22-7b7f-4ec6-b006-be8e035a3ba4",
};
const STATE_ID_TO_NAME = Object.fromEntries(Object.entries(STATES).map(([k, v]) => [v, k]));

const PRIORITY_RANK = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CLOUD_ROOT = resolve(SCRIPT_DIR, "..");
const CHANGES_DIR = resolve(CLOUD_ROOT, "src/litellm-portal/openspec/changes");
const ARCHIVE_DIR = resolve(CHANGES_DIR, "archive");

const API_KEY = process.env.PLANE_API_KEY;
const BASE = (process.env.PLANE_BASE_URL || "https://plane.ziikoo.com").replace(/\/$/, "");

if (!API_KEY) {
  fail("PLANE_API_KEY env var is not set. Source ~/.zshrc or export it manually.");
}

const args = process.argv.slice(2);
const cmd = args[0];

const dispatch = {
  list: cmdList,
  info: cmdInfo,
  blocked: cmdBlocked,
  start: cmdStart,
  done: cmdDone,
};

if (!cmd || !dispatch[cmd]) {
  printUsage();
  process.exit(cmd ? 1 : 0);
}

try {
  await dispatch[cmd](args.slice(1));
} catch (err) {
  fail(err.message);
}

// ---------- commands ----------

async function cmdList() {
  const issues = await fetchAllIssues();
  const labels = await fetchLabels();
  const sorted = issues
    .filter((i) => /^\[P\d-/.test(i.name))
    .sort((a, b) => a.sequence_id - b.sequence_id);

  const groups = new Map();
  for (const it of sorted) {
    const stateName = STATE_ID_TO_NAME[it.state] || "?";
    if (!groups.has(stateName)) groups.set(stateName, []);
    groups.get(stateName).push(it);
  }

  const order = ["In Progress", "Backlog", "Todo", "Done", "Cancelled"];
  for (const state of order) {
    const items = groups.get(state);
    if (!items?.length) continue;
    console.log(`\n=== ${state} (${items.length}) ===`);
    for (const it of items) {
      const labelNames = (it.label_ids || []).map((id) => labels[id]?.name).filter(Boolean).join(",");
      const prio = (it.priority || "-").padEnd(7);
      const seq = `CONTRABASS-${it.sequence_id}`.padEnd(15);
      const tag = labelNames ? `[${labelNames}] ` : "";
      console.log(`  ${seq} ${prio} ${tag}${it.name.slice(0, 90)}`);
    }
  }
  console.log();
}

async function cmdInfo([key]) {
  const issue = await resolveIssue(key);
  const change = changeFromIssueName(issue.name);
  const stateName = STATE_ID_TO_NAME[issue.state] || "?";
  console.log(`\nCONTRABASS-${issue.sequence_id}  state=${stateName}  priority=${issue.priority}`);
  console.log(`  ${issue.name}`);
  console.log(`  ${issueUrl(issue.id)}`);
  if (change) {
    console.log(`  openspec: ${changeRelPath(change.slug)}`);
    console.log(`  depends_on: ${change.depends.length ? change.depends.join(", ") : "(none)"}`);
  }
  console.log();
}

async function cmdBlocked([key]) {
  const issue = await resolveIssue(key);
  const change = changeFromIssueName(issue.name);
  if (!change) fail(`Cannot find openspec change for ${issue.name}`);

  if (!change.depends.length) {
    console.log(`\nCONTRABASS-${issue.sequence_id} has no upstream dependencies. Ready to start.`);
    return;
  }

  const allIssues = await fetchAllIssues();
  const bySlug = indexBySlug(allIssues);
  console.log(`\nDependencies for CONTRABASS-${issue.sequence_id} (${change.slug}):`);
  let blocking = 0;
  for (const dep of change.depends) {
    const depIssue = bySlug.get(dep);
    if (!depIssue) {
      console.log(`  ?  ${dep}  (no matching Plane issue)`);
      blocking += 1;
      continue;
    }
    const stateName = STATE_ID_TO_NAME[depIssue.state] || "?";
    const ok = stateName === "Done";
    console.log(`  ${ok ? "✓" : "✗"} CONTRABASS-${depIssue.sequence_id} (${stateName})  ${dep}`);
    if (!ok) blocking += 1;
  }
  console.log();
  if (blocking > 0) {
    fail(`${blocking} unmet dependency/dependencies. Finish those first or override manually.`);
  } else {
    console.log("All dependencies satisfied. Ready to start.\n");
  }
}

async function cmdStart([key]) {
  const issue = await resolveIssue(key);
  const change = changeFromIssueName(issue.name);
  if (!change) fail(`Cannot find openspec change for ${issue.name}`);

  // Dependency gate (warn but allow override with --force)
  const allIssues = await fetchAllIssues();
  const bySlug = indexBySlug(allIssues);
  const blockers = change.depends.filter((d) => {
    const di = bySlug.get(d);
    return !di || STATE_ID_TO_NAME[di.state] !== "Done";
  });
  if (blockers.length && !process.argv.includes("--force")) {
    console.error(`\nBlocked by: ${blockers.join(", ")}`);
    fail("Pass --force to start anyway.");
  }

  // 1. Plane state → In Progress
  await patchIssue(issue.id, { state: STATES["In Progress"] });
  console.log(`✓ Plane: CONTRABASS-${issue.sequence_id} → In Progress`);

  // 2. git branch
  const branch = `feat/CONTRABASS-${issue.sequence_id}-${change.slug.replace(/^p\d-\d+-/, "")}`;
  const repoRoot = git("rev-parse --show-toplevel").trim();
  console.log(`\nNext git steps from ${repoRoot}:`);
  console.log(`  git fetch origin main`);
  console.log(`  git switch -c ${branch} origin/main`);
  console.log(`\nOpenSpec:`);
  console.log(`  $EDITOR ${changeRelPath(change.slug)}/tasks.md`);
  console.log(`\nWhen done:`);
  console.log(`  plane-issue done CONTRABASS-${issue.sequence_id}`);
  console.log();
}

async function cmdDone([key]) {
  const issue = await resolveIssue(key);
  const change = changeFromIssueName(issue.name);

  await patchIssue(issue.id, { state: STATES.Done });
  console.log(`✓ Plane: CONTRABASS-${issue.sequence_id} → Done`);

  if (change) {
    const today = new Date().toISOString().slice(0, 10);
    const archiveName = `${today}-${change.slug}`;
    const src = `src/litellm-portal/openspec/changes/${change.slug}`;
    const dst = `src/litellm-portal/openspec/changes/archive/${archiveName}`;
    console.log(`\nArchive the openspec change:`);
    console.log(`  git mv ${src} ${dst}`);
    console.log(`  git commit -m "chore(litellm-portal): archive ${change.slug}"`);
  }
  console.log();
}

// ---------- helpers ----------

async function fetchAllIssues() {
  const out = [];
  let cursor = null;
  for (;;) {
    const url = `${BASE}/api/v1/workspaces/${WORKSPACE}/projects/${PROJECT_ID}/issues/?per_page=100${cursor ? `&cursor=${cursor}` : ""}`;
    const body = await api("GET", url);
    out.push(...(body.results || []));
    if (!body.next_page_results) break;
    cursor = body.next_cursor;
  }
  return out;
}

async function fetchLabels() {
  const url = `${BASE}/api/v1/workspaces/${WORKSPACE}/projects/${PROJECT_ID}/labels/?per_page=100`;
  const body = await api("GET", url);
  return Object.fromEntries((body.results || []).map((l) => [l.id, l]));
}

async function patchIssue(id, fields) {
  await api(
    "PATCH",
    `${BASE}/api/v1/workspaces/${WORKSPACE}/projects/${PROJECT_ID}/issues/${id}/`,
    fields,
  );
}

async function api(method, url, body) {
  const init = {
    method,
    headers: {
      "x-api-key": API_KEY,
      "Content-Type": "application/json",
      "User-Agent": "curl/8.7.1",
      Accept: "application/json",
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const r = await fetch(url, init);
  const text = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status} ${method} ${url}\n${text}`);
  return text ? JSON.parse(text) : {};
}

async function resolveIssue(key) {
  if (!key) fail("Missing issue key (e.g. CONTRABASS-2)");
  const m = String(key).match(/^(?:CONTRABASS-)?(\d+)$/i);
  if (!m) fail(`Invalid issue key: ${key}`);
  const seq = Number(m[1]);
  const all = await fetchAllIssues();
  const match = all.find((i) => i.sequence_id === seq);
  if (!match) fail(`CONTRABASS-${seq} not found in project.`);
  return match;
}

function changeFromIssueName(name) {
  // e.g. "[P0-01] 删除 ..." → tag P0-01 → match dir starting with "p0-01-"
  const m = name.match(/^\[(P\d-\d+)\]/);
  if (!m) return null;
  const tag = m[1].toLowerCase();
  const dirs = readdirSync(CHANGES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== "archive")
    .map((d) => d.name);
  const slug = dirs.find((d) => d.startsWith(tag + "-"));
  if (!slug) return null;
  const yaml = readFileSync(resolve(CHANGES_DIR, slug, ".openspec.yaml"), "utf8");
  const depends = parseDependsOn(yaml);
  return { slug, depends };
}

function parseDependsOn(yaml) {
  const m = yaml.match(/^depends_on:\s*\[([^\]]*)\]/m);
  if (!m) return [];
  return m[1].split(",").map((s) => s.trim()).filter(Boolean);
}

function indexBySlug(issues) {
  const map = new Map();
  for (const it of issues) {
    const m = it.name.match(/^\[(P\d-\d+)\]/);
    if (!m) continue;
    const tag = m[1].toLowerCase();
    const dirs = readdirSync(CHANGES_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== "archive")
      .map((d) => d.name);
    const slug = dirs.find((d) => d.startsWith(tag + "-"));
    if (slug) map.set(slug, it);
  }
  return map;
}

function issueUrl(id) {
  return `${BASE}/${WORKSPACE}/projects/${PROJECT_ID}/issues/${id}`;
}

function changeRelPath(slug) {
  return `cloud/src/litellm-portal/openspec/changes/${slug}`;
}

function git(cmdline) {
  return execSync(`git ${cmdline}`, { stdio: ["ignore", "pipe", "pipe"] }).toString();
}

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function printUsage() {
  console.log(`plane-issue — helper for the litellm-portal Plane roadmap

usage:
  plane-issue list                          list all issues grouped by state
  plane-issue info    CONTRABASS-N          show issue summary + openspec deps
  plane-issue blocked CONTRABASS-N          show dependency state
  plane-issue start   CONTRABASS-N [--force] flip to In Progress, print git steps
  plane-issue done    CONTRABASS-N          flip to Done, print archive cmd

env:
  PLANE_API_KEY   required
  PLANE_BASE_URL  default https://plane.ziikoo.com
`);
}
