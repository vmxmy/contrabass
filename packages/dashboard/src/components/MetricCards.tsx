import { Grid, GridItem } from '@cloudflare/kumo'
import type { Stats } from '../types'
import { formatCompactNumber } from '../i18n/format'
import { zhCN } from '../i18n/messages'
import { MetricCard } from './MetricCard'

interface MetricCardsProps {
  stats: Stats
  backoffCount: number
}

export function MetricCards({ stats, backoffCount }: MetricCardsProps) {
  const totalTokens = stats.TotalTokensIn + stats.TotalTokensOut

  return (
    <section aria-label={zhCN.metrics.ariaLabel}>
      <Grid variant="3up" gap="sm">
      <GridItem>
        <MetricCard
          title={zhCN.metrics.running}
          value={`${stats.Running}/${stats.MaxAgents}`}
          subtitle={zhCN.metrics.activeAgents}
        />
      </GridItem>
      <GridItem>
        <MetricCard title={zhCN.metrics.retrying} value={backoffCount} subtitle={zhCN.metrics.backoffQueue} />
      </GridItem>
      <GridItem>
        <MetricCard
          title={zhCN.metrics.totalTokens}
          value={formatCompactNumber(totalTokens)}
          subtitle={zhCN.metrics.tokensInOut(
            formatCompactNumber(stats.TotalTokensIn),
            formatCompactNumber(stats.TotalTokensOut),
          )}
        />
      </GridItem>
      </Grid>
    </section>
  )
}
