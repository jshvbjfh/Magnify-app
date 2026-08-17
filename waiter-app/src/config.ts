type WaiterImportMetaEnv = {
  DEV?: boolean
  PROD?: boolean
  MODE?: string
  VITE_API_BASE_URL?: string
}

type WaiterImportMeta = ImportMeta & {
  env?: WaiterImportMetaEnv
}

const waiterEnv = (import.meta as WaiterImportMeta).env ?? {}

function getRuntimeOrigin() {
  if (typeof window === 'undefined') return ''
  const origin = String(window.location?.origin ?? '').trim()
  if (!/^https?:\/\//i.test(origin)) return ''

  try {
    const { hostname } = new URL(origin)
    const normalizedHost = hostname.trim().toLowerCase()

    // In native Capacitor builds the web assets run from a local WebView origin
    // such as http://localhost. That host serves the bundled app shell, not the
    // remote API, so using it as API_BASE_URL returns HTML instead of JSON.
    if (
      normalizedHost === 'localhost'
      || normalizedHost === '127.0.0.1'
      || normalizedHost === '0.0.0.0'
      || normalizedHost === '[::1]'
    ) {
      return ''
    }

    return origin
  } catch {
    return ''
  }
}

const configuredApiBaseUrl = String(waiterEnv.VITE_API_BASE_URL ?? '').trim()
const resolvedApiBaseUrl = (configuredApiBaseUrl || getRuntimeOrigin()).replace(/\/$/, '')

function getApiConfigError(apiBaseUrl: string) {
  if (!apiBaseUrl) {
    return 'Waiter app API base URL is not configured. Rebuild with VITE_API_BASE_URL set to the deployed API base URL.'
  }

  try {
    const { hostname } = new URL(apiBaseUrl)
    const normalizedHost = hostname.trim().toLowerCase()

    if (
      normalizedHost === 'your-real-api-host.example.com'
      || normalizedHost.endsWith('.example.com')
      || normalizedHost.endsWith('.example.org')
      || normalizedHost.endsWith('.example.net')
    ) {
      return 'Waiter app API base URL is still using the placeholder example host. Rebuild with VITE_API_BASE_URL set to the real deployed API base URL.'
    }
  } catch {
    return 'Waiter app API base URL is invalid. Rebuild with VITE_API_BASE_URL set to a valid https URL.'
  }

  return null
}

// Native/production builds must inject an explicit API base URL so the APK
// never silently falls back to a stale baked host.
export const API_CONFIG_ERROR = getApiConfigError(resolvedApiBaseUrl)

// Prefer an explicit override first, then fall back to the origin that served
// the waiter bundle so hosted web assets and API stay version-aligned.
export const API_BASE_URL = API_CONFIG_ERROR ? '' : resolvedApiBaseUrl

function buildApiUrl(path: string) {
  return API_BASE_URL ? `${API_BASE_URL}${path}` : ''
}

export const API = {
  /** POST — exchange email+password for a session token */
  login: buildApiUrl('/api/mobile/auth'),
  /** GET  — pull dishes + tables for this branch from Neon */
  pull: buildApiUrl('/api/mobile/pull'),
  /** POST — push unsynced orders to Neon */
  push: buildApiUrl('/api/mobile/push'),
  /** POST — cancel a confirmed order with supervisor PIN */
  cancelOrder: buildApiUrl('/api/mobile/cancel-order'),
  /** POST — MEP list management + "qty prepared" logging */
  mep: buildApiUrl('/api/mobile/mep'),
  /** GET  — check for app updates */
  version: buildApiUrl('/api/version'),
}

// Bumped to 1.1.0 for the desktop-parity release (shifts, MEP, waiter gate,
// bill template, server-side order deletes). Set WAITER_ANDROID_VERSION on
// Vercel to match when the APK is published, or devices see no update prompt.
export const APP_VERSION = '1.1.0'
