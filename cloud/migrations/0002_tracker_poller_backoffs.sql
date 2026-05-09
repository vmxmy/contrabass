-- Durable per-team Retry-After state for the scheduled tracker poller.

PRAGMA foreign_keys = ON;

CREATE TABLE tracker_poller_backoffs (
  team_id TEXT PRIMARY KEY,
  retry_at_ms INTEGER NOT NULL CHECK (retry_at_ms >= 0),
  adapter TEXT NOT NULL CHECK (adapter IN ('linear', 'github', 'internal-board')),
  backoff_count INTEGER NOT NULL DEFAULT 1 CHECK (backoff_count > 0),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (team_id)
    REFERENCES team_configs_active (team_id)
    ON UPDATE CASCADE
    ON DELETE CASCADE
);

CREATE INDEX tracker_poller_backoffs_retry_idx ON tracker_poller_backoffs (retry_at_ms);
