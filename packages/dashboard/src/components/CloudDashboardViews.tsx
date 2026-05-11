import { useEffect, useMemo, useState } from 'react'
import { Pulse, GitBranch, ClockCounterClockwise, SquaresFour, ArrowsClockwise, Gear } from '@phosphor-icons/react'
import { Badge, Banner, Button, CodeBlock, Empty, Grid, GridItem, LayerCard, Select, Table, Tabs, Text } from '@cloudflare/kumo'
import type { AgentLogEvent, Issue, RunningEntry, StateSnapshot, TeamSnapshot } from '../types'
import { apiFetch } from '../lib/api'
import {
  configVersionsFromResponse,
  emptyCloudBoardSnapshot,
  flattenCloudBoard,
  normalizeCloudBoardSnapshot,
  trackerHealthFromResponse,
  type CloudBoardEntry,
  type CloudBoardPhase,
  type CloudBoardSnapshot,
  type ConfigVersion,
  type TeamSummary,
  type TrackerAdapterHealth,
} from '../cloudModels'

export type CloudDashboardView = 'board' | 'runs' | 'config' | 'tracker'

interface CloudDashboardViewsProps {
  teamId: string | null
  view: CloudDashboardView
  state: StateSnapshot
  teamSnapshot: TeamSnapshot | null
  agentLogs: AgentLogEvent[]
  onTeamChange: (teamId: string, view?: CloudDashboardView) => void
  onViewChange: (view: CloudDashboardView) => void
  onApplyBoardFrame: (board: CloudBoardSnapshot) => void
}

type LoadState<T> =
  | { status: 'idle'; data: T; error: null }
  | { status: 'loading'; data: T; error: null }
  | { status: 'loaded'; data: T; error: null }
  | { status: 'error'; data: T; error: string }

const VIEW_LABELS: Record<CloudDashboardView, string> = {
  board: 'Board',
  runs: 'Run Detail',
  config: 'Config History',
  tracker: 'Tracker Health',
}

const PHASE_LABELS: Record<CloudBoardPhase, string> = {
  open: 'Open',
  claimed: 'Claimed',
  running: 'Running',
  done: 'Done',
}

function responseError(response: Response): string {
  if (response.status === 404) {
    return 'Endpoint is not available yet'
  }
  return `Request failed (${response.status})`
}

function issueBoardPhase(issue: Issue): CloudBoardPhase | undefined {
  const phase = issue.tracker_meta?.board_phase
  if (phase === 'open' || phase === 'claimed' || phase === 'running' || phase === 'done') {
    return phase
  }
  return undefined
}

function issueBoardEntry(issue: Issue): CloudBoardEntry | null {
  const phase = issueBoardPhase(issue)
  if (!phase) {
    return null
  }

  return {
    issueRef: issue.identifier ?? issue.id,
    runId: typeof issue.tracker_meta?.run_id === 'string' ? issue.tracker_meta.run_id : undefined,
    assignedWorkerId:
      typeof issue.tracker_meta?.assigned_worker_id === 'string' ? issue.tracker_meta.assigned_worker_id : undefined,
    phase,
    lastUpdated: Date.parse(issue.updated_at ?? '') || Date.now(),
    title: issue.title,
    summary: issue.description,
  }
}

function boardFromState(state: StateSnapshot): CloudBoardSnapshot {
  const board = emptyCloudBoardSnapshot()
  for (const issue of Object.values(state.issues ?? {})) {
    const entry = issueBoardEntry(issue)
    if (entry) {
      board[entry.phase].push(entry)
    }
  }
  return board
}

function formatTimestamp(value: string | number | undefined): string {
  if (value === undefined || value === '') {
    return 'never'
  }

  const date = typeof value === 'number' ? new Date(value) : new Date(value)
  if (Number.isNaN(date.getTime())) {
    return String(value)
  }

  return date.toLocaleString()
}

function shortHash(value: string): string {
  return value.length > 12 ? `${value.slice(0, 12)}…` : value
}

function selectedConfigVersion(versions: ConfigVersion[], hash: string | null): ConfigVersion | undefined {
  return versions.find((version) => version.contentHash === hash)
}

async function readConfigBody(response: Response): Promise<string> {
  const text = await response.text()
  try {
    const parsed = JSON.parse(text) as unknown
    if (typeof parsed === 'object' && parsed !== null) {
      const record = parsed as Record<string, unknown>
      const content = record.contentYaml ?? record.content_yaml ?? record.yaml ?? record.content
      if (typeof content === 'string') {
        return content
      }
    }
  } catch {
    return text
  }
  return text
}

type DiffLineKind = 'context' | 'add' | 'remove'

interface DiffLine {
  kind: DiffLineKind
  text: string
}

function unifiedConfigDiff(fromBody: string, toBody: string): DiffLine[] {
  const fromLines = fromBody.split(/\r?\n/u)
  const toLines = toBody.split(/\r?\n/u)
  const lengths = Array.from({ length: fromLines.length + 1 }, () => Array<number>(toLines.length + 1).fill(0))

  for (let left = fromLines.length - 1; left >= 0; left -= 1) {
    for (let right = toLines.length - 1; right >= 0; right -= 1) {
      lengths[left][right] = fromLines[left] === toLines[right]
        ? lengths[left + 1][right + 1] + 1
        : Math.max(lengths[left + 1][right], lengths[left][right + 1])
    }
  }

  const diff: DiffLine[] = []
  let left = 0
  let right = 0
  while (left < fromLines.length && right < toLines.length) {
    if (fromLines[left] === toLines[right]) {
      diff.push({ kind: 'context', text: fromLines[left] })
      left += 1
      right += 1
    } else if (lengths[left + 1][right] >= lengths[left][right + 1]) {
      diff.push({ kind: 'remove', text: fromLines[left] })
      left += 1
    } else {
      diff.push({ kind: 'add', text: toLines[right] })
      right += 1
    }
  }
  while (left < fromLines.length) {
    diff.push({ kind: 'remove', text: fromLines[left] })
    left += 1
  }
  while (right < toLines.length) {
    diff.push({ kind: 'add', text: toLines[right] })
    right += 1
  }
  return diff
}

function teamListFromResponse(value: unknown): TeamSummary[] {
  const teams = typeof value === 'object' && value !== null && 'teams' in value ? (value as { teams?: unknown }).teams : value
  if (!Array.isArray(teams)) {
    return []
  }

  return teams.flatMap((team): TeamSummary[] => {
    if (typeof team === 'string' && team.trim() !== '') {
      return [{ id: team, name: team }]
    }
    if (typeof team !== 'object' || team === null) {
      return []
    }

    const record = team as Record<string, unknown>
    const id = typeof record.id === 'string' ? record.id : typeof record.teamId === 'string' ? record.teamId : undefined
    if (!id) {
      return []
    }
    const name = typeof record.name === 'string' ? record.name : id
    return [{ id, name }]
  })
}

function useTeams(activeTeamId: string | null): LoadState<TeamSummary[]> {
  const [state, setState] = useState<LoadState<TeamSummary[]>>({ status: 'idle', data: [], error: null })

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading', data: activeTeamId ? [{ id: activeTeamId, name: activeTeamId }] : [], error: null })

    apiFetch('/v1/teams')
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(responseError(response))
        }
        const teams = teamListFromResponse(await response.json())
        if (!cancelled) {
          const withActive = activeTeamId && !teams.some((team) => team.id === activeTeamId)
            ? [{ id: activeTeamId, name: activeTeamId }, ...teams]
            : teams
          setState({ status: 'loaded', data: withActive, error: null })
        }
      })
      .catch((error: Error) => {
        if (!cancelled) {
          setState({
            status: 'error',
            data: activeTeamId ? [{ id: activeTeamId, name: activeTeamId }] : [],
            error: error.message,
          })
        }
      })

    return () => {
      cancelled = true
    }
  }, [activeTeamId])

  return state
}

function useBoard(teamId: string | null, fallback: CloudBoardSnapshot, onApplyBoardFrame: (board: CloudBoardSnapshot) => void) {
  const [remote, setRemote] = useState<LoadState<CloudBoardSnapshot>>({ status: 'idle', data: fallback, error: null })

  useEffect(() => {
    setRemote((current) => ({ ...current, data: fallback }))
  }, [fallback])

  async function refresh() {
    if (!teamId) {
      return
    }
    setRemote((current) => ({ status: 'loading', data: current.data, error: null }))
    try {
      const response = await apiFetch(`/v1/teams/${encodeURIComponent(teamId)}/board`)
      if (!response.ok) {
        throw new Error(responseError(response))
      }
      const board = normalizeCloudBoardSnapshot(await response.json())
      setRemote({ status: 'loaded', data: board, error: null })
      onApplyBoardFrame(board)
    } catch (error) {
      setRemote((current) => ({
        status: 'error',
        data: current.data,
        error: error instanceof Error ? error.message : 'Could not load board',
      }))
    }
  }

  useEffect(() => {
    void refresh()
  }, [teamId])

  return { ...remote, refresh }
}

function useConfigHistory(teamId: string | null): LoadState<ConfigVersion[]> {
  const [state, setState] = useState<LoadState<ConfigVersion[]>>({ status: 'idle', data: [], error: null })

  useEffect(() => {
    if (!teamId) {
      setState({ status: 'idle', data: [], error: null })
      return
    }

    let cancelled = false
    setState({ status: 'loading', data: [], error: null })
    apiFetch(`/v1/teams/${encodeURIComponent(teamId)}/config/history`)
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(responseError(response))
        }
        const versions = configVersionsFromResponse(await response.json())
        if (!cancelled) {
          setState({ status: 'loaded', data: versions, error: null })
        }
      })
      .catch((error: Error) => {
        if (!cancelled) {
          setState({ status: 'error', data: [], error: error.message })
        }
      })

    return () => {
      cancelled = true
    }
  }, [teamId])

  return state
}

function useTrackerHealth(teamId: string | null): LoadState<TrackerAdapterHealth[]> {
  const [state, setState] = useState<LoadState<TrackerAdapterHealth[]>>({ status: 'idle', data: [], error: null })

  useEffect(() => {
    if (!teamId) {
      setState({ status: 'idle', data: [], error: null })
      return
    }

    let cancelled = false
    setState({ status: 'loading', data: [], error: null })
    apiFetch(`/v1/teams/${encodeURIComponent(teamId)}/tracker/health`)
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(responseError(response))
        }
        const adapters = trackerHealthFromResponse(await response.json())
        if (!cancelled) {
          setState({ status: 'loaded', data: adapters, error: null })
        }
      })
      .catch((error: Error) => {
        if (!cancelled) {
          setState({ status: 'error', data: [], error: error.message })
        }
      })

    return () => {
      cancelled = true
    }
  }, [teamId])

  return state
}

export function CloudDashboardViews({
  teamId,
  view,
  state,
  teamSnapshot,
  agentLogs,
  onTeamChange,
  onViewChange,
  onApplyBoardFrame,
}: CloudDashboardViewsProps) {
  const teams = useTeams(teamId)
  const fallbackBoard = useMemo(() => boardFromState(state), [state])
  const board = useBoard(teamId, fallbackBoard, onApplyBoardFrame)
  const configHistory = useConfigHistory(view === 'config' ? teamId : null)
  const trackerHealth = useTrackerHealth(view === 'tracker' ? teamId : null)
  const boardEntries = useMemo(() => flattenCloudBoard(board.data), [board.data])
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const selectedRun = useMemo(
    () => boardEntries.find((entry) => entry.runId === selectedRunId) ?? boardEntries.find((entry) => entry.runId),
    [boardEntries, selectedRunId],
  )

  useEffect(() => {
    if (selectedRunId && !boardEntries.some((entry) => entry.runId === selectedRunId)) {
      setSelectedRunId(null)
    }
  }, [boardEntries, selectedRunId])

  if (!teamId) {
    return (
      <LayerCard className="p-4">
        <TeamPicker teams={teams.data} activeTeamId={teamId} onTeamChange={(nextTeamId) => onTeamChange(nextTeamId, 'board')} />
        {teams.error ? <Banner variant="alert" title={`Team list unavailable: ${teams.error}`} /> : null}
        <Text variant="secondary" size="sm">Choose a team to open its cloud dashboard.</Text>
      </LayerCard>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <LayerCard className="p-4">
        <div className="flex flex-wrap items-end gap-3">
          <TeamPicker teams={teams.data} activeTeamId={teamId} onTeamChange={(nextTeamId) => onTeamChange(nextTeamId, 'board')} />
          {teams.error ? <Badge variant="warning">Team list fallback: {teams.error}</Badge> : null}
          <div className="ml-auto">
            <Tabs
              variant="segmented"
              tabs={(Object.keys(VIEW_LABELS) as CloudDashboardView[]).map((item) => ({
                value: item,
                label: VIEW_LABELS[item],
              }))}
              value={view}
              onValueChange={(next) => onViewChange(next as CloudDashboardView)}
            />
          </div>
        </div>
      </LayerCard>

      {view === 'board' ? (
        <CloudBoardPanel board={board.data} boardStatus={board.status} boardError={board.error} onRefresh={board.refresh} onSelectRun={setSelectedRunId} />
      ) : null}
      {view === 'runs' ? <RunDetailPanel entries={boardEntries} selectedRun={selectedRun} running={state.running} logs={agentLogs} onSelectRun={setSelectedRunId} /> : null}
      {view === 'config' ? <ConfigHistoryPanel teamId={teamId} history={configHistory} teamSnapshot={teamSnapshot} /> : null}
      {view === 'tracker' ? <TrackerHealthPanel health={trackerHealth} /> : null}
    </div>
  )
}

function TeamPicker({ teams, activeTeamId, onTeamChange }: { teams: TeamSummary[]; activeTeamId: string | null; onTeamChange: (teamId: string) => void }) {
  const options = teams.length > 0 ? teams : activeTeamId ? [{ id: activeTeamId, name: activeTeamId }] : []

  return (
    <Select
      label="Team"
      value={activeTeamId ?? ''}
      onValueChange={(value) => onTeamChange(String(value))}
      placeholder="Select a team"
    >
      {activeTeamId ? null : <Select.Option value="">Select a team</Select.Option>}
      {options.map((team) => (
        <Select.Option key={team.id} value={team.id}>
          {team.name}
        </Select.Option>
      ))}
    </Select>
  )
}

function CloudBoardPanel({
  board,
  boardStatus,
  boardError,
  onRefresh,
  onSelectRun,
}: {
  board: CloudBoardSnapshot
  boardStatus: LoadState<CloudBoardSnapshot>['status']
  boardError: string | null
  onRefresh: () => Promise<void>
  onSelectRun: (runId: string | null) => void
}) {
  return (
    <LayerCard className="min-h-0 flex-1 overflow-hidden p-4">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <SquaresFour />
        <div className="min-w-0 flex-1">
          <Text variant="heading3" as="h3">Team board</Text>
          <Text variant="secondary" size="sm">Open, claimed, running, and done issue runs from TeamCoordinator.</Text>
        </div>
        <Button type="button" size="sm" variant="secondary" icon={ArrowsClockwise} onClick={() => void onRefresh()}>
          Refresh
        </Button>
      </div>
      {boardStatus === 'error' && boardError ? <Banner variant="error" title={boardError} /> : null}
      <Grid variant="4up" gap="sm" className="min-h-0 overflow-auto">
        {(Object.keys(PHASE_LABELS) as CloudBoardPhase[]).map((phase) => (
          <GridItem key={phase}>
            <LayerCard className="h-full p-3">
              <div className="mb-3 flex items-center justify-between gap-2">
                <Text variant="heading3" as="h4">{PHASE_LABELS[phase]}</Text>
                <Badge variant="secondary">{board[phase].length}</Badge>
              </div>
              <div className="grid gap-2">
                {board[phase].length === 0 ? <Text variant="secondary" size="sm">No issues</Text> : null}
                {board[phase].map((entry) => (
                  <Button
                    key={`${phase}:${entry.issueRef}:${entry.runId ?? 'no-run'}`}
                    type="button"
                    variant="secondary"
                    onClick={() => onSelectRun(entry.runId ?? null)}
                  >
                    {entry.issueRef} · {entry.title ?? entry.issueRef} · {entry.runId ? `run ${entry.runId}` : 'not dispatched'}
                  </Button>
                ))}
              </div>
            </LayerCard>
          </GridItem>
        ))}
      </Grid>
    </LayerCard>
  )
}

function RunDetailPanel({
  entries,
  selectedRun,
  running,
  logs,
  onSelectRun,
}: {
  entries: CloudBoardEntry[]
  selectedRun: CloudBoardEntry | undefined
  running: RunningEntry[]
  logs: AgentLogEvent[]
  onSelectRun: (runId: string | null) => void
}) {
  const activeRuns = entries.filter((entry) => entry.runId)
  const runningRow = selectedRun?.runId ? running.find((entry) => entry.session_id === selectedRun.runId || entry.issue_id === selectedRun.issueRef) : undefined
  const visibleLogs = selectedRun?.assignedWorkerId ? logs.filter((log) => log.worker_id === selectedRun.assignedWorkerId).slice(-12) : logs.slice(-12)

  return (
    <section className="grid min-h-0 flex-1 gap-4 overflow-hidden lg:grid-cols-2">
      <LayerCard className="overflow-auto p-4">
        <div className="mb-3 flex items-center gap-2">
          <GitBranch />
          <Text variant="heading3" as="h3">Runs</Text>
        </div>
        <div className="grid gap-2">
          {activeRuns.length === 0 ? <Empty size="sm" title="No active or historical run IDs on the board yet." /> : null}
          {activeRuns.map((entry) => (
            <Button
              key={`${entry.issueRef}:${entry.runId}`}
              type="button"
              variant={selectedRun?.runId === entry.runId ? 'primary' : 'secondary'}
              onClick={() => onSelectRun(entry.runId ?? null)}
            >
              {entry.runId} · {entry.issueRef} · {PHASE_LABELS[entry.phase]}
            </Button>
          ))}
        </div>
      </LayerCard>
      <LayerCard className="min-h-0 overflow-auto p-5">
        <Text variant="heading3" as="h3">Run detail</Text>
        {!selectedRun ? <Text variant="secondary" size="sm">Select a run to inspect its worker, phase, and recent events.</Text> : null}
        {selectedRun ? (
          <div className="mt-4 grid gap-4">
            <Grid variant="4up" gap="sm">
              <GridItem><DetailItem label="Issue" value={selectedRun.issueRef} /></GridItem>
              <GridItem><DetailItem label="Run" value={selectedRun.runId ?? 'not dispatched'} /></GridItem>
              <GridItem><DetailItem label="Worker" value={selectedRun.assignedWorkerId ?? 'unassigned'} /></GridItem>
              <GridItem><DetailItem label="Phase" value={PHASE_LABELS[selectedRun.phase]} /></GridItem>
              <GridItem><DetailItem label="Updated" value={formatTimestamp(selectedRun.lastUpdated)} /></GridItem>
              <GridItem><DetailItem label="Activity" value={runningRow?.last_activity_kind ?? 'no activity'} /></GridItem>
              <GridItem><DetailItem label="Tokens in" value={runningRow?.tokens_in ?? 0} /></GridItem>
              <GridItem><DetailItem label="Tokens out" value={runningRow?.tokens_out ?? 0} /></GridItem>
            </Grid>
            <LayerCard className="p-4">
              <Text variant="heading3" as="h4">Recent worker events</Text>
              {visibleLogs.length === 0 ? <Text variant="secondary" size="sm">No log, tool, or error events received yet.</Text> : null}
              <div className="grid gap-2">
                {visibleLogs.map((log) => (
                  <Text key={`${log.timestamp}:${log.worker_id}:${log.line}`} variant="mono-secondary">
                    {formatTimestamp(log.timestamp)} {log.worker_id} {log.stream}: {log.line}
                  </Text>
                ))}
              </div>
            </LayerCard>
          </div>
        ) : null}
      </LayerCard>
    </section>
  )
}

function DetailItem({ label, value }: { label: string; value: string | number }) {
  return (
    <LayerCard className="p-3">
      <Text variant="secondary" size="sm">{label}</Text>
      <Text variant="mono" truncate>{value}</Text>
    </LayerCard>
  )
}

function diffLinesToText(lines: DiffLine[]): string {
  return lines.map((line) => `${line.kind === 'add' ? '+ ' : line.kind === 'remove' ? '- ' : '  '}${line.text || ' '}`).join('\n')
}

function ConfigHistoryPanel({ teamId, history, teamSnapshot }: { teamId: string; history: LoadState<ConfigVersion[]>; teamSnapshot: TeamSnapshot | null }) {
  const [fromHash, setFromHash] = useState<string | null>(null)
  const [toHash, setToHash] = useState<string | null>(null)
  const [diffState, setDiffState] = useState<LoadState<DiffLine[]>>({ status: 'idle', data: [], error: null })
  const fromVersion = selectedConfigVersion(history.data, fromHash)
  const toVersion = selectedConfigVersion(history.data, toHash)

  useEffect(() => {
    const hashes = history.data.map((version) => version.contentHash)
    if (hashes.length === 0) {
      setFromHash(null)
      setToHash(null)
      return
    }
    setFromHash((current) => current && hashes.includes(current) ? current : hashes[Math.min(1, hashes.length - 1)])
    setToHash((current) => current && hashes.includes(current) ? current : hashes[0])
  }, [history.data])

  useEffect(() => {
    if (!fromHash || !toHash) {
      setDiffState({ status: 'idle', data: [], error: null })
      return
    }

    let cancelled = false
    setDiffState((current) => ({ status: 'loading', data: current.data, error: null }))
    Promise.all([fromHash, toHash].map(async (hash) => {
      const response = await apiFetch(`/v1/teams/${encodeURIComponent(teamId)}/config/${encodeURIComponent(hash)}`)
      if (!response.ok) {
        throw new Error(responseError(response))
      }
      return readConfigBody(response)
    }))
      .then(([fromBody, toBody]) => {
        if (!cancelled) {
          setDiffState({ status: 'loaded', data: unifiedConfigDiff(fromBody, toBody), error: null })
        }
      })
      .catch((error: Error) => {
        if (!cancelled) {
          setDiffState({ status: 'error', data: [], error: error.message })
        }
      })

    return () => {
      cancelled = true
    }
  }, [teamId, fromHash, toHash])

  return (
    <LayerCard className="min-h-0 flex-1 overflow-auto p-5">
      <div className="mb-4 flex items-center gap-3">
        <ClockCounterClockwise />
        <div>
          <Text variant="heading3" as="h3">Config history</Text>
          <Text variant="secondary" size="sm">Versions, authors, timestamps, notes, and active usage caps.</Text>
        </div>
      </div>
      {history.status === 'error' && history.error ? <Banner variant="alert" title={history.error} /> : null}
      <Grid variant="3up" gap="sm" className="mb-4">
        <GridItem><DetailItem label="Max workers" value={teamSnapshot?.config.max_workers ?? 0} /></GridItem>
        <GridItem><DetailItem label="Lease seconds" value={teamSnapshot?.config.claim_lease_seconds ?? 0} /></GridItem>
        <GridItem><DetailItem label="Agent type" value={teamSnapshot?.config.agent_type || 'unknown'} /></GridItem>
      </Grid>
      <LayerCard className="mb-4 p-4">
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <Select label="Config from" value={fromHash ?? ''} onValueChange={(value) => setFromHash(String(value) || null)}>
            {history.data.map((version) => (
              <Select.Option key={`from:${version.contentHash}`} value={version.contentHash}>
                v{version.version} {shortHash(version.contentHash)}
              </Select.Option>
            ))}
          </Select>
          <Select label="Config to" value={toHash ?? ''} onValueChange={(value) => setToHash(String(value) || null)}>
            {history.data.map((version) => (
              <Select.Option key={`to:${version.contentHash}`} value={version.contentHash}>
                v{version.version} {shortHash(version.contentHash)}
              </Select.Option>
            ))}
          </Select>
          <Text variant="secondary" size="sm">
            {fromVersion && toVersion ? `Diff v${fromVersion.version} to v${toVersion.version}` : 'Select two versions to diff'}
          </Text>
        </div>
        {diffState.status === 'error' && diffState.error ? <Banner variant="alert" title={diffState.error} /> : null}
        {history.data.length < 2 ? <Text variant="secondary" size="sm">At least two config versions are required to render a diff.</Text> : null}
        {history.data.length >= 2 ? (
          <div aria-label="Config diff">
            <CodeBlock
              lang="bash"
              code={
                diffState.status === 'loading' && diffState.data.length === 0
                  ? 'Loading config diff…'
                  : diffState.status !== 'loading' && diffState.data.length === 0 && !diffState.error
                    ? 'No changes between selected versions.'
                    : diffLinesToText(diffState.data)
              }
            />
          </div>
        ) : null}
      </LayerCard>
      {history.data.length === 0 ? <Text variant="secondary" size="sm">No config versions returned yet. Task 9 API endpoints can populate this panel later.</Text> : null}
      <LayerCard className="overflow-x-auto p-0">
        <Table>
          <Table.Header>
            <Table.Row>
              <Table.Head>Version</Table.Head>
              <Table.Head>Hash</Table.Head>
              <Table.Head>Author</Table.Head>
              <Table.Head>Created</Table.Head>
              <Table.Head>Notes</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {history.data.map((version) => (
              <Table.Row key={`${version.version}:${version.contentHash}`}>
                <Table.Cell>v{version.version}{version.active ? ' · active' : ''}</Table.Cell>
                <Table.Cell>{shortHash(version.contentHash)}</Table.Cell>
                <Table.Cell>{version.createdBy}</Table.Cell>
                <Table.Cell>{formatTimestamp(version.createdAt)}</Table.Cell>
                <Table.Cell>{version.notes ?? '—'}</Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      </LayerCard>
    </LayerCard>
  )
}

function TrackerHealthPanel({ health }: { health: LoadState<TrackerAdapterHealth[]> }) {
  return (
    <LayerCard className="min-h-0 flex-1 overflow-auto p-5">
      <div className="mb-4 flex items-center gap-3">
        <Pulse />
        <div>
          <Text variant="heading3" as="h3">Tracker health</Text>
          <Text variant="secondary" size="sm">Last 24h adapter duration, success rate, issue counts, and errors.</Text>
        </div>
      </div>
      {health.status === 'error' && health.error ? <Banner variant="alert" title={health.error} /> : null}
      {health.data.length === 0 ? <Text variant="secondary" size="sm">No tracker metrics returned yet. Task 10 observability can populate this panel later.</Text> : null}
      <Grid variant="3up" gap="sm">
        {health.data.map((adapter) => (
          <GridItem key={adapter.adapter}>
            <LayerCard className="p-4">
              <div className="mb-3 flex items-center gap-2">
                <Gear />
                <Text variant="heading3" as="h4">{adapter.adapter}</Text>
              </div>
              <Grid variant="2up" gap="sm">
                <GridItem><DetailItem label="Success" value={`${Math.round(adapter.successRate * 100)}%`} /></GridItem>
                <GridItem><DetailItem label="Avg ms" value={adapter.avgDurationMs} /></GridItem>
                <GridItem><DetailItem label="Seen" value={adapter.issuesSeen} /></GridItem>
                <GridItem><DetailItem label="Updated" value={adapter.issuesUpdated} /></GridItem>
              </Grid>
              <Text variant="secondary" size="sm">Last poll: {formatTimestamp(adapter.lastPollAt)}</Text>
              {adapter.lastError ? <Banner variant="error" title={adapter.lastError} /> : null}
            </LayerCard>
          </GridItem>
        ))}
      </Grid>
    </LayerCard>
  )
}
