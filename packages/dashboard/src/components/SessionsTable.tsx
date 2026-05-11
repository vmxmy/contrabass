import { Badge, Empty, LayerCard, Table } from '@cloudflare/kumo'
import type { RunningEntry } from '../types'
import { formatElapsedSince, formatNumber, formatPhase, formatRelativeTime } from '../i18n/format'
import { zhCN } from '../i18n/messages'

interface SessionsTableProps {
  entries: RunningEntry[]
}

function formatAge(startedAt: string): string {
  return formatElapsedSince(startedAt)
}

function truncateSessionID(sessionID: string): string {
  return sessionID.slice(0, 8)
}

function phaseLabel(entry: RunningEntry): string {
  const serverLabel = entry.phase_label?.trim()
  if (serverLabel) {
    return serverLabel
  }

  return formatPhase(entry.phase)
}

function activityTone(lastActivityAt: string | undefined): 'none' | 'fresh' | 'warm' | 'stale' {
  if (!lastActivityAt) {
    return 'none'
  }

  const parsed = Date.parse(lastActivityAt)
  if (Number.isNaN(parsed)) {
    return 'none'
  }

  const ageSeconds = Math.floor(Math.max(0, Date.now() - parsed) / 1000)
  if (ageSeconds < 30) {
    return 'fresh'
  }
  if (ageSeconds <= 180) {
    return 'warm'
  }
  return 'stale'
}

function activityVariant(tone: ReturnType<typeof activityTone>): 'success' | 'warning' | 'error' | 'secondary' {
  switch (tone) {
    case 'fresh':
      return 'success'
    case 'warm':
      return 'warning'
    case 'stale':
      return 'error'
    default:
      return 'secondary'
  }
}

function renderLastActivity(entry: RunningEntry) {
  const tone = activityTone(entry.last_activity_at)
  const relative = entry.last_activity_at ? formatRelativeTime(entry.last_activity_at) : zhCN.sessions.relative.unknown
  const label = entry.last_activity_kind ? `${relative} ${entry.last_activity_kind}` : relative

  return (
    <span title={entry.last_heartbeat_at ? `heartbeat ${formatRelativeTime(entry.last_heartbeat_at)}` : undefined}>
      <Badge variant={activityVariant(tone)}>{label}</Badge>
    </span>
  )
}

function renderDiff(entry: RunningEntry): string {
  const status = entry.diff_status ?? 'ok'
  if (status !== 'ok') {
    return '?'
  }

  const added = entry.diff_added ?? 0
  const removed = entry.diff_removed ?? 0
  const files = entry.diff_files ?? 0
  if (added === 0 && removed === 0 && files === 0) {
    return '—'
  }

  return `+${added} -${removed} (${files} files)`
}

function renderIteration(entry: RunningEntry) {
  const max = entry.iteration_max ?? 0
  if (max <= 0) {
    return null
  }

  return <Badge variant="secondary">iter {entry.iteration ?? 0}/{max}</Badge>
}

// StagePill renders a compact Kumo badge instead of custom progress styling.
function StagePill({ entry }: { entry: RunningEntry }) {
  const stage = entry.agent_stage ?? ''
  const step = entry.agent_stage_step ?? 0

  if (!stage || step === 0) {
    return <span title={phaseLabel(entry)}>{phaseLabel(entry)}</span>
  }

  const stageLabel = zhCN.sessions.stages[step - 1] ?? stage

  return (
    <span aria-label={stage}>
      <Badge variant="info">{stageLabel} {step}/5</Badge>
    </span>
  )
}

// renderDoneBy renders the "Done by" cell per design.md Decision 5:
// never shows a countdown, only a clock time (~HH:MM) or elapsed fallback.
function renderDoneBy(entry: RunningEntry): string {
  const etaAt = entry.eta_completion_at ?? ''
  const conf = entry.eta_confidence ?? ''

  if (etaAt && (conf === 'medium' || conf === 'high')) {
    const date = new Date(etaAt)
    if (!Number.isNaN(date.getTime())) {
      const hh = date.getHours().toString().padStart(2, '0')
      const mm = date.getMinutes().toString().padStart(2, '0')
      return `~${hh}:${mm}`
    }
  }

  if (conf === 'low') {
    const startedAt = entry.started_at ? Date.parse(entry.started_at) : NaN
    if (!Number.isNaN(startedAt)) {
      const elapsedSeconds = Math.floor(Math.max(0, Date.now() - startedAt) / 1000)
      if (elapsedSeconds >= 60) {
        const minutes = Math.floor(elapsedSeconds / 60)
        return zhCN.sessions.elapsedNormal(minutes)
      }
    }
  }

  return '—'
}

export function SessionsTable({ entries }: SessionsTableProps) {
  if (entries.length === 0) {
    return <Empty size="sm" title={zhCN.sessions.empty} />
  }

  const sortedEntries = [...entries].sort(
    (a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime(),
  )

  return (
    <LayerCard className="overflow-x-auto p-0">
      <Table aria-label={zhCN.sessions.ariaLabel}>
        <Table.Header>
          <Table.Row>
            <Table.Head>{zhCN.sessions.headers.issueID}</Table.Head>
            <Table.Head>{zhCN.sessions.headers.phase}</Table.Head>
            <Table.Head>{zhCN.sessions.headers.lastActivity}</Table.Head>
            <Table.Head>{zhCN.sessions.headers.diff}</Table.Head>
            <Table.Head>{zhCN.sessions.headers.doneBy}</Table.Head>
            <Table.Head>{zhCN.sessions.headers.iter}</Table.Head>
            <Table.Head>{zhCN.sessions.headers.pid}</Table.Head>
            <Table.Head>{zhCN.sessions.headers.age}</Table.Head>
            <Table.Head>{zhCN.sessions.headers.turns}</Table.Head>
            <Table.Head>{zhCN.sessions.headers.tokensIn}</Table.Head>
            <Table.Head>{zhCN.sessions.headers.tokensOut}</Table.Head>
            <Table.Head>{zhCN.sessions.headers.sessionID}</Table.Head>
            <Table.Head>{zhCN.sessions.headers.lastEvent}</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {sortedEntries.map((entry) => (
            <Table.Row key={`${entry.issue_id}-${entry.pid}-${entry.started_at}`}>
              <Table.Cell>{entry.issue_id}</Table.Cell>
              <Table.Cell><StagePill entry={entry} /></Table.Cell>
              <Table.Cell>{renderLastActivity(entry)}</Table.Cell>
              <Table.Cell title={entry.diff_status && entry.diff_status !== 'ok' ? entry.diff_status : undefined}>
                {renderDiff(entry)}
              </Table.Cell>
              <Table.Cell>{renderDoneBy(entry)}</Table.Cell>
              <Table.Cell>{renderIteration(entry)}</Table.Cell>
              <Table.Cell>{entry.pid}</Table.Cell>
              <Table.Cell>{formatAge(entry.started_at)}</Table.Cell>
              <Table.Cell>{entry.attempt}</Table.Cell>
              <Table.Cell>{formatNumber(entry.tokens_in)}</Table.Cell>
              <Table.Cell>{formatNumber(entry.tokens_out)}</Table.Cell>
              <Table.Cell title={entry.session_id}>{truncateSessionID(entry.session_id)}</Table.Cell>
              <Table.Cell>-</Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
    </LayerCard>
  )
}

export default SessionsTable
