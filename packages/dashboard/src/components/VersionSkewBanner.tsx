import { useEffect, useState } from 'react'
import { Banner, Button, Text } from '@cloudflare/kumo'
import { getVersionSkewState, subscribeVersionSkew, type VersionSkewState } from '../lib/api'

export function VersionSkewBanner() {
  const [state, setState] = useState<VersionSkewState>(() => getVersionSkewState())

  useEffect(() => subscribeVersionSkew(setState), [])

  if (!state.detected) {
    return null
  }

  return (
    <div role="alert">
      <Banner
        variant="alert"
        title="A new dashboard version is available — reload to continue"
        description={
          <Text as="span" variant="mono-secondary">
            API {state.apiVersion} · dashboard {state.dashboardApiVersion}
          </Text>
        }
        action={
          <Button type="button" size="sm" variant="primary" onClick={() => window.location.reload()}>
            Reload
          </Button>
        }
      />
    </div>
  )
}
