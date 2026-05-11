import { Empty, Grid, GridItem, LayerCard, Text } from '@cloudflare/kumo'
import { formatTime } from '../i18n/format'
import { zhCN } from '../i18n/messages'

interface RateLimit {
  name: string
  remaining: number
  resetAt: string
}

interface RateLimitsProps {
  limits: RateLimit[]
}

function formatResetTime(resetAt: string): string {
  return formatTime(resetAt)
}

export function RateLimits({ limits }: RateLimitsProps) {
  if (limits.length === 0) {
    return <Empty size="sm" title={zhCN.rateLimits.empty} />
  }

  return (
    <section aria-label={zhCN.rateLimits.ariaLabel}>
      <Grid variant="3up" gap="sm">
        {limits.map((limit) => (
          <GridItem key={limit.name}>
            <LayerCard className="p-4">
              <dl className="grid gap-2">
                <div>
                  <Text as="dt" variant="secondary" size="sm">{zhCN.rateLimits.labels.limit}</Text>
                  <Text as="dd">{limit.name}</Text>
                </div>
                <div>
                  <Text as="dt" variant="secondary" size="sm">{zhCN.rateLimits.labels.remaining}</Text>
                  <Text as="dd" variant="mono">{limit.remaining}</Text>
                </div>
                <div>
                  <Text as="dt" variant="secondary" size="sm">{zhCN.rateLimits.labels.reset}</Text>
                  <Text as="dd" variant="mono">{formatResetTime(limit.resetAt)}</Text>
                </div>
              </dl>
            </LayerCard>
          </GridItem>
        ))}
      </Grid>
    </section>
  )
}
