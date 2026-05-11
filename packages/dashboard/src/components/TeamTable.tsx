import { Badge, Empty, LayerCard, Table, Text } from '@cloudflare/kumo'
import type { TeamSnapshot, TeamTask } from '../types'
import { formatElapsedSince, formatTeamPhase } from '../i18n/format'
import { zhCN } from '../i18n/messages'

interface TeamTableProps {
  snapshot: TeamSnapshot | null
}

function formatAge(createdAt: string): string {
  return formatElapsedSince(createdAt)
}

function phaseVariant(phase: string): 'info' | 'success' | 'warning' | 'error' | 'secondary' {
  switch (phase) {
    case 'team-plan':
    case 'team-prd':
      return 'info'
    case 'team-exec':
      return 'success'
    case 'team-verify':
    case 'complete':
      return 'success'
    case 'team-fix':
      return 'warning'
    case 'failed':
    case 'cancelled':
      return 'error'
    default:
      return 'secondary'
  }
}

function isTaskCompleted(task: TeamTask): boolean {
  const status = task.status.toLowerCase()
  return status === 'complete' || status === 'completed' || status === 'done' || status === 'succeeded'
}

function isTaskFailed(task: TeamTask): boolean {
  const status = task.status.toLowerCase()
  return status === 'failed' || status === 'cancelled' || status === 'canceled'
}

export function TeamTable({ snapshot }: TeamTableProps) {
  if (snapshot === null) {
    return <Empty size="sm" title={zhCN.team.empty} />
  }

  const activeWorkers = snapshot.workers.filter((worker) => worker.status.toLowerCase() === 'busy').length
  const completedTasks = snapshot.tasks.filter(isTaskCompleted).length
  const failedTasks = snapshot.tasks.filter(isTaskFailed).length

  return (
    <section aria-label={zhCN.team.ariaLabel}>
      <LayerCard className="p-4">
        <Text variant="heading3" as="h3">{snapshot.name}</Text>
        <Text variant="secondary" size="sm">
          {zhCN.team.config(
            snapshot.config.agent_type,
            snapshot.config.max_workers,
            snapshot.config.max_fix_loops,
          )}
        </Text>
      </LayerCard>
      <LayerCard className="mt-3 overflow-x-auto p-0">
        <Table aria-label={zhCN.team.tableAriaLabel}>
          <Table.Header>
            <Table.Row>
              <Table.Head>{zhCN.team.headers.phase}</Table.Head>
              <Table.Head>{zhCN.team.headers.workers}</Table.Head>
              <Table.Head>{zhCN.team.headers.tasks}</Table.Head>
              <Table.Head>{zhCN.team.headers.fixLoops}</Table.Head>
              <Table.Head>{zhCN.team.headers.age}</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            <Table.Row>
              <Table.Cell>
                <Badge variant={phaseVariant(snapshot.phase.phase)}>{formatTeamPhase(snapshot.phase.phase)}</Badge>
              </Table.Cell>
              <Table.Cell>{activeWorkers}/{snapshot.workers.length}</Table.Cell>
              <Table.Cell>{completedTasks}/{snapshot.tasks.length}/{failedTasks}</Table.Cell>
              <Table.Cell>{snapshot.phase.fix_loop_count}</Table.Cell>
              <Table.Cell>{formatAge(snapshot.created_at)}</Table.Cell>
            </Table.Row>
          </Table.Body>
        </Table>
      </LayerCard>
    </section>
  )
}

export default TeamTable
