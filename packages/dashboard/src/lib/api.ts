const PRODUCTION_API_BASE = 'https://api.contrabass.dev'

type ApiEnv = {
  VITE_CONTRABASS_API_BASE?: string
  PROD?: boolean
}

function normalizeApiBase(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed) {
    return undefined
  }

  return trimmed.replace(/\/+$/u, '')
}

export function resolveApiBase(env: ApiEnv | undefined = import.meta.env): string {
  return normalizeApiBase(env?.VITE_CONTRABASS_API_BASE) ?? (env?.PROD ? PRODUCTION_API_BASE : '')
}

const CONTRABASS_API_BASE = resolveApiBase()

export function apiUrl(path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  if (!CONTRABASS_API_BASE) {
    return normalizedPath
  }

  return `${CONTRABASS_API_BASE}${normalizedPath}`
}

export function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(apiUrl(path), {
    ...init,
    credentials: init.credentials ?? 'include',
  })
}

export function createApiEventSource(path: string): EventSource {
  return new EventSource(apiUrl(path), { withCredentials: true })
}
