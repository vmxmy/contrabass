import { describe, expect, it } from 'bun:test'
import { apiFetch, apiUrl, createApiEventSource, resolveApiBase } from './api'

describe('dashboard API client', () => {
  it('uses the production API by default for production builds', () => {
    expect(resolveApiBase({ PROD: true })).toBe('https://api.contrabass.dev')
  })

  it('uses VITE_CONTRABASS_API_BASE when provided', () => {
    expect(resolveApiBase({ PROD: true, VITE_CONTRABASS_API_BASE: 'https://api.staging.contrabass.dev/' })).toBe(
      'https://api.staging.contrabass.dev',
    )
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
