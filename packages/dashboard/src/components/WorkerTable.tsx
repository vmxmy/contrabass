import { Badge, Empty, LayerCard, Table } from '@cloudflare/kumo'
import type { WorkerState } from '../types'
import { formatElapsedSince, formatWorkerStatus } from '../i18n/format'
import { zhCN } from '../i18n/messages'

interface WorkerTableProps {
  workers: WorkerState[]
}

function formatAge(startedAt: string): string {
  return formatElapsedSince(startedAt)
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) {
    return value
  }

  return `${value.slice(0, limit - 3)}...`
}

function statusVariant(status: string): 'success' | 'secondary' | 'warning' {
  switch (status.toLowerCase()) {
    case 'busy':
      return 'success'
    case 'stopped':
      return 'warning'
    default:
      return 'secondary'
  }
}

function getStatusOrder(status: string): number {
  switch (status.toLowerCase()) {
    case 'busy':
      return 0
    case 'idle':
      return 1
    default:
      return 2
  }
}

export function WorkerTable({ workers }: WorkerTableProps) {
  if (workers.length === 0) {
    return <Empty size="sm" title={zhCN.workers.empty} />
  }

  const sortedWorkers = [...workers].sort((a, b) => {
    const statusOrder = getStatusOrder(a.status) - getStatusOrder(b.status)
    if (statusOrder !== 0) {
      return statusOrder
    }

    return a.id.localeCompare(b.id)
  })

  return (
    <LayerCard className="overflow-x-auto p-0">
      <Table aria-label={zhCN.workers.ariaLabel}>
        <Table.Header>
          <Table.Row>
            <Table.Head>{zhCN.workers.headers.workerID}</Table.Head>
            <Table.Head>{zhCN.workers.headers.status}</Table.Head>
            <Table.Head>{zhCN.workers.headers.currentTask}</Table.Head>
            <Table.Head>{zhCN.workers.headers.pid}</Table.Head>
            <Table.Head>{zhCN.workers.headers.age}</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {sortedWorkers.map((worker) => (
            <Table.Row key={worker.id}>
              <Table.Cell title={worker.id}>{truncate(worker.id, 12)}</Table.Cell>
              <Table.Cell>
                <Badge variant={statusVariant(worker.status)}>{formatWorkerStatus(worker.status)}</Badge>
              </Table.Cell>
              <Table.Cell title={worker.current_task ?? '-'}>{truncate(worker.current_task ?? '-', 20)}</Table.Cell>
              <Table.Cell>{worker.pid ?? '-'}</Table.Cell>
              <Table.Cell>{formatAge(worker.started_at)}</Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
    </LayerCard>
  )
}

export default WorkerTable
