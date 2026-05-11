import { Clock, Tray, Checks, TreeStructure, Pause, Play, Gear } from '@phosphor-icons/react'
import { Badge, Meter, Sidebar, Text } from '@cloudflare/kumo'

export type QueueId =
  | 'running'
  | 'backoff'
  | 'todo'
  | 'backlog'
  | 'recent_done'
  | 'canceled'

interface AppSidebarProps {
  active: QueueId
  onSelect: (id: QueueId) => void
  counts: Partial<Record<QueueId, number>>
  connected: boolean
  runtimeLabel: string
}

type NavItem = { id: QueueId; label: string; icon: React.ComponentType<{ className?: string }> }

const ACTIVE_GROUP: NavItem[] = [
  { id: 'running', label: '运行中', icon: Play },
  { id: 'backoff', label: '退避队列', icon: Pause },
]

const QUEUE_GROUP: NavItem[] = [
  { id: 'todo', label: '待办', icon: Checks },
  { id: 'backlog', label: 'Backlog', icon: Tray },
]

const RECENT_GROUP: NavItem[] = [
  { id: 'recent_done', label: '最近完成', icon: TreeStructure },
  { id: 'canceled', label: '取消', icon: Clock },
]

function NavGroup({
  label,
  items,
  active,
  counts,
  onSelect,
}: {
  label: string
  items: NavItem[]
  active: QueueId
  counts: Partial<Record<QueueId, number>>
  onSelect: (id: QueueId) => void
}) {
  return (
    <Sidebar.Group>
      <Sidebar.GroupLabel>{label}</Sidebar.GroupLabel>
      <Sidebar.Menu>
        {items.map((item) => {
          const count = counts[item.id]
          return (
            <Sidebar.MenuItem key={item.id}>
              <Sidebar.MenuButton
                icon={item.icon}
                active={active === item.id}
                onClick={() => onSelect(item.id)}
              >
                {item.label}
              </Sidebar.MenuButton>
              {count !== undefined && count > 0 ? (
                <Sidebar.MenuBadge>{count}</Sidebar.MenuBadge>
              ) : null}
            </Sidebar.MenuItem>
          )
        })}
      </Sidebar.Menu>
    </Sidebar.Group>
  )
}

export function AppSidebar({ active, onSelect, counts, connected, runtimeLabel }: AppSidebarProps) {
  return (
    <Sidebar>
      <Sidebar.Header>
        <div className="flex items-start gap-3">
          <img className="shrink-0" src="/contrabass.png" alt="" width={40} height={40} />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <div className="min-w-0 flex-1">
                <Text variant="heading3" as="p" truncate>Ziikoo</Text>
              </div>
              <Badge variant={connected ? 'success' : 'error'}>
                {connected ? '在线' : '离线'}
              </Badge>
            </div>
            <Text variant="mono-secondary" truncate>{runtimeLabel}</Text>
          </div>
        </div>
        <Meter label="Connection" value={connected ? 100 : 0} showValue={false} />
      </Sidebar.Header>
      <Sidebar.Content>
        <NavGroup label="运行" items={ACTIVE_GROUP} active={active} counts={counts} onSelect={onSelect} />
        <NavGroup label="队列" items={QUEUE_GROUP} active={active} counts={counts} onSelect={onSelect} />
        <NavGroup label="归档" items={RECENT_GROUP} active={active} counts={counts} onSelect={onSelect} />
      </Sidebar.Content>
      <Sidebar.Footer>
        <Sidebar.Menu>
          <Sidebar.MenuButton icon={Gear} tooltip="Settings (TODO)">
            设置
          </Sidebar.MenuButton>
        </Sidebar.Menu>
      </Sidebar.Footer>
    </Sidebar>
  )
}
