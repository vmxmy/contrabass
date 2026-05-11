import { Badge, LayerCard, Text } from '@cloudflare/kumo'
import { formatDuration } from '../i18n/format'
import { zhCN } from '../i18n/messages'

interface HeaderProps {
  connected: boolean
  runtimeSeconds: number
}

function formatRuntime(runtimeSeconds: number): string {
  return formatDuration(runtimeSeconds)
}

export function Header({ connected, runtimeSeconds }: HeaderProps) {
  return (
    <header><LayerCard className="flex items-center justify-between gap-4 p-4">
      <div className="flex items-center gap-3">
        <img
          src="/contrabass.png"
          alt={zhCN.header.mascotAlt}
          width={48}
          height={48}
        />
        <Text variant="heading1" as="h1">Ziikoo</Text>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={connected ? 'success' : 'error'}>
          {zhCN.header.status}: {connected ? zhCN.header.live : zhCN.header.offline}
        </Badge>
        <Badge variant="secondary">
          {zhCN.header.runtime}: {formatRuntime(runtimeSeconds)}
        </Badge>
      </div>
    </LayerCard></header>
  )
}
