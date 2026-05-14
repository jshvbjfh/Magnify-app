// Desktop config — checks window.electronConfig first (injected by preload),
// then falls back to Vite env vars.

function getApiBaseUrl(): string | null {
  // Injected by preload.js from runtime.env
  const w = window as unknown as { electronConfig?: { apiBaseUrl?: string } }
  if (w.electronConfig?.apiBaseUrl) return w.electronConfig.apiBaseUrl

  // Vite build-time fallback
  const viteUrl = import.meta.env.VITE_API_BASE_URL as string | undefined
  return viteUrl ?? null
}

function buildApiUrl(path: string): string | null {
  const base = getApiBaseUrl()
  if (!base) return null
  return `${base.replace(/\/$/, '')}${path}`
}

export const API_BASE_URL = getApiBaseUrl()

export const API_CONFIG_ERROR: string | null = API_BASE_URL
  ? null
  : 'API base URL is not configured. Set WAITER_API_BASE_URL in runtime.env.'

export const API = {
  /** POST — exchange email+password for a session token */
  login: buildApiUrl('/api/mobile/auth'),
  /** GET  — pull dishes + tables for this branch from Neon */
  pull: buildApiUrl('/api/mobile/pull'),
  /** POST — push unsynced orders to Neon */
  push: buildApiUrl('/api/mobile/push'),
  /** POST — cancel a confirmed order with supervisor PIN */
  cancelOrder: buildApiUrl('/api/mobile/cancel-order'),
}
