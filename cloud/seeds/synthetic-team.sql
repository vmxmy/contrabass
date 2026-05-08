-- Seed data for the synthetic smoke-test team.
-- Apply after migrations with:
--   wrangler d1 execute CONTROL_PLANE_DB --file ./seeds/synthetic-team.sql --local
-- Use --remote or --env staging for deployed smoke-test environments.

PRAGMA foreign_keys = ON;

INSERT INTO team_configs (
  team_id,
  version,
  content_hash,
  content_yaml,
  created_by,
  created_at,
  notes
) VALUES (
  'synthetic-smoke',
  1,
  'aecbbf93a6e73ac3096465fadd6eb0c074e06ca8de54f966a66599796e4f9bad',
  '---
max_concurrency: 2
poll_interval_ms: 10000
max_retry_backoff_ms: 30000
model: mock
agent_timeout_ms: 120000
stall_timeout_ms: 30000
tracker:
  type: internal
  board_dir: .contrabass/board
  issue_prefix: SMOKE
agent:
  type: mock
workspace:
  base_dir: /tmp/contrabass-smoke
  branch_prefix: smoke/
team:
  max_workers: 2
  max_fix_loops: 1
  execution_mode: team
  worker_mode: goroutine
---
# Synthetic Smoke Workflow

Issue title: {{ issue.title }}
Issue body: {{ issue.description }}

Complete the synthetic smoke-test issue and report a concise summary.
',
  'system:seed',
  '2026-05-08T00:00:00.000Z',
  'synthetic team config for cloud smoke tests'
)
ON CONFLICT (team_id, version) DO UPDATE SET
  content_hash = excluded.content_hash,
  content_yaml = excluded.content_yaml,
  created_by = excluded.created_by,
  created_at = excluded.created_at,
  notes = excluded.notes;

INSERT INTO team_configs_active (
  team_id,
  active_version,
  active_content_hash,
  activated_at,
  activated_by
) VALUES (
  'synthetic-smoke',
  1,
  'aecbbf93a6e73ac3096465fadd6eb0c074e06ca8de54f966a66599796e4f9bad',
  '2026-05-08T00:00:00.000Z',
  'system:seed'
)
ON CONFLICT (team_id) DO UPDATE SET
  active_version = excluded.active_version,
  active_content_hash = excluded.active_content_hash,
  activated_at = excluded.activated_at,
  activated_by = excluded.activated_by;

INSERT INTO internal_board (
  team_id,
  id,
  external_id,
  title,
  body,
  labels,
  status,
  priority,
  assignee,
  blockers,
  parent_id,
  child_ids,
  branch_name,
  claimed_by,
  tracker_meta,
  created_at,
  updated_at
) VALUES (
  'synthetic-smoke',
  'SMOKE-1',
  'internal:synthetic-smoke:SMOKE-1',
  'Run synthetic cloud smoke test',
  'Synthetic issue used by smoke tests to verify register, dispatch, ack, events, completion, and board update plumbing.',
  '["smoke","synthetic"]',
  'todo',
  100,
  NULL,
  '[]',
  NULL,
  '[]',
  'smoke/synthetic-cloud-smoke-test',
  NULL,
  '{"source":"seed","smoke":true}',
  '2026-05-08T00:00:00.000Z',
  '2026-05-08T00:00:00.000Z'
)
ON CONFLICT (team_id, id) DO UPDATE SET
  external_id = excluded.external_id,
  title = excluded.title,
  body = excluded.body,
  labels = excluded.labels,
  status = excluded.status,
  priority = excluded.priority,
  assignee = excluded.assignee,
  blockers = excluded.blockers,
  parent_id = excluded.parent_id,
  child_ids = excluded.child_ids,
  branch_name = excluded.branch_name,
  claimed_by = excluded.claimed_by,
  tracker_meta = excluded.tracker_meta,
  created_at = excluded.created_at,
  updated_at = excluded.updated_at;

INSERT INTO worker_enrollments (
  enrollment_id,
  team_id,
  worker_id,
  code_hash,
  refresh_token_hash,
  created_by,
  created_at,
  expires_at,
  redeemed_at,
  refresh_token_expires_at,
  revoked_at,
  revoked_by,
  capabilities,
  worker_version,
  last_refreshed_at
) VALUES (
  'enroll_synthetic_smoke_mock_worker',
  'synthetic-smoke',
  NULL,
  '4c06aa2fe446a90f9963980f7f968552af7f3182f6a44d492aeb88357e0decab',
  NULL,
  'system:seed',
  '2026-05-08T00:00:00.000Z',
  '2036-05-08T00:00:00.000Z',
  NULL,
  NULL,
  NULL,
  NULL,
  '[{"kind":"agent","name":"mock"},{"kind":"execution","name":"local"}]',
  NULL,
  NULL
)
ON CONFLICT (enrollment_id) DO UPDATE SET
  team_id = excluded.team_id,
  worker_id = excluded.worker_id,
  code_hash = excluded.code_hash,
  refresh_token_hash = excluded.refresh_token_hash,
  created_by = excluded.created_by,
  created_at = excluded.created_at,
  expires_at = excluded.expires_at,
  redeemed_at = excluded.redeemed_at,
  refresh_token_expires_at = excluded.refresh_token_expires_at,
  revoked_at = excluded.revoked_at,
  revoked_by = excluded.revoked_by,
  capabilities = excluded.capabilities,
  worker_version = excluded.worker_version,
  last_refreshed_at = excluded.last_refreshed_at;

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
  details,
  created_at
) VALUES (
  'audit_synthetic_smoke_seed_v1',
  'synthetic-smoke',
  'system:seed',
  'system',
  'seed.synthetic_team',
  'team',
  'synthetic-smoke',
  'info',
  'Seeded synthetic smoke-test team',
  '{"configVersion":1,"boardIssue":"SMOKE-1","enrollmentId":"enroll_synthetic_smoke_mock_worker"}',
  '2026-05-08T00:00:00.000Z'
)
ON CONFLICT (id) DO UPDATE SET
  team_id = excluded.team_id,
  actor_id = excluded.actor_id,
  actor_type = excluded.actor_type,
  action = excluded.action,
  target_type = excluded.target_type,
  target_id = excluded.target_id,
  severity = excluded.severity,
  message = excluded.message,
  details = excluded.details,
  created_at = excluded.created_at;
