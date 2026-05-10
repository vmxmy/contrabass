import { describe, expect, it } from 'bun:test'
import {
  configVersionsFromResponse,
  flattenCloudBoard,
  normalizeCloudBoardSnapshot,
  trackerHealthFromResponse,
} from './cloudModels'

describe('cloud dashboard models', () => {
  it('normalizes TeamCoordinator board payloads with snake_case fields', () => {
    const board = normalizeCloudBoardSnapshot({
      board: {
        open: [{ issue_ref: 'LIN-1', last_updated: '2026-05-09T01:00:00.000Z' }],
        running: [{ issueRef: 'LIN-2', run_id: 'run-2', assigned_worker_id: 'worker-1', lastUpdated: 100 }],
      },
    })

    expect(board.open[0]).toMatchObject({ issueRef: 'LIN-1', phase: 'open' })
    expect(board.running[0]).toMatchObject({ issueRef: 'LIN-2', runId: 'run-2', assignedWorkerId: 'worker-1' })
    expect(flattenCloudBoard(board).map((entry) => entry.issueRef)).toEqual(['LIN-1', 'LIN-2'])
  })

  it('normalizes config history rows from D1-shaped responses', () => {
    expect(
      configVersionsFromResponse({
        versions: [
          {
            version: 3,
            content_hash: 'cfg-3',
            created_by: 'mona',
            created_at: '2026-05-09T02:00:00.000Z',
            notes: 'tighten caps',
            active: true,
          },
        ],
      }),
    ).toEqual([
      {
        version: 3,
        contentHash: 'cfg-3',
        createdBy: 'mona',
        createdAt: '2026-05-09T02:00:00.000Z',
        notes: 'tighten caps',
        active: true,
      },
    ])
  })

  it('normalizes tracker health adapter metrics', () => {
    expect(
      trackerHealthFromResponse({
        adapters: [
          {
            name: 'linear',
            success_rate: 0.98,
            avg_duration_ms: 240,
            issues_seen: 12,
            issues_new: 2,
            issues_updated: 4,
            last_error: 'rate limited',
          },
        ],
      }),
    ).toEqual([
      {
        adapter: 'linear',
        successRate: 0.98,
        avgDurationMs: 240,
        issuesSeen: 12,
        issuesNew: 2,
        issuesUpdated: 4,
        lastError: 'rate limited',
        lastPollAt: undefined,
      },
    ])
  })
})
