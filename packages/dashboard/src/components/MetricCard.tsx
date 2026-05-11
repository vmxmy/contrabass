import { LayerCard, Text } from '@cloudflare/kumo'

interface MetricCardProps {
  title: string
  value: string | number
  subtitle?: string
}

export function MetricCard({ title, value, subtitle }: MetricCardProps) {
  return (
    <LayerCard className="p-4">
      <Text variant="secondary" size="sm">{title}</Text>
      <Text variant="heading2" as="p">{value}</Text>
      {subtitle ? <Text variant="secondary" size="sm">{subtitle}</Text> : null}
    </LayerCard>
  )
}
