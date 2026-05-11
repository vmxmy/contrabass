import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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

async function openKumoSelect(label: string): Promise<HTMLElement> {
  const trigger = screen.getByRole('combobox', { name: label })
  fireEvent.click(trigger)
  return await waitFor(() => {
    const id = trigger.getAttribute('aria-controls')
    const controlled = id ? document.getElementById(id) : null
    if (!controlled) {
      throw new Error(`Kumo select listbox for ${label} did not open`)
    }
    return controlled as HTMLElement
  })
}

async function selectKumoOption(label: string, optionName: string | RegExp) {
  const listbox = await openKumoSelect(label)
  const option = within(listbox).getByRole('option', { name: optionName })
  fireEvent.mouseMove(option)
  fireEvent.mouseOver(option)
  fireEvent.mouseDown(option)
  fireEvent.mouseUp(option)
  fireEvent.click(option)
}

afterEach(() => {
  globalThis.fetch = originalFetch
  cleanup()
})

describe('CloudDashboardViews', () => {
  it('renders the team picker and routes selection to the board view', async () => {
    const changes: Array<{ teamId: string; view: string | undefined }> = []

    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        if (String(input) === '/v1/teams') {
          return Response.json({ teams: [{ id: 'team-a', name: 'Team A' }, { id: 'team-b', name: 'Team B' }] })
        }
        return new Response('not found', { status: 404 })
      },
      { preconnect: originalFetch.preconnect },
    )

    render(
      <CloudDashboardViews
        teamId={null}
        view="board"
        state={emptyState()}
        teamSnapshot={teamSnapshot()}
        agentLogs={[]}
        onTeamChange={(teamId, view) => changes.push({ teamId, view })}
        onViewChange={() => undefined}
        onApplyBoardFrame={() => undefined}
      />,
    )

    await selectKumoOption('Team', 'Team B')

    await waitFor(() => {
      expect(changes).toEqual([{ teamId: 'team-b', view: 'board' }])
    })
  })

  it('does not synthesize a smoke team when the team list is unavailable', async () => {
    const requests: string[] = []

    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        requests.push(String(input))
        return new Response('unauthorized', { status: 401 })
      },
      { preconnect: originalFetch.preconnect },
    )

    render(
      <CloudDashboardViews
        teamId={null}
        view="board"
        state={emptyState()}
        teamSnapshot={teamSnapshot()}
        agentLogs={[]}
        onTeamChange={() => undefined}
        onViewChange={() => undefined}
        onApplyBoardFrame={() => undefined}
      />,
    )

    await waitFor(() => expect(requests).toContain('/v1/teams'))
    await waitFor(() => expectInDocument(screen.getByText(/Team list unavailable: Request failed \(401\)/u)))
    const listbox = await openKumoSelect('Team')
    expect(within(listbox).queryByRole('option', { name: 'synthetic-smoke' })).toBeNull()
  })

  it('loads the active team board and forwards the snapshot into the SPA state', async () => {
    const requests: string[] = []
    const boardFrames: unknown[] = []

    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const path = String(input)
        requests.push(path)
        if (path === '/v1/teams') {
          return Response.json({ teams: [{ id: 'team-a', name: 'Team A' }] })
        }
        if (path === '/v1/teams/team-a/board') {
          return Response.json({
            board: {
              open: [
                {
                  issue_ref: 'CLOUD-7',
                  title: 'Reconnect dashboard',
                  last_updated: '2026-05-09T00:00:00.000Z',
                },
              ],
              claimed: [],
              running: [
                {
                  issueRef: 'CLOUD-8',
                  runId: 'run-8',
                  assignedWorkerId: 'local-1',
                  lastUpdated: 1_777_766_400_000,
                },
              ],
              done: [],
            },
          })
        }
        return new Response('not found', { status: 404 })
      },
      { preconnect: originalFetch.preconnect },
    )

    render(
      <CloudDashboardViews
        teamId="team-a"
        view="board"
        state={emptyState()}
        teamSnapshot={teamSnapshot()}
        agentLogs={[]}
        onTeamChange={() => undefined}
        onViewChange={() => undefined}
        onApplyBoardFrame={(board) => boardFrames.push(board)}
      />,
    )

    await waitFor(() => expectInDocument(screen.getByText(/CLOUD-7/u)))
    expectInDocument(screen.getByText(/Reconnect dashboard/u))
    expectInDocument(screen.getByText(/run run-8/u))
    expect(requests).toContain('/v1/teams/team-a/board')
    expect(boardFrames).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: /Refresh/u }))
    await waitFor(() => expect(requests.filter((path) => path === '/v1/teams/team-a/board')).toHaveLength(2))
  })

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

    await selectKumoOption('Config from', /v1 hash1/u)
    await selectKumoOption('Config to', /v2 hash2/u)

    await waitFor(() => {
      const diff = screen.getByLabelText('Config diff')
      expect(diff.textContent).toContain('- max_workers: 2')
      expect(diff.textContent).toContain('+ max_workers: 4')
    })
    expect(requests).toContain('/v1/teams/team-a/config/hash1')
    expect(requests).toContain('/v1/teams/team-a/config/hash2')

  })
})
