import { useCallback, useEffect, useReducer, useRef } from 'react'
import type {
  AgentLogEvent,
  BackoffEntry,
  BoardEvent,
  BoardIssue,
  Issue,
  OrchestratorEvent,
  RunningEntry,
  StateSnapshot,
  Stats,
  TeamSnapshot,
  TeamTask,
  WebEvent,
  WorkerState,
} from '../types'
import { zhCN } from '../i18n/messages'
import { apiFetch, createApiEventSource } from '../lib/api'
import type { DashboardSubscriptionFrame } from './useTeamSubscription'

export interface SSEState {
  state: StateSnapshot | null
  connected: boolean
  error: string | null
  teamSnapshot: TeamSnapshot | null
  boardIssues: BoardIssue[]
  agentLogs: AgentLogEvent[]
  queueEvents: QueueEventPayload[]
  dashboardWorkers: Record<string, DashboardWorkerLoad>
}

export type SSEAction =
  | { type: 'snapshot'; data: StateSnapshot }
  | { type: 'web_event'; data: WebEvent }
  | { type: 'dashboard_frame'; data: DashboardSubscriptionFrame }
  | { type: 'connected' }
  | { type: 'disconnected' }
  | { type: 'error'; message: string }

interface TeamEventPayload {
  type: string
  team_name: string
  data: Record<string, unknown>
  timestamp: string
}

interface StatusUpdateData {
  Stats: Stats
}

interface AgentStartedData {
  Attempt: number
  PID: number
  SessionID: string
  Workspace: string
}

interface BackoffEnqueuedData {
  Attempt: number
  RetryAt: string
  Error: string
}

interface IssueReleasedData {
  Attempt: number
}

export interface QueueEventPayload {
  issue_id: string
  identifier: string
  blockers: string
}

interface TeamCoordinatorBoardEntry {
  issueRef: string
  runId?: string
  assignedWorkerId?: string
  phase: string
  lastUpdated: number
}

interface WorkerStatusFrameWorker {
  workerId: string
  capabilities?: string[]
  maxConcurrency?: number
  currentLoad?: number
  lastHeartbeatTs?: number
  kind?: string
  version?: string
  status?: string
}

interface DashboardWorkerLoad {
  currentLoad: number
  maxConcurrency: number
}

const DASHBOARD_SUBSCRIPTION_SOURCE = 'dashboard-subscription'

export const INITIAL_STATE: SSEState = {
  state: null,
  connected: false,
  error: null,
  teamSnapshot: null,
  boardIssues: [],
  agentLogs: [],
  queueEvents: [],
  dashboardWorkers: {},
}

const EMPTY_TEAM_SNAPSHOT: TeamSnapshot = {
  name: '',
  phase: {
    phase: '',
    fix_loop_count: 0,
    transitions: [],
    artifacts: {},
  },
  workers: [],
  tasks: [],
  config: {
    max_workers: 0,
    max_fix_loops: 0,
    claim_lease_seconds: 0,
    state_dir: '',
    agent_type: '',
  },
  created_at: '',
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return {}
  }

  return value as Record<string, unknown>
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asTimestamp(value: unknown): string {
  const millis = asNumber(value)
  if (millis !== undefined) {
    return new Date(millis).toISOString()
  }
  return new Date().toISOString()
}

function emptySnapshot(timestamp: string): StateSnapshot {
  return {
    stats: {
      Running: 0,
      MaxAgents: 0,
      TotalTokensIn: 0,
      TotalTokensOut: 0,
      StartTime: timestamp,
      PollCount: 0,
    },
    running: [],
    backoff: [],
    issues: {},
    generated_at: timestamp,
  }
}

function isWebEvent(value: unknown): value is WebEvent {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const candidate = value as Partial<WebEvent>
  return (
    typeof candidate.kind === 'string' &&
    typeof candidate.type === 'string' &&
    'payload' in candidate &&
    typeof candidate.timestamp === 'string'
  )
}

function isOrchestratorEvent(value: unknown): value is OrchestratorEvent {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const candidate = value as Partial<OrchestratorEvent>
  return (
    typeof candidate.Type === 'number' &&
    typeof candidate.IssueID === 'string' &&
    'Data' in candidate &&
    typeof candidate.Timestamp === 'string'
  )
}

function asTeamSnapshot(snapshot: TeamSnapshot | null): TeamSnapshot {
  if (!snapshot) {
    return { ...EMPTY_TEAM_SNAPSHOT, phase: { ...EMPTY_TEAM_SNAPSHOT.phase }, config: { ...EMPTY_TEAM_SNAPSHOT.config } }
  }

  return snapshot
}

function issueStateForBoardPhase(phase: string): string {
  switch (phase) {
    case 'done':
      return 'Done'
    case 'claimed':
    case 'running':
    case 'open':
    default:
      return 'Todo'
  }
}

function numericStateForBoardPhase(phase: string): number {
  switch (phase) {
    case 'claimed':
      return 1
    case 'running':
      return 2
    case 'done':
      return 3
    case 'open':
    default:
      return 0
  }
}

function isDashboardSubscriptionIssue(issue: Issue | undefined): boolean {
  return issue?.tracker_meta?.source === DASHBOARD_SUBSCRIPTION_SOURCE
}

function boardEntriesFromFrame(frame: DashboardSubscriptionFrame): TeamCoordinatorBoardEntry[] {
  const board = asRecord(frame.board)
  const phases = ['open', 'claimed', 'running', 'done']

  return phases.flatMap((phase) => {
    const entries = board[phase]
    if (!Array.isArray(entries)) {
      return []
    }

    return entries.flatMap((entry): TeamCoordinatorBoardEntry[] => {
      const record = asRecord(entry)
      const issueRef = asString(record.issueRef) ?? asString(record.issue_ref) ?? asString(record.id)
      if (!issueRef) {
        return []
      }

      return [
        {
          issueRef,
          runId: asString(record.runId) ?? asString(record.run_id),
          assignedWorkerId:
            asString(record.assignedWorkerId) ??
            asString(record.assigned_worker_id) ??
            asString(record.workerId) ??
            asString(record.worker_id),
          phase: asString(record.phase) ?? phase,
          lastUpdated: asNumber(record.lastUpdated) ?? asNumber(record.last_updated) ?? Date.now(),
        },
      ]
    })
  })
}

function issueFromBoardEntry(entry: TeamCoordinatorBoardEntry, existing?: Issue): Issue {
  const timestamp = asTimestamp(entry.lastUpdated)
  const linearState = issueStateForBoardPhase(entry.phase)

  return {
    id: existing?.id ?? entry.issueRef,
    identifier: existing?.identifier ?? entry.issueRef,
    title: existing?.title ?? entry.issueRef,
    description: existing?.description ?? '',
    state: numericStateForBoardPhase(entry.phase),
    priority: existing?.priority,
    labels: existing?.labels ?? [],
    url: existing?.url ?? '',
    branch_name: existing?.branch_name,
    blocked_by: existing?.blocked_by,
    created_at: existing?.created_at ?? timestamp,
    updated_at: timestamp,
    tracker_meta: {
      ...(existing?.tracker_meta ?? {}),
      source: DASHBOARD_SUBSCRIPTION_SOURCE,
      linear_state: linearState,
      board_phase: entry.phase,
      run_id: entry.runId,
      assigned_worker_id: entry.assignedWorkerId,
    },
  }
}

function runningFromBoardEntry(entry: TeamCoordinatorBoardEntry): RunningEntry {
  const timestamp = asTimestamp(entry.lastUpdated)

  return {
    issue_id: entry.issueRef,
    attempt: 0,
    pid: 0,
    session_id: entry.runId ?? entry.issueRef,
    workspace: DASHBOARD_SUBSCRIPTION_SOURCE,
    started_at: timestamp,
    phase: numericStateForBoardPhase(entry.phase),
    tokens_in: 0,
    tokens_out: 0,
    phase_label: entry.phase,
    last_activity_at: timestamp,
    last_activity_kind: entry.assignedWorkerId ? `assigned to ${entry.assignedWorkerId}` : entry.phase,
    diff_status: 'ok',
  }
}

function applyDashboardBoardUpdate(state: SSEState, frame: DashboardSubscriptionFrame): SSEState {
  const timestamp = new Date().toISOString()
  const snapshot = state.state ?? emptySnapshot(timestamp)
  const entries = boardEntriesFromFrame(frame)
  const incomingIssueRefs = new Set(entries.map((entry) => entry.issueRef))
  const issues = Object.fromEntries(
    Object.entries(snapshot.issues).filter(
      ([issueID, issue]) => !isDashboardSubscriptionIssue(issue) || incomingIssueRefs.has(issueID),
    ),
  ) as Record<string, Issue>

  for (const entry of entries) {
    issues[entry.issueRef] = issueFromBoardEntry(entry, issues[entry.issueRef])
  }

  const boardRunning = entries
    .filter((entry) => entry.phase === 'claimed' || entry.phase === 'running')
    .map(runningFromBoardEntry)
  const running = [
    ...snapshot.running.filter((entry) => entry.workspace !== DASHBOARD_SUBSCRIPTION_SOURCE),
    ...boardRunning,
  ]

  return {
    ...state,
    state: {
      ...snapshot,
      issues,
      running,
      stats: {
        ...snapshot.stats,
        Running: running.length,
      },
      generated_at: timestamp,
    },
  }
}

function eventPayloadFromRunFrame(frame: DashboardSubscriptionFrame): Record<string, unknown> {
  const payload = asRecord(frame.payload)
  return Object.keys(payload).length > 0 ? payload : asRecord(frame)
}

function logLineForWorkerEvent(event: Record<string, unknown>): string {
  const payload = asRecord(event.payload)
  switch (event.kind) {
    case 'log':
      return asString(payload.message) ?? 'log event'
    case 'tool_call':
      return asString(payload.tool) ?? 'tool call'
    case 'diff':
      return asString(payload.summary) ?? 'diff updated'
    case 'error':
      return asString(payload.message) ?? 'worker error'
    case 'phase':
      return asString(payload.label) ?? asString(payload.phase) ?? 'phase updated'
    case 'start':
      return asString(payload.agentRunner) ?? 'worker started'
    default:
      return asString(event.kind) ?? 'run event'
  }
}

function updateRunningForWorkerEvent(
  snapshot: StateSnapshot,
  issueID: string,
  runID: string,
  workerID: string | undefined,
  event: Record<string, unknown>,
): RunningEntry[] {
  const payload = asRecord(event.payload)
  const timestamp = asTimestamp(event.ts)
  const existing = snapshot.running.find(
    (entry) => entry.issue_id === issueID || entry.session_id === runID,
  )
  const base: RunningEntry =
    existing ?? {
      issue_id: issueID,
      attempt: 0,
      pid: 0,
      session_id: runID,
      workspace: workerID ?? DASHBOARD_SUBSCRIPTION_SOURCE,
      started_at: timestamp,
      phase: 0,
      tokens_in: 0,
      tokens_out: 0,
    }

  let next: RunningEntry = {
    ...base,
    issue_id: issueID,
    session_id: runID,
    workspace: workerID ?? base.workspace,
    last_activity_at: timestamp,
    last_activity_kind: logLineForWorkerEvent(event),
  }

  if (event.kind === 'phase') {
    const phaseLabel = asString(payload.label) ?? asString(payload.phase)
    next = {
      ...next,
      phase_label: phaseLabel ?? next.phase_label,
      agent_stage: asString(payload.phase) ?? next.agent_stage,
    }
  }

  if (event.kind === 'diff') {
    next = {
      ...next,
      diff_files: asNumber(payload.filesChanged) ?? next.diff_files,
      diff_added: asNumber(payload.additions) ?? next.diff_added,
      diff_removed: asNumber(payload.deletions) ?? next.diff_removed,
      diff_status: 'ok',
    }
  }

  if (event.kind === 'tool_call') {
    next = {
      ...next,
      tokens_in: next.tokens_in + (asNumber(payload.tokensIn) ?? 0),
      tokens_out: next.tokens_out + (asNumber(payload.tokensOut) ?? 0),
    }
  }

  if (event.kind === 'error') {
    next = {
      ...next,
      diff_status: 'error',
      phase_label: 'error',
    }
  }

  return [...snapshot.running.filter((entry) => entry !== existing), next]
}

function applyDashboardRunEvent(state: SSEState, frame: DashboardSubscriptionFrame): SSEState {
  const payload = eventPayloadFromRunFrame(frame)
  const event = asRecord(payload.event)
  const runID = asString(payload.runId) ?? asString(payload.run_id)
  const issueID = asString(payload.issueRef) ?? asString(payload.issue_ref) ?? runID
  if (!runID || !issueID || Object.keys(event).length === 0) {
    return state
  }

  const timestamp = asTimestamp(event.ts)
  const snapshot = state.state ?? emptySnapshot(timestamp)
  const issues = { ...snapshot.issues }
  if (!issues[issueID]) {
    issues[issueID] = issueFromBoardEntry({
      issueRef: issueID,
      runId: runID,
      assignedWorkerId: asString(payload.workerId) ?? asString(payload.worker_id),
      phase: 'running',
      lastUpdated: Date.parse(timestamp),
    })
  }

  const logs = [...state.agentLogs]
  if (event.kind === 'log' || event.kind === 'error' || event.kind === 'tool_call') {
    logs.push({
      worker_id: asString(payload.workerId) ?? asString(payload.worker_id) ?? runID,
      line: logLineForWorkerEvent(event),
      stream: event.kind === 'error' ? 'stderr' : 'stdout',
      timestamp,
    })
    if (logs.length > 1000) {
      logs.splice(0, logs.length - 1000)
    }
  }

  const running = updateRunningForWorkerEvent(
    snapshot,
    issueID,
    runID,
    asString(payload.workerId) ?? asString(payload.worker_id),
    event,
  )

  return {
    ...state,
    agentLogs: logs,
    state: {
      ...snapshot,
      issues,
      running,
      stats: {
        ...snapshot.stats,
        Running: running.length,
      },
      generated_at: timestamp,
    },
  }
}

function workerStateFromStatus(worker: WorkerStatusFrameWorker): WorkerState {
  const heartbeat = asTimestamp(worker.lastHeartbeatTs)
  return {
    id: worker.workerId,
    agent_type: worker.kind ?? 'worker',
    status: worker.status ?? 'unknown',
    work_dir: '',
    started_at: heartbeat,
    last_heartbeat: heartbeat,
  }
}

function applyDashboardWorkerStatus(state: SSEState, frame: DashboardSubscriptionFrame): SSEState {
  const worker = asRecord(frame.worker) as Partial<WorkerStatusFrameWorker>
  const workerID = asString(worker.workerId)
  if (!workerID) {
    return state
  }

  const currentSnapshot = asTeamSnapshot(state.teamSnapshot)
  const nextWorker = workerStateFromStatus(worker as WorkerStatusFrameWorker)
  const workers = [
    ...currentSnapshot.workers.filter((entry) => entry.id !== nextWorker.id),
    nextWorker,
  ]
  const dashboardWorkers = {
    ...state.dashboardWorkers,
    [workerID]: {
      currentLoad: asNumber(worker.currentLoad) ?? state.dashboardWorkers[workerID]?.currentLoad ?? 0,
      maxConcurrency:
        asNumber(worker.maxConcurrency) ?? state.dashboardWorkers[workerID]?.maxConcurrency ?? 1,
    },
  }
  const runningLoad = Object.values(dashboardWorkers).reduce(
    (sum, entry) => sum + entry.currentLoad,
    0,
  )
  const totalCapacity = Object.values(dashboardWorkers).reduce(
    (sum, entry) => sum + entry.maxConcurrency,
    0,
  )
  const timestamp = new Date().toISOString()
  const snapshot = state.state ?? emptySnapshot(timestamp)

  return {
    ...state,
    dashboardWorkers,
    teamSnapshot: {
      ...currentSnapshot,
      workers,
    },
    state: {
      ...snapshot,
      stats: {
        ...snapshot.stats,
        Running: runningLoad,
        MaxAgents: Math.max(snapshot.stats.MaxAgents, totalCapacity),
      },
      generated_at: timestamp,
    },
  }
}

function applyDashboardConfigChanged(state: SSEState, frame: DashboardSubscriptionFrame): SSEState {
  const payload = eventPayloadFromRunFrame(frame)
  const usageCaps = asRecord(payload.usageCaps)
  const maxWorkers = asNumber(usageCaps.max_active_workers) ?? asNumber(usageCaps.maxActiveWorkers)
  const timestamp = new Date().toISOString()
  const snapshot = state.state ?? emptySnapshot(timestamp)
  const currentSnapshot = asTeamSnapshot(state.teamSnapshot)

  return {
    ...state,
    teamSnapshot: {
      ...currentSnapshot,
      config: {
        ...currentSnapshot.config,
        max_workers: maxWorkers ?? currentSnapshot.config.max_workers,
      },
    },
    state: {
      ...snapshot,
      stats: {
        ...snapshot.stats,
        MaxAgents: maxWorkers ?? snapshot.stats.MaxAgents,
      },
      generated_at: timestamp,
    },
  }
}

function resolveTeamEventPayload(webEvt: WebEvent): TeamEventPayload {
  const payload = asRecord(webEvt.payload)
  const nestedData = asRecord(payload.data)

  return {
    type: typeof payload.type === 'string' ? payload.type : webEvt.type,
    team_name: typeof payload.team_name === 'string' ? payload.team_name : '',
    data: nestedData,
    timestamp: typeof payload.timestamp === 'string' ? payload.timestamp : webEvt.timestamp,
  }
}

function applyTeamEvent(state: SSEState, webEvt: WebEvent): SSEState {
  const teamEvent = resolveTeamEventPayload(webEvt)
  const currentSnapshot = asTeamSnapshot(state.teamSnapshot)

  switch (teamEvent.type) {
    case 'team_created': {
      const config = asRecord(teamEvent.data.config)

      return {
        ...state,
        teamSnapshot: {
          ...currentSnapshot,
          name: teamEvent.team_name || currentSnapshot.name,
          config: {
            ...currentSnapshot.config,
            ...config,
          },
          created_at: teamEvent.timestamp,
        },
      }
    }

    case 'phase_started':
    case 'phase_completed': {
      const transitions = Array.isArray(teamEvent.data.transitions)
        ? (teamEvent.data.transitions as TeamSnapshot['phase']['transitions'])
        : currentSnapshot.phase.transitions
      const rawArtifacts = asRecord(teamEvent.data.artifacts)
      const artifacts = Object.fromEntries(
        Object.entries(rawArtifacts).filter((entry): entry is [string, string] =>
          typeof entry[1] === 'string',
        ),
      )

      return {
        ...state,
        teamSnapshot: {
          ...currentSnapshot,
          name: teamEvent.team_name || currentSnapshot.name,
          phase: {
            ...currentSnapshot.phase,
            phase:
              typeof teamEvent.data.phase === 'string' ? (teamEvent.data.phase as string) : currentSnapshot.phase.phase,
            fix_loop_count:
              typeof teamEvent.data.fix_loop_count === 'number'
                ? teamEvent.data.fix_loop_count
                : currentSnapshot.phase.fix_loop_count,
            transitions,
            artifacts: {
              ...currentSnapshot.phase.artifacts,
              ...artifacts,
            },
          },
        },
      }
    }

    case 'worker_started':
    case 'worker_updated': {
      const worker = teamEvent.data as unknown as WorkerState
      if (!worker?.id) {
        return state
      }

      return {
        ...state,
        teamSnapshot: {
          ...currentSnapshot,
          workers: [...currentSnapshot.workers.filter((entry) => entry.id !== worker.id), worker],
        },
      }
    }

    case 'worker_stopped': {
      const workerID =
        typeof teamEvent.data.worker_id === 'string'
          ? teamEvent.data.worker_id
          : typeof teamEvent.data.id === 'string'
            ? teamEvent.data.id
            : ''
      if (!workerID) {
        return state
      }

      return {
        ...state,
        teamSnapshot: {
          ...currentSnapshot,
          workers: currentSnapshot.workers.filter((entry) => entry.id !== workerID),
        },
      }
    }

    case 'task_created':
    case 'task_updated':
    case 'task_claimed':
    case 'task_completed':
    case 'task_failed': {
      const task = teamEvent.data as unknown as TeamTask
      if (!task?.id) {
        return state
      }

      return {
        ...state,
        teamSnapshot: {
          ...currentSnapshot,
          tasks: [...currentSnapshot.tasks.filter((entry) => entry.id !== task.id), task],
        },
      }
    }

    default:
      return state
  }
}

function applyBoardEvent(state: SSEState, webEvt: WebEvent): SSEState {
  const boardEvent = webEvt.payload as BoardEvent
  if (!boardEvent?.issue) {
    return state
  }

  const issues = [...state.boardIssues]
  const action = boardEvent.action || webEvt.type.replace(/^board_issue_/, '')

  switch (action) {
    case 'created':
      return {
        ...state,
        boardIssues: [...issues.filter((issue) => issue.identifier !== boardEvent.issue.identifier), boardEvent.issue],
      }
    case 'updated':
    case 'moved':
      if (!issues.some((issue) => issue.identifier === boardEvent.issue.identifier)) {
        return { ...state, boardIssues: [...issues, boardEvent.issue] }
      }
      return {
        ...state,
        boardIssues: issues.map((issue) =>
          issue.identifier === boardEvent.issue.identifier ? boardEvent.issue : issue,
        ),
      }
    default:
      return state
  }
}

function applyAgentLogEvent(state: SSEState, webEvt: WebEvent): SSEState {
  const logEvent = webEvt.payload as AgentLogEvent
  if (!logEvent?.worker_id) {
    return state
  }

  const logs = [...state.agentLogs, logEvent]
  if (logs.length > 1000) {
    logs.splice(0, logs.length - 1000)
  }

  return { ...state, agentLogs: logs }
}

function applyQueueEvent(state: SSEState, webEvt: WebEvent): SSEState {
  const payload = asRecord(webEvt.payload)
  const issueID = typeof payload.issue_id === 'string' ? payload.issue_id : ''
  if (!issueID) {
    return state
  }

  const entry: QueueEventPayload = {
    issue_id: issueID,
    identifier: typeof payload.identifier === 'string' ? payload.identifier : issueID,
    blockers: typeof payload.blockers === 'string' ? payload.blockers : '',
  }

  const queueEvents = [...state.queueEvents, entry]
  if (queueEvents.length > 1000) {
    queueEvents.splice(0, queueEvents.length - 1000)
  }

  return { ...state, queueEvents }
}

export function applyEvent(snapshot: StateSnapshot, event: OrchestratorEvent): StateSnapshot {
  switch (event.Type) {
    case 0: {
      const data = event.Data as StatusUpdateData
      return {
        ...snapshot,
        stats: data.Stats,
      }
    }

    case 1: {
      const data = event.Data as AgentStartedData
      const entry: RunningEntry = {
        issue_id: event.IssueID,
        attempt: data.Attempt,
        pid: data.PID,
        session_id: data.SessionID,
        workspace: data.Workspace,
        started_at: event.Timestamp,
        phase: 0,
        tokens_in: 0,
        tokens_out: 0,
      }

      const running = [...snapshot.running.filter((item) => item.issue_id !== event.IssueID), entry]

      return {
        ...snapshot,
        running,
        stats: {
          ...snapshot.stats,
          Running: running.length,
        },
      }
    }

    case 2: {
      const running = snapshot.running.filter((item) => item.issue_id !== event.IssueID)

      return {
        ...snapshot,
        running,
        stats: {
          ...snapshot.stats,
          Running: running.length,
        },
      }
    }

    case 3: {
      const data = event.Data as BackoffEnqueuedData
      const entry: BackoffEntry = {
        issue_id: event.IssueID,
        attempt: data.Attempt,
        retry_at: data.RetryAt,
        error: data.Error,
      }

      const backoff = [
        ...snapshot.backoff.filter(
          (item) => !(item.issue_id === event.IssueID && item.attempt === data.Attempt),
        ),
        entry,
      ]

      return {
        ...snapshot,
        backoff,
      }
    }

    case 4: {
      const data = event.Data as IssueReleasedData
      const backoff = snapshot.backoff.filter(
        (item) => !(item.issue_id === event.IssueID && item.attempt === data.Attempt),
      )

      return {
        ...snapshot,
        backoff,
      }
    }

    default:
      return snapshot
  }
}

export function applyDashboardSubscriptionFrame(
  state: SSEState,
  frame: DashboardSubscriptionFrame,
): SSEState {
  switch (frame.type) {
    case 'board-update':
      return applyDashboardBoardUpdate(state, frame)
    case 'run-event':
      return applyDashboardRunEvent(state, frame)
    case 'worker-status':
      return applyDashboardWorkerStatus(state, frame)
    case 'config-changed':
      return applyDashboardConfigChanged(state, frame)
    default:
      return state
  }
}

export function sseReducer(state: SSEState, action: SSEAction): SSEState {
  switch (action.type) {
    case 'snapshot':
      return { ...state, state: action.data, connected: true, error: null }
    case 'dashboard_frame':
      return applyDashboardSubscriptionFrame(state, action.data)
    case 'connected':
      return { ...state, connected: true, error: null }
    case 'disconnected':
      return { ...state, connected: false }
    case 'error':
      return { ...state, error: action.message, connected: false }
    case 'web_event': {
      const webEvent = action.data

      switch (webEvent.kind) {
        case 'orchestrator':
          if (webEvent.type === 'dispatch_skipped_blocked_by') {
            return applyQueueEvent(state, webEvent)
          }
          if (!state.state) {
            return state
          }
          return { ...state, state: applyEvent(state.state, webEvent.payload as OrchestratorEvent) }
        case 'team':
          return applyTeamEvent(state, webEvent)
        case 'board':
          return applyBoardEvent(state, webEvent)
        case 'agent_log':
          return applyAgentLogEvent(state, webEvent)
        default:
          return state
      }
    }
    default:
      return state
  }
}

const EVENT_NAMES = [
  'StatusUpdate',
  'AgentStarted',
  'AgentFinished',
  'BackoffEnqueued',
  'IssueReleased',
] as const

const TEAM_EVENT_NAMES = [
  'team_created',
  'phase_started',
  'phase_completed',
  'worker_started',
  'worker_updated',
  'worker_stopped',
  'task_created',
  'task_updated',
  'task_claimed',
  'task_completed',
  'task_failed',
] as const

const BOARD_EVENT_NAMES = ['board_issue_created', 'board_issue_updated', 'board_issue_moved'] as const

const AGENT_LOG_EVENT_NAMES = ['agent_log'] as const

const QUEUE_EVENT_NAMES = ['queue'] as const

const WEB_EVENT_NAMES = [
  ...EVENT_NAMES,
  ...TEAM_EVENT_NAMES,
  ...BOARD_EVENT_NAMES,
  ...AGENT_LOG_EVENT_NAMES,
  ...QUEUE_EVENT_NAMES,
] as const

export function useSSE() {
  const [sseState, dispatch] = useReducer(sseReducer, INITIAL_STATE)
  const eventSourceRef = useRef<EventSource | null>(null)

  const connect = useCallback(() => {
    eventSourceRef.current?.close()

    const eventSource = createApiEventSource('/api/v1/events')
    eventSourceRef.current = eventSource

    eventSource.addEventListener('snapshot', (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as StateSnapshot
        dispatch({ type: 'snapshot', data })
      } catch {
        dispatch({ type: 'error', message: zhCN.errors.parseSnapshot })
      }
    })

    for (const eventName of WEB_EVENT_NAMES) {
      eventSource.addEventListener(eventName, (event) => {
        try {
          const payload = JSON.parse((event as MessageEvent).data) as unknown

          if (isWebEvent(payload)) {
            dispatch({ type: 'web_event', data: payload })
            return
          }

          if (isOrchestratorEvent(payload)) {
            dispatch({
              type: 'web_event',
              data: {
                kind: 'orchestrator',
                type: eventName,
                payload,
                timestamp: payload.Timestamp,
              },
            })
            return
          }

          dispatch({ type: 'error', message: zhCN.errors.parseEvent(eventName) })
        } catch {
          dispatch({ type: 'error', message: zhCN.errors.parseEvent(eventName) })
        }
      })
    }

    eventSource.onopen = () => {
      dispatch({ type: 'connected' })
    }

    eventSource.onerror = () => {
      dispatch({ type: 'disconnected' })
    }
  }, [])

  useEffect(() => {
    connect()

    return () => {
      eventSourceRef.current?.close()
      eventSourceRef.current = null
    }
  }, [connect])

  // Per-issue tokens (running[i].tokens_in/out) and diff stats are only
  // populated in the initial /api/v1/state snapshot — the StatusUpdate SSE
  // event carries top-level Stats only. Periodically refetch the full
  // snapshot so per-row numbers stay live without a manual page reload.
  const refresh = useCallback(async () => {
    try {
      const response = await apiFetch('/api/v1/state')
      if (!response.ok) {
        return
      }
      const data = (await response.json()) as StateSnapshot
      dispatch({ type: 'snapshot', data })
    } catch {
      // Silent: SSE will surface connection issues separately.
    }
  }, [])

  const applyDashboardFrame = useCallback((frame: DashboardSubscriptionFrame) => {
    dispatch({ type: 'dashboard_frame', data: frame })
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => {
      void refresh()
    }, 5000)
    return () => window.clearInterval(timer)
  }, [refresh])

  return { ...sseState, refresh, applyDashboardFrame }
}
