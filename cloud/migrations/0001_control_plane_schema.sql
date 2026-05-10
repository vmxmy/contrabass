-- D1 control-plane schema for cloud orchestrator state.
-- Durable Objects own live coordination; D1 stores durable history and cross-DO lookup data.

PRAGMA foreign_keys = ON;

CREATE TABLE team_configs (
  team_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64 AND content_hash = lower(content_hash)),
  content_yaml TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  notes TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (team_id, version),
  UNIQUE (team_id, content_hash),
  UNIQUE (team_id, version, content_hash)
);

CREATE TABLE team_configs_active (
  team_id TEXT PRIMARY KEY,
  active_version INTEGER NOT NULL CHECK (active_version > 0),
  active_content_hash TEXT NOT NULL CHECK (length(active_content_hash) = 64 AND active_content_hash = lower(active_content_hash)),
  activated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  activated_by TEXT NOT NULL,
  FOREIGN KEY (team_id, active_version, active_content_hash)
    REFERENCES team_configs (team_id, version, content_hash)
    ON UPDATE CASCADE
    ON DELETE RESTRICT
);

CREATE TABLE runs (
  run_id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  issue_ref TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed', 'cancelled')),
  summary TEXT NOT NULL DEFAULT '',
  artifact_keys TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(artifact_keys)),
  final_config_hash TEXT NOT NULL CHECK (length(final_config_hash) = 64 AND final_config_hash = lower(final_config_hash)),
  error_class TEXT,
  late_events_count INTEGER NOT NULL DEFAULT 0 CHECK (late_events_count >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (team_id, issue_ref, run_id)
);

CREATE INDEX runs_team_ended_idx ON runs (team_id, ended_at DESC);
CREATE INDEX runs_team_issue_idx ON runs (team_id, issue_ref);
CREATE INDEX runs_team_worker_idx ON runs (team_id, worker_id, ended_at DESC);

CREATE TABLE internal_board (
  team_id TEXT NOT NULL,
  id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  labels TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(labels)),
  status TEXT NOT NULL CHECK (status IN ('todo', 'in_progress', 'retry', 'done')),
  priority INTEGER NOT NULL DEFAULT 0,
  assignee TEXT,
  blockers TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(blockers)),
  parent_id TEXT,
  child_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(child_ids)),
  branch_name TEXT,
  claimed_by TEXT,
  tracker_meta TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(tracker_meta)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (team_id, id),
  UNIQUE (team_id, external_id)
);

CREATE INDEX internal_board_team_status_idx ON internal_board (team_id, status, updated_at DESC);
CREATE INDEX internal_board_team_assignee_idx ON internal_board (team_id, assignee, status);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'worker', 'system', 'poller')),
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  severity TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('debug', 'info', 'warn', 'error')),
  message TEXT NOT NULL DEFAULT '',
  details TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX audit_log_team_created_idx ON audit_log (team_id, created_at DESC);
CREATE INDEX audit_log_team_target_idx ON audit_log (team_id, target_type, target_id, created_at DESC);

CREATE TABLE worker_enrollments (
  enrollment_id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  worker_id TEXT,
  code_hash TEXT NOT NULL UNIQUE,
  refresh_token_hash TEXT UNIQUE,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL,
  redeemed_at TEXT,
  refresh_token_expires_at TEXT,
  revoked_at TEXT,
  revoked_by TEXT,
  capabilities TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(capabilities)),
  worker_version TEXT,
  last_refreshed_at TEXT,
  CHECK (redeemed_at IS NULL OR worker_id IS NOT NULL),
  CHECK (refresh_token_hash IS NULL OR redeemed_at IS NOT NULL)
);

CREATE INDEX worker_enrollments_team_worker_idx ON worker_enrollments (team_id, worker_id);
CREATE INDEX worker_enrollments_team_active_idx ON worker_enrollments (team_id, revoked_at, refresh_token_expires_at);
