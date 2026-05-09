import { afterEach, describe, expect, it } from 'bun:test'
import {
  VersionSkewError,
  apiFetch,
  apiUrl,
  createApiEventSource,
  getVersionSkewState,
  isIncompatibleApiVersion,
  resetVersionSkewForTests,
  resolveApiBase,
  resolveDashboardApiVersion,
} from './api'

afterEach(() => {
  resetVersionSkewForTests()
})

describe('dashboard API client', () => {
  it('uses the production API by default for production builds', () => {
    expect(resolveApiBase({ PROD: true })).toBe('https://api.contrabass.dev')
  })

  it('uses VITE_CONTRABASS_API_BASE when provided', () => {
    expect(resolveApiBase({ PROD: true, VITE_CONTRABASS_API_BASE: 'https://api.staging.contrabass.dev/' })).toBe(
      'https://api.staging.contrabass.dev',
    )
  })


  it('resolves the dashboard API compatibility version from build env', () => {
    expect(resolveDashboardApiVersion({ VITE_CONTRABASS_API_VERSION: '2.3.4' })).toBe('2.3.4')
    expect(resolveDashboardApiVersion({})).toBe('1.0.0')
  })

  it('treats higher API majors as incompatible', () => {
    expect(isIncompatibleApiVersion('2.0.0', '1.7.0')).toBe(true)
    expect(isIncompatibleApiVersion('1.8.0', '1.7.0')).toBe(false)
    expect(isIncompatibleApiVersion('0.9.0', '1.7.0')).toBe(false)
  })

  it('keeps local development requests relative when no base is configured', () => {
    expect(resolveApiBase({ PROD: false })).toBe('')
    expect(apiUrl('/api/v1/state')).toBe('/api/v1/state')
  })

  it('includes credentials on fetch requests for httpOnly session cookies', async () => {
    const originalFetch = globalThis.fetch
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    const fetchMock: typeof fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ input, init })
        return Response.json({ ok: true })
      },
      { preconnect: originalFetch.preconnect },
    )
    globalThis.fetch = fetchMock

    try {
      await apiFetch('/api/v1/state')
      expect(calls).toEqual([{ input: '/api/v1/state', init: { credentials: 'include' } }])
    } finally {
      globalThis.fetch = originalFetch
    }
  })


  it('detects API major skew from response headers and blocks later mutations', async () => {
    const originalFetch = globalThis.fetch
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    const fetchMock: typeof fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ input, init })
        return Response.json(
          { ok: true },
          { headers: { 'X-Contrabass-Api-Version': '2.0.0' } },
        )
      },
      { preconnect: originalFetch.preconnect },
    )
    globalThis.fetch = fetchMock

    try {
      await apiFetch('/v1/teams')
      expect(getVersionSkewState()).toEqual({
        detected: true,
        apiVersion: '2.0.0',
        dashboardApiVersion: '1.0.0',
      })
      await expect(apiFetch('/v1/teams/team-a/board/refresh', { method: 'POST' })).rejects.toBeInstanceOf(VersionSkewError)
      expect(calls).toHaveLength(1)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('includes credentials on EventSource subscriptions', () => {
    const originalEventSource = globalThis.EventSource
    const calls: Array<{ url: string | URL; init?: EventSourceInit }> = []

    class MockEventSource extends EventTarget {
      static readonly CONNECTING = 0
      static readonly OPEN = 1
      static readonly CLOSED = 2
      readonly CONNECTING = 0
      readonly OPEN = 1
      readonly CLOSED = 2
      readonly readyState = 0
      readonly url: string
      readonly withCredentials: boolean
      onerror: ((this: EventSource, ev: Event) => unknown) | null = null
      onmessage: ((this: EventSource, ev: MessageEvent) => unknown) | null = null
      onopen: ((this: EventSource, ev: Event) => unknown) | null = null

      constructor(url: string | URL, init?: EventSourceInit) {
        super()
        calls.push({ url, init })
        this.url = String(url)
        this.withCredentials = init?.withCredentials ?? false
      }

      close(): void {}
    }

    globalThis.EventSource = MockEventSource as unknown as typeof EventSource

    try {
      createApiEventSource('/api/v1/events')
      expect(calls).toEqual([{ url: '/api/v1/events', init: { withCredentials: true } }])
    } finally {
      globalThis.EventSource = originalEventSource
    }
  })
})
