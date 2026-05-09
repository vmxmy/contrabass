import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import type { StateSnapshot, TeamSnapshot } from '../types'
import { CloudDashboardViews } from './CloudDashboardViews'

const originalFetch = globalThis.fetch

function expectInDocument(value: unknown) {
  ;(expect(value) as any).toBeInTheDocument()
}

function emptyState(): StateSnapshot {
  return {
    stats: { Running: 0, MaxAgents: 0, TotalTokensIn: 0, TotalTokensOut: 0, StartTime: '', PollCount: 0 },
    running: [],
    backoff: [],
    issues: {},
    generated_at: '2026-05-09T00:00:00.000Z',
  }
}

function teamSnapshot(): TeamSnapshot {
  return {
    name: 'team-a',
    phase: { phase: 'ready', fix_loop_count: 0, transitions: [], artifacts: {} },
    workers: [],
    tasks: [],
    config: {
      max_workers: 4,
      max_fix_loops: 2,
      claim_lease_seconds: 60,
      state_dir: '.contrabass',
      agent_type: 'codex',
    },
    created_at: '2026-05-09T00:00:00.000Z',
  }
}

afterEach(() => {
  globalThis.fetch = originalFetch
  cleanup()
})

describe('CloudDashboardViews', () => {
  it('fetches selected config versions and renders changed diff lines', async () => {
    const bodies: Record<string, string> = {
      hash1: 'agent_type: codex\nmax_workers: 2\n',
      hash2: 'agent_type: codex\nmax_workers: 4\n',
      hash3: 'agent_type: codex\nmax_workers: 6\n',
    }
    const requests: string[] = []

    globalThis.fetch = ((input: RequestInfo | URL) => {
      const path = String(input)
      requests.push(path)
      if (path === '/v1/teams') {
        return Promise.resolve(Response.json({ teams: [{ id: 'team-a', name: 'Team A' }] }))
      }
      if (path === '/v1/teams/team-a/config/history') {
        return Promise.resolve(Response.json({
          versions: [
            { version: 3, content_hash: 'hash3', created_by: 'mona', created_at: '2026-05-09T03:00:00.000Z' },
            { version: 2, content_hash: 'hash2', created_by: 'mona', created_at: '2026-05-09T02:00:00.000Z' },
            { version: 1, content_hash: 'hash1', created_by: 'mona', created_at: '2026-05-09T01:00:00.000Z' },
          ],
        }))
      }
      const hash = path.split('/').pop() ?? ''
      return Promise.resolve(new Response(bodies[hash] ?? '', { status: bodies[hash] ? 200 : 404 }))
    }) as typeof fetch

    render(
      <CloudDashboardViews
        teamId="team-a"
        view="config"
        state={emptyState()}
        teamSnapshot={teamSnapshot()}
        agentLogs={[]}
        onTeamChange={() => undefined}
        onViewChange={() => undefined}
        onApplyBoardFrame={() => undefined}
      />,
    )

    await waitFor(() => expectInDocument(screen.getByLabelText('Config diff')))

    fireEvent.change(screen.getByLabelText('Config from'), { target: { value: 'hash1' } })
    fireEvent.change(screen.getByLabelText('Config to'), { target: { value: 'hash2' } })

    await waitFor(() => {
      expectInDocument(screen.getByText('- max_workers: 2'))
      expectInDocument(screen.getByText('+ max_workers: 4'))
    })
    expect(requests).toContain('/v1/teams/team-a/config/hash1')
    expect(requests).toContain('/v1/teams/team-a/config/hash2')

  })
})
