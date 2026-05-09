import { useEffect, useState } from 'react'
import { getVersionSkewState, subscribeVersionSkew, type VersionSkewState } from '../lib/api'

export function VersionSkewBanner() {
  const [state, setState] = useState<VersionSkewState>(() => getVersionSkewState())

  useEffect(() => subscribeVersionSkew(setState), [])

  if (!state.detected) {
    return null
  }

  return (
    <div
      className="flex flex-wrap items-center gap-3 border-b border-amber-500/50 bg-amber-500/15 px-4 py-3 text-sm font-medium text-amber-800"
      role="alert"
    >
      <span>A new dashboard version is available — reload to continue</span>
      <span className="font-mono text-xs text-amber-700">
        API {state.apiVersion} · dashboard {state.dashboardApiVersion}
      </span>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="ml-auto rounded-full border border-amber-500/60 bg-amber-500/20 px-3 py-1 text-xs font-semibold text-amber-900 transition hover:bg-amber-500/30"
      >
        Reload
      </button>
    </div>
  )
}
