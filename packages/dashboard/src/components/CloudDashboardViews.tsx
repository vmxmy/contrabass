import { useEffect, useMemo, useState } from 'react'
import { Activity, GitBranch, History, LayoutDashboard, RefreshCw, ServerCog } from 'lucide-react'
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
            data: activeTeamId ? [{ id: activeTeamId, name: activeTeamId }] : [{ id: 'synthetic-smoke', name: 'synthetic-smoke' }],
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
      <div className="rounded-3xl border border-border/70 bg-card/80 p-6 shadow-lg">
        <TeamPicker teams={teams.data} activeTeamId={teamId} onTeamChange={(nextTeamId) => onTeamChange(nextTeamId, 'board')} />
        <p className="mt-4 text-sm text-muted-foreground">Choose a team to open its cloud dashboard.</p>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <section className="rounded-3xl border border-border/70 bg-card/80 p-4 shadow-lg">
        <div className="flex flex-wrap items-center gap-3">
          <TeamPicker teams={teams.data} activeTeamId={teamId} onTeamChange={(nextTeamId) => onTeamChange(nextTeamId, 'board')} />
          {teams.error ? <span className="text-xs text-muted-foreground">Team list fallback: {teams.error}</span> : null}
          <div className="ml-auto flex flex-wrap gap-2">
            {(Object.keys(VIEW_LABELS) as CloudDashboardView[]).map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => onViewChange(item)}
                className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition ${view === item ? 'border-primary bg-primary text-primary-foreground' : 'border-border/70 bg-background/50 text-muted-foreground hover:text-foreground'}`}
              >
                {VIEW_LABELS[item]}
              </button>
            ))}
          </div>
        </div>
      </section>

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
    <label className="flex items-center gap-2 text-sm font-medium text-foreground">
      Team
      <select
        value={activeTeamId ?? ''}
        onChange={(event) => onTeamChange(event.target.value)}
        className="rounded-xl border border-border/70 bg-background/70 px-3 py-2 text-sm text-foreground shadow-xs"
      >
        {activeTeamId ? null : <option value="">Select a team</option>}
        {options.map((team) => (
          <option key={team.id} value={team.id}>
            {team.name}
          </option>
        ))}
      </select>
    </label>
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
    <section className="min-h-0 flex-1 overflow-hidden rounded-3xl border border-border/70 bg-card/80 p-4 shadow-lg">
      <div className="mb-4 flex items-center gap-3">
        <LayoutDashboard className="h-5 w-5 text-primary" />
        <div>
          <h3 className="text-base font-semibold">Team board</h3>
          <p className="text-xs text-muted-foreground">Open, claimed, running, and done issue runs from TeamCoordinator.</p>
        </div>
        <button type="button" onClick={() => void onRefresh()} className="ml-auto inline-flex items-center gap-2 rounded-full border border-border/70 bg-background/50 px-3 py-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground">
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
        </button>
      </div>
      {boardStatus === 'error' && boardError ? <p className="mb-3 rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">{boardError}</p> : null}
      <div className="grid min-h-0 grid-cols-1 gap-3 overflow-auto xl:grid-cols-4">
        {(Object.keys(PHASE_LABELS) as CloudBoardPhase[]).map((phase) => (
          <div key={phase} className="rounded-2xl border border-border/70 bg-background/35 p-3">
            <div className="mb-3 flex items-center justify-between">
              <h4 className="text-sm font-semibold">{PHASE_LABELS[phase]}</h4>
              <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-xs text-muted-foreground">{board[phase].length}</span>
            </div>
            <div className="space-y-2">
              {board[phase].length === 0 ? <p className="text-xs text-muted-foreground">No issues</p> : null}
              {board[phase].map((entry) => (
                <button
                  key={`${phase}:${entry.issueRef}:${entry.runId ?? 'no-run'}`}
                  type="button"
                  onClick={() => onSelectRun(entry.runId ?? null)}
                  className="w-full rounded-2xl border border-border/60 bg-card/70 p-3 text-left shadow-xs transition hover:-translate-y-0.5 hover:border-primary/70"
                >
                  <p className="font-mono text-xs text-primary">{entry.issueRef}</p>
                  <p className="mt-1 line-clamp-2 text-sm font-semibold">{entry.title ?? entry.issueRef}</p>
                  <p className="mt-2 text-xs text-muted-foreground">{entry.runId ? `run ${entry.runId}` : 'not dispatched'}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{entry.assignedWorkerId ?? 'unassigned'} · {formatTimestamp(entry.lastUpdated)}</p>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
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
    <section className="grid min-h-0 flex-1 gap-4 overflow-hidden lg:grid-cols-[20rem_minmax(0,1fr)]">
      <div className="overflow-auto rounded-3xl border border-border/70 bg-card/80 p-4 shadow-lg">
        <div className="mb-3 flex items-center gap-2">
          <GitBranch className="h-5 w-5 text-primary" />
          <h3 className="text-base font-semibold">Runs</h3>
        </div>
        <div className="space-y-2">
          {activeRuns.length === 0 ? <p className="text-sm text-muted-foreground">No active or historical run IDs on the board yet.</p> : null}
          {activeRuns.map((entry) => (
            <button key={`${entry.issueRef}:${entry.runId}`} type="button" onClick={() => onSelectRun(entry.runId ?? null)} className={`w-full rounded-2xl border p-3 text-left text-sm transition ${selectedRun?.runId === entry.runId ? 'border-primary bg-primary/10' : 'border-border/70 bg-background/35 hover:border-primary/70'}`}>
              <span className="font-mono text-xs text-primary">{entry.runId}</span>
              <span className="mt-1 block font-semibold">{entry.issueRef}</span>
              <span className="text-xs text-muted-foreground">{PHASE_LABELS[entry.phase]}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="min-h-0 overflow-auto rounded-3xl border border-border/70 bg-card/80 p-5 shadow-lg">
        <h3 className="text-base font-semibold">Run detail</h3>
        {!selectedRun ? <p className="mt-3 text-sm text-muted-foreground">Select a run to inspect its worker, phase, and recent events.</p> : null}
        {selectedRun ? (
          <div className="mt-4 space-y-4">
            <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <DetailItem label="Issue" value={selectedRun.issueRef} />
              <DetailItem label="Run" value={selectedRun.runId ?? 'not dispatched'} />
              <DetailItem label="Worker" value={selectedRun.assignedWorkerId ?? 'unassigned'} />
              <DetailItem label="Phase" value={PHASE_LABELS[selectedRun.phase]} />
              <DetailItem label="Updated" value={formatTimestamp(selectedRun.lastUpdated)} />
              <DetailItem label="Activity" value={runningRow?.last_activity_kind ?? 'no activity'} />
              <DetailItem label="Tokens in" value={runningRow?.tokens_in ?? 0} />
              <DetailItem label="Tokens out" value={runningRow?.tokens_out ?? 0} />
            </dl>
            <div className="rounded-2xl border border-border/70 bg-background/35 p-4">
              <h4 className="mb-3 text-sm font-semibold">Recent worker events</h4>
              {visibleLogs.length === 0 ? <p className="text-sm text-muted-foreground">No log, tool, or error events received yet.</p> : null}
              <div className="space-y-2 font-mono text-xs">
                {visibleLogs.map((log) => (
                  <p key={`${log.timestamp}:${log.worker_id}:${log.line}`} className="rounded-xl bg-card/70 px-3 py-2 text-muted-foreground">
                    <span className="text-primary">{formatTimestamp(log.timestamp)}</span> {log.worker_id} {log.stream}: {log.line}
                  </p>
                ))}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  )
}

function DetailItem({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-2xl border border-border/70 bg-background/35 p-3">
      <dt className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">{label}</dt>
      <dd className="mt-2 break-words font-mono text-sm text-foreground">{value}</dd>
    </div>
  )
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
    <section className="min-h-0 flex-1 overflow-auto rounded-3xl border border-border/70 bg-card/80 p-5 shadow-lg">
      <div className="mb-4 flex items-center gap-3">
        <History className="h-5 w-5 text-primary" />
        <div>
          <h3 className="text-base font-semibold">Config history</h3>
          <p className="text-xs text-muted-foreground">Versions, authors, timestamps, notes, and active usage caps.</p>
        </div>
      </div>
      {history.status === 'error' && history.error ? <p className="mb-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">{history.error}</p> : null}
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <DetailItem label="Max workers" value={teamSnapshot?.config.max_workers ?? 0} />
        <DetailItem label="Lease seconds" value={teamSnapshot?.config.claim_lease_seconds ?? 0} />
        <DetailItem label="Agent type" value={teamSnapshot?.config.agent_type || 'unknown'} />
      </div>
      <div className="mb-4 rounded-2xl border border-border/70 bg-background/35 p-4">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm font-medium">
            Config from
            <select
              value={fromHash ?? ''}
              onChange={(event) => setFromHash(event.target.value || null)}
              className="rounded-xl border border-border/70 bg-background/70 px-3 py-2 font-mono text-xs text-foreground shadow-xs"
            >
              {history.data.map((version) => (
                <option key={`from:${version.contentHash}`} value={version.contentHash}>
                  v{version.version} {shortHash(version.contentHash)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm font-medium">
            Config to
            <select
              value={toHash ?? ''}
              onChange={(event) => setToHash(event.target.value || null)}
              className="rounded-xl border border-border/70 bg-background/70 px-3 py-2 font-mono text-xs text-foreground shadow-xs"
            >
              {history.data.map((version) => (
                <option key={`to:${version.contentHash}`} value={version.contentHash}>
                  v{version.version} {shortHash(version.contentHash)}
                </option>
              ))}
            </select>
          </label>
          <p className="text-xs text-muted-foreground">
            {fromVersion && toVersion ? `Diff v${fromVersion.version} to v${toVersion.version}` : 'Select two versions to diff'}
          </p>
        </div>
        {diffState.status === 'error' && diffState.error ? <p className="mb-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">{diffState.error}</p> : null}
        {history.data.length < 2 ? <p className="text-sm text-muted-foreground">At least two config versions are required to render a diff.</p> : null}
        {history.data.length >= 2 ? (
          <pre aria-label="Config diff" className="max-h-96 overflow-auto rounded-xl bg-card/70 p-3 font-mono text-xs leading-6">
            {diffState.status === 'loading' && diffState.data.length === 0 ? <span className="text-muted-foreground">Loading config diff…</span> : null}
            {diffState.status !== 'loading' && diffState.data.length === 0 && !diffState.error ? <span className="text-muted-foreground">No changes between selected versions.</span> : null}
            {diffState.data.map((line, index) => (
              <span
                key={`${index}:${line.kind}:${line.text}`}
                className={`block whitespace-pre-wrap ${line.kind === 'add' ? 'text-emerald-300' : line.kind === 'remove' ? 'text-rose-300' : 'text-muted-foreground'}`}
              >
                {line.kind === 'add' ? '+ ' : line.kind === 'remove' ? '- ' : '  '}{line.text || ' '}
              </span>
            ))}
          </pre>
        ) : null}
      </div>
      {history.data.length === 0 ? <p className="text-sm text-muted-foreground">No config versions returned yet. Task 9 API endpoints can populate this panel later.</p> : null}
      <div className="overflow-x-auto rounded-2xl border border-border/70">
        <table className="w-full min-w-[760px] border-collapse text-sm">
          <thead className="bg-background/50 text-left text-xs uppercase tracking-[0.16em] text-muted-foreground">
            <tr>
              <th className="px-3 py-2">Version</th>
              <th className="px-3 py-2">Hash</th>
              <th className="px-3 py-2">Author</th>
              <th className="px-3 py-2">Created</th>
              <th className="px-3 py-2">Notes</th>
            </tr>
          </thead>
          <tbody>
            {history.data.map((version) => (
              <tr key={`${version.version}:${version.contentHash}`} className="border-t border-border/70">
                <td className="px-3 py-2 font-mono">v{version.version}{version.active ? ' · active' : ''}</td>
                <td className="px-3 py-2 font-mono text-primary">{shortHash(version.contentHash)}</td>
                <td className="px-3 py-2">{version.createdBy}</td>
                <td className="px-3 py-2">{formatTimestamp(version.createdAt)}</td>
                <td className="px-3 py-2 text-muted-foreground">{version.notes ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function TrackerHealthPanel({ health }: { health: LoadState<TrackerAdapterHealth[]> }) {
  return (
    <section className="min-h-0 flex-1 overflow-auto rounded-3xl border border-border/70 bg-card/80 p-5 shadow-lg">
      <div className="mb-4 flex items-center gap-3">
        <Activity className="h-5 w-5 text-primary" />
        <div>
          <h3 className="text-base font-semibold">Tracker health</h3>
          <p className="text-xs text-muted-foreground">Last 24h adapter duration, success rate, issue counts, and errors.</p>
        </div>
      </div>
      {health.status === 'error' && health.error ? <p className="mb-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">{health.error}</p> : null}
      {health.data.length === 0 ? <p className="text-sm text-muted-foreground">No tracker metrics returned yet. Task 10 observability can populate this panel later.</p> : null}
      <div className="grid gap-3 lg:grid-cols-3">
        {health.data.map((adapter) => (
          <article key={adapter.adapter} className="rounded-2xl border border-border/70 bg-background/35 p-4">
            <div className="mb-3 flex items-center gap-2">
              <ServerCog className="h-4 w-4 text-primary" />
              <h4 className="font-semibold">{adapter.adapter}</h4>
            </div>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <DetailItem label="Success" value={`${Math.round(adapter.successRate * 100)}%`} />
              <DetailItem label="Avg ms" value={adapter.avgDurationMs} />
              <DetailItem label="Seen" value={adapter.issuesSeen} />
              <DetailItem label="Updated" value={adapter.issuesUpdated} />
            </dl>
            <p className="mt-3 text-xs text-muted-foreground">Last poll: {formatTimestamp(adapter.lastPollAt)}</p>
            {adapter.lastError ? <p className="mt-2 rounded-xl bg-destructive/10 px-3 py-2 text-xs text-destructive">{adapter.lastError}</p> : null}
          </article>
        ))}
      </div>
    </section>
  )
}
