import { Badge, Empty, LayerCard, Table } from '@cloudflare/kumo'
import type { RunningEntry } from '../types'
import { formatElapsedSince, formatNumber, formatRelativeTime } from '../i18n/format'

interface IssueDataTableProps {
  entries: RunningEntry[]
  emptyText: string
  onSelect: (entry: RunningEntry) => void
  selectedId: string | null
}

function shortId(id: string): string {
  return id.slice(0, 8)
}

export function diffSummary(entry: RunningEntry): string {
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
  return `+${added} -${removed} (${files})`
}

function activityTone(at: string | undefined): 'fresh' | 'warm' | 'stale' | 'none' {
  if (!at) return 'none'
  const parsed = Date.parse(at)
  if (Number.isNaN(parsed)) return 'none'
  const ageSeconds = Math.floor(Math.max(0, Date.now() - parsed) / 1000)
  if (ageSeconds < 30) return 'fresh'
  if (ageSeconds <= 180) return 'warm'
  return 'stale'
}

function toneVariant(tone: ReturnType<typeof activityTone>): 'success' | 'warning' | 'error' | 'secondary' {
  switch (tone) {
    case 'fresh': return 'success'
    case 'warm': return 'warning'
    case 'stale': return 'error'
    default: return 'secondary'
  }
}

function entryKey(entry: RunningEntry): string {
  return `${entry.issue_id}-${entry.pid}-${entry.started_at}`
}

export function IssueDataTable({ entries, emptyText, onSelect, selectedId }: IssueDataTableProps) {
  if (entries.length === 0) {
    return <Empty size="sm" title={emptyText} />
  }

  return (
    <LayerCard className="h-full overflow-auto p-0">
      <Table aria-label="Issues">
        <Table.Header sticky>
          <Table.Row>
            <Table.Head>ID</Table.Head>
            <Table.Head>阶段</Table.Head>
            <Table.Head>上次活动</Table.Head>
            <Table.Head>差异</Table.Head>
            <Table.Head>已运行</Table.Head>
            <Table.Head>输入 Token</Table.Head>
            <Table.Head>输出 Token</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {entries.map((entry) => {
            const tone = activityTone(entry.last_activity_at)
            const isSelected = entry.issue_id === selectedId
            return (
              <Table.Row
                key={entryKey(entry)}
                variant={isSelected ? 'selected' : 'default'}
                onClick={() => onSelect(entry)}
              >
                <Table.Cell>{shortId(entry.issue_id)}</Table.Cell>
                <Table.Cell>{entry.phase_label ?? '—'}</Table.Cell>
                <Table.Cell>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={toneVariant(tone)}>
                      {entry.last_activity_at ? formatRelativeTime(entry.last_activity_at) : '—'}
                    </Badge>
                    {entry.last_activity_kind ? <span>{entry.last_activity_kind}</span> : null}
                  </div>
                </Table.Cell>
                <Table.Cell>{diffSummary(entry)}</Table.Cell>
                <Table.Cell>{formatElapsedSince(entry.started_at)}</Table.Cell>
                <Table.Cell>{formatNumber(entry.tokens_in)}</Table.Cell>
                <Table.Cell>{formatNumber(entry.tokens_out)}</Table.Cell>
              </Table.Row>
            )
          })}
        </Table.Body>
      </Table>
    </LayerCard>
  )
}
