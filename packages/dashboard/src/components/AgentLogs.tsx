import { useEffect, useMemo, useRef, useState } from 'react'
import { Badge, Empty, LayerCard, Select, Text } from '@cloudflare/kumo'
import type { AgentLogEvent } from '../types'
import { zhCN } from '../i18n/messages'

type DisplayAgentLogEvent = AgentLogEvent & {
  channel?: string
  type?: string
}

interface AgentLogsProps {
  logs: DisplayAgentLogEvent[]
}

const MAX_VISIBLE_LOGS = 500
const HEARTBEAT_TYPES = new Set(['team/stalled'])

function formatTimestamp(timestamp: string): string {
  if (timestamp.length >= 19 && timestamp.includes('T')) {
    return timestamp.slice(11, 19)
  }

  const parsed = Date.parse(timestamp)
  if (Number.isNaN(parsed)) {
    return '--:--:--'
  }

  const date = new Date(parsed)
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  const seconds = String(date.getSeconds()).padStart(2, '0')
  return `${hours}:${minutes}:${seconds}`
}

function shouldShowLog(log: DisplayAgentLogEvent): boolean {
  if (log.channel === 'queue') {
    return false
  }

  return !HEARTBEAT_TYPES.has(log.type ?? '')
}

export function AgentLogs({ logs }: AgentLogsProps) {
  const [selectedWorker, setSelectedWorker] = useState('all')
  const [shouldAutoScroll, setShouldAutoScroll] = useState(true)
  const viewportRef = useRef<HTMLDivElement | null>(null)

  const displayableLogs = useMemo(() => logs.filter(shouldShowLog), [logs])

  const workerIDs = useMemo(() => {
    const unique = Array.from(new Set(displayableLogs.map((log) => log.worker_id)))
    return unique.sort((a, b) => a.localeCompare(b))
  }, [displayableLogs])

  useEffect(() => {
    if (selectedWorker !== 'all' && !workerIDs.includes(selectedWorker)) {
      setSelectedWorker('all')
    }
  }, [selectedWorker, workerIDs])

  const filteredLogs = useMemo(() => {
    if (selectedWorker === 'all') {
      return displayableLogs
    }

    return displayableLogs.filter((log) => log.worker_id === selectedWorker)
  }, [displayableLogs, selectedWorker])

  const visibleLogs = useMemo(() => {
    if (filteredLogs.length <= MAX_VISIBLE_LOGS) {
      return filteredLogs
    }

    return filteredLogs.slice(-MAX_VISIBLE_LOGS)
  }, [filteredLogs])

  useEffect(() => {
    const viewport = viewportRef.current
    if (viewport === null || !shouldAutoScroll) {
      return
    }

    viewport.scrollTop = viewport.scrollHeight
  }, [visibleLogs, shouldAutoScroll])

  function handleScroll() {
    const viewport = viewportRef.current
    if (viewport === null) {
      return
    }

    const bottomOffset = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
    setShouldAutoScroll(bottomOffset <= 8)
  }

  if (displayableLogs.length === 0) {
    return <Empty size="sm" title={zhCN.agentLogs.empty} />
  }

  return (
    <LayerCard className="p-4" aria-label={zhCN.agentLogs.ariaLabel}>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <Text variant="heading3" as="h3">{zhCN.agentLogs.title}</Text>
        <Select
          label={zhCN.agentLogs.workerFilter}
          size="sm"
          value={selectedWorker}
          onValueChange={(value) => setSelectedWorker(String(value))}
        >
          <Select.Option value="all">{zhCN.agentLogs.allWorkers}</Select.Option>
          {workerIDs.map((workerID) => (
            <Select.Option key={workerID} value={workerID}>
              {workerID}
            </Select.Option>
          ))}
        </Select>
      </div>

      <div className="max-h-96 overflow-auto" ref={viewportRef} onScroll={handleScroll}>
        {visibleLogs.length === 0 ? (
          <Text variant="secondary" size="sm">{zhCN.agentLogs.emptyFiltered}</Text>
        ) : (
          <div className="grid gap-2">
            {visibleLogs.map((log, index) => (
              <div
                key={`${log.worker_id}-${log.timestamp}-${index}`}
                className="grid gap-1"
                data-testid="agent-log-line"
                data-stream={log.stream}
                title={log.line}
              >
                <div className="flex flex-wrap gap-2">
                  <Badge variant="secondary">[{formatTimestamp(log.timestamp)}]</Badge>
                  <Badge variant={log.stream === 'stderr' ? 'error' : 'info'}>[{log.worker_id}]</Badge>
                </div>
                <Text variant={log.stream === 'stderr' ? 'error' : 'mono'}>{log.line}</Text>
              </div>
            ))}
          </div>
        )}
      </div>
    </LayerCard>
  )
}

export default AgentLogs
