import { useEffect, useState } from 'react'
import { Badge, Empty, LayerCard, Table } from '@cloudflare/kumo'
import type { BackoffEntry } from '../types'
import { formatDuration } from '../i18n/format'
import { zhCN } from '../i18n/messages'

interface RetryQueueProps {
  entries: BackoffEntry[]
}

function formatRetryIn(retryAt: string, nowMs: number): { text: string; ready: boolean } {
  const retryAtMs = Date.parse(retryAt)
  if (Number.isNaN(retryAtMs)) {
    return { text: zhCN.retryQueue.unknown, ready: false }
  }

  const diffSeconds = Math.floor((retryAtMs - nowMs) / 1000)
  if (diffSeconds <= 0) {
    return { text: zhCN.retryQueue.ready, ready: true }
  }

  return { text: formatDuration(diffSeconds), ready: false }
}

function truncateError(error: string, limit = 60): string {
  if (error.length <= limit) {
    return error
  }

  return `${error.slice(0, limit - 3)}...`
}

export function RetryQueue({ entries }: RetryQueueProps) {
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowMs(Date.now())
    }, 1000)

    return () => window.clearInterval(timer)
  }, [])

  if (entries.length === 0) {
    return <Empty size="sm" title={zhCN.retryQueue.empty} />
  }

  return (
    <LayerCard className="overflow-x-auto p-0">
      <Table aria-label={zhCN.retryQueue.ariaLabel}>
        <Table.Header>
          <Table.Row>
            <Table.Head>{zhCN.retryQueue.headers.issueID}</Table.Head>
            <Table.Head>{zhCN.retryQueue.headers.attempt}</Table.Head>
            <Table.Head>{zhCN.retryQueue.headers.retryIn}</Table.Head>
            <Table.Head>{zhCN.retryQueue.headers.error}</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {entries.map((entry) => {
            const retryIn = formatRetryIn(entry.retry_at, nowMs)

            return (
              <Table.Row key={`${entry.issue_id}-${entry.attempt}-${entry.retry_at}`}>
                <Table.Cell>{entry.issue_id}</Table.Cell>
                <Table.Cell>{entry.attempt}</Table.Cell>
                <Table.Cell>
                  <Badge variant={retryIn.ready ? 'success' : 'secondary'}>{retryIn.text}</Badge>
                </Table.Cell>
                <Table.Cell title={entry.error}>{truncateError(entry.error)}</Table.Cell>
              </Table.Row>
            )
          })}
        </Table.Body>
      </Table>
    </LayerCard>
  )
}
