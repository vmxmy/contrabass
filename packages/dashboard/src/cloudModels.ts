export type CloudBoardPhase = 'open' | 'claimed' | 'running' | 'done'

export interface CloudBoardEntry {
  issueRef: string
  runId?: string
  assignedWorkerId?: string
  phase: CloudBoardPhase
  lastUpdated: number
  title?: string
  summary?: string
}

export type CloudBoardSnapshot = Record<CloudBoardPhase, CloudBoardEntry[]>

export interface TeamSummary {
  id: string
  name: string
}

export interface ConfigVersion {
  version: number | string
  contentHash: string
  createdBy: string
  createdAt: string
  notes?: string
  active?: boolean
}

export interface TrackerAdapterHealth {
  adapter: string
  successRate: number
  avgDurationMs: number
  issuesSeen: number
  issuesNew: number
  issuesUpdated: number
  lastError?: string
  lastPollAt?: string
}

const BOARD_PHASES: CloudBoardPhase[] = ['open', 'claimed', 'running', 'done']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function stringField(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim() !== '') {
      return value
    }
  }
  return undefined
}

function numberField(record: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value
    }
    if (typeof value === 'string') {
      const parsed = Date.parse(value)
      if (Number.isFinite(parsed)) {
        return parsed
      }
    }
  }
  return undefined
}

function normalizePhase(value: string | undefined, fallback: CloudBoardPhase): CloudBoardPhase {
  if (value === 'open' || value === 'claimed' || value === 'running' || value === 'done') {
    return value
  }
  return fallback
}

export function emptyCloudBoardSnapshot(): CloudBoardSnapshot {
  return { open: [], claimed: [], running: [], done: [] }
}

export function normalizeCloudBoardSnapshot(value: unknown): CloudBoardSnapshot {
  const candidate = isRecord(value) && isRecord(value.board) ? value.board : value
  const board = emptyCloudBoardSnapshot()
  if (!isRecord(candidate)) {
    return board
  }

  for (const phase of BOARD_PHASES) {
    const entries = candidate[phase]
    if (!Array.isArray(entries)) {
      continue
    }

    board[phase] = entries.flatMap((entry): CloudBoardEntry[] => {
      if (!isRecord(entry)) {
        return []
      }

      const issueRef = stringField(entry, 'issueRef', 'issue_ref', 'id', 'identifier')
      if (!issueRef) {
        return []
      }

      return [
        {
          issueRef,
          runId: stringField(entry, 'runId', 'run_id'),
          assignedWorkerId: stringField(entry, 'assignedWorkerId', 'assigned_worker_id', 'workerId', 'worker_id'),
          phase: normalizePhase(stringField(entry, 'phase'), phase),
          lastUpdated: numberField(entry, 'lastUpdated', 'last_updated', 'updatedAt', 'updated_at') ?? Date.now(),
          title: stringField(entry, 'title'),
          summary: stringField(entry, 'summary', 'description'),
        },
      ]
    })
  }

  return board
}

export function flattenCloudBoard(snapshot: CloudBoardSnapshot): CloudBoardEntry[] {
  return BOARD_PHASES.flatMap((phase) => snapshot[phase]).sort((left, right) => right.lastUpdated - left.lastUpdated)
}

export function configVersionsFromResponse(value: unknown): ConfigVersion[] {
  const versions = isRecord(value) && Array.isArray(value.versions) ? value.versions : value
  if (!Array.isArray(versions)) {
    return []
  }

  return versions.flatMap((entry): ConfigVersion[] => {
    if (!isRecord(entry)) {
      return []
    }

    const version = stringField(entry, 'version') ?? numberField(entry, 'version')
    const contentHash = stringField(entry, 'contentHash', 'content_hash', 'hash')
    if (version === undefined || !contentHash) {
      return []
    }

    return [
      {
        version,
        contentHash,
        createdBy: stringField(entry, 'createdBy', 'created_by', 'author') ?? 'unknown',
        createdAt: stringField(entry, 'createdAt', 'created_at') ?? '',
        notes: stringField(entry, 'notes'),
        active: entry.active === true,
      },
    ]
  })
}

export function trackerHealthFromResponse(value: unknown): TrackerAdapterHealth[] {
  const adapters = isRecord(value) && Array.isArray(value.adapters) ? value.adapters : value
  if (!Array.isArray(adapters)) {
    return []
  }

  return adapters.flatMap((entry): TrackerAdapterHealth[] => {
    if (!isRecord(entry)) {
      return []
    }

    const adapter = stringField(entry, 'adapter', 'name')
    if (!adapter) {
      return []
    }

    return [
      {
        adapter,
        successRate: numberField(entry, 'successRate', 'success_rate') ?? 0,
        avgDurationMs: numberField(entry, 'avgDurationMs', 'avg_duration_ms', 'duration_ms') ?? 0,
        issuesSeen: numberField(entry, 'issuesSeen', 'issues_seen') ?? 0,
        issuesNew: numberField(entry, 'issuesNew', 'issues_new') ?? 0,
        issuesUpdated: numberField(entry, 'issuesUpdated', 'issues_updated') ?? 0,
        lastError: stringField(entry, 'lastError', 'last_error'),
        lastPollAt: stringField(entry, 'lastPollAt', 'last_poll_at'),
      },
    ]
  })
}
