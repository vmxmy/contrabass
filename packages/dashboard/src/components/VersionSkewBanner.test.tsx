import { afterEach, describe, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { VersionSkewBanner } from './VersionSkewBanner'
import { apiFetch, resetVersionSkewForTests } from '../lib/api'

const originalFetch = globalThis.fetch
const originalLocation = window.location

afterEach(() => {
  globalThis.fetch = originalFetch
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: originalLocation,
  })
  resetVersionSkewForTests()
  cleanup()
})

describe('VersionSkewBanner', () => {
  it('renders reload prompt after observing a newer API major', async () => {
    globalThis.fetch = Object.assign(
      async () => Response.json(
        { ok: true },
        { headers: { 'X-Contrabass-Api-Version': '2.0.0' } },
      ),
      { preconnect: originalFetch.preconnect },
    )

    render(<VersionSkewBanner />)
    expect(screen.queryByRole('alert')).toBeNull()

    await act(async () => {
      await apiFetch('/v1/teams')
    })

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('A new dashboard version is available — reload to continue'))
    expect(screen.getByRole('alert').textContent).toContain('API 2.0.0')
  })

  it('reloads the page from its non-dismissible action', async () => {
    let reloaded = false
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, reload: () => { reloaded = true } },
    })
    globalThis.fetch = Object.assign(
      async () => Response.json(
        { ok: true },
        { headers: { 'X-Contrabass-Api-Version': '2.0.0' } },
      ),
      { preconnect: originalFetch.preconnect },
    )

    render(<VersionSkewBanner />)
    await act(async () => {
      await apiFetch('/v1/teams')
    })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))

    expect(reloaded).toBe(true)
  })
})
