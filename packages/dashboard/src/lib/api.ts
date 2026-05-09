const PRODUCTION_API_BASE = 'https://api.contrabass.dev'
const API_VERSION_HEADER = 'X-Contrabass-Api-Version'
const DEFAULT_DASHBOARD_API_VERSION = '1.0.0'

type ApiEnv = {
  VITE_CONTRABASS_API_BASE?: string
  VITE_CONTRABASS_API_VERSION?: string
  PROD?: boolean
}

export type VersionSkewState = {
  detected: boolean
  apiVersion: string | null
  dashboardApiVersion: string
}

type VersionSkewListener = (state: VersionSkewState) => void

const versionSkewListeners = new Set<VersionSkewListener>()

function normalizeApiBase(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed) {
    return undefined
  }

  return trimmed.replace(/\/+$/u, '')
}

function normalizeApiVersion(value: string | undefined): string {
  const trimmed = value?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_DASHBOARD_API_VERSION
}

export function resolveApiBase(env: ApiEnv | undefined = import.meta.env): string {
  return normalizeApiBase(env?.VITE_CONTRABASS_API_BASE) ?? (env?.PROD ? PRODUCTION_API_BASE : '')
}

export function resolveDashboardApiVersion(env: ApiEnv | undefined = import.meta.env): string {
  return normalizeApiVersion(env?.VITE_CONTRABASS_API_VERSION)
}

const CONTRABASS_API_BASE = resolveApiBase()
const DASHBOARD_API_VERSION = resolveDashboardApiVersion()

let versionSkewState: VersionSkewState = {
  detected: false,
  apiVersion: null,
  dashboardApiVersion: DASHBOARD_API_VERSION,
}

export class VersionSkewError extends Error {
  constructor(state: VersionSkewState) {
    super(`API version ${state.apiVersion ?? 'unknown'} requires dashboard reload`)
    this.name = 'VersionSkewError'
  }
}

export function apiUrl(path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  if (!CONTRABASS_API_BASE) {
    return normalizedPath
  }

  return `${CONTRABASS_API_BASE}${normalizedPath}`
}

function majorVersion(value: string): number | undefined {
  const match = /^(\d+)/u.exec(value.trim())
  if (!match) {
    return undefined
  }

  const major = Number.parseInt(match[1], 10)
  return Number.isFinite(major) ? major : undefined
}

export function isIncompatibleApiVersion(apiVersion: string, dashboardApiVersion = DASHBOARD_API_VERSION): boolean {
  const apiMajor = majorVersion(apiVersion)
  const dashboardMajor = majorVersion(dashboardApiVersion)
  return apiMajor !== undefined && dashboardMajor !== undefined && apiMajor > dashboardMajor
}

export function getVersionSkewState(): VersionSkewState {
  return versionSkewState
}

export function subscribeVersionSkew(listener: VersionSkewListener): () => void {
  versionSkewListeners.add(listener)
  listener(versionSkewState)

  return () => {
    versionSkewListeners.delete(listener)
  }
}

function publishVersionSkew(state: VersionSkewState): void {
  versionSkewState = state
  for (const listener of versionSkewListeners) {
    listener(state)
  }
}

function observeApiVersion(response: Response): void {
  const apiVersion = response.headers.get(API_VERSION_HEADER)
  if (!apiVersion || !isIncompatibleApiVersion(apiVersion)) {
    return
  }

  if (versionSkewState.detected && versionSkewState.apiVersion === apiVersion) {
    return
  }

  publishVersionSkew({
    detected: true,
    apiVersion,
    dashboardApiVersion: DASHBOARD_API_VERSION,
  })
}

function requestMethod(init: RequestInit): string {
  return (init.method ?? 'GET').toUpperCase()
}

function isSafeMethod(method: string): boolean {
  return method === 'GET' || method === 'HEAD' || method === 'OPTIONS'
}

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (versionSkewState.detected && !isSafeMethod(requestMethod(init))) {
    throw new VersionSkewError(versionSkewState)
  }

  const response = await fetch(apiUrl(path), {
    ...init,
    credentials: init.credentials ?? 'include',
  })
  observeApiVersion(response)
  return response
}

export function createApiEventSource(path: string): EventSource {
  return new EventSource(apiUrl(path), { withCredentials: true })
}

export function resetVersionSkewForTests(): void {
  publishVersionSkew({
    detected: false,
    apiVersion: null,
    dashboardApiVersion: DASHBOARD_API_VERSION,
  })
}
