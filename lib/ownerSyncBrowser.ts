export type OwnerSyncConfig = {
  enabled: boolean
  targetUrl: string
  email: string
  password: string
}

export type ServerOwnerSyncConfig = {
  configured: boolean
  targetUrl: string
  email: string
  usesSharedSecret: boolean
}

const STORAGE_KEY = 'magnify.ownerSync.config'

export function loadOwnerSyncConfig(): OwnerSyncConfig {
  if (typeof window === 'undefined') {
    return { enabled: false, targetUrl: '', email: '', password: '' }
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return { enabled: false, targetUrl: '', email: '', password: '' }
    const parsed = JSON.parse(raw) as Partial<OwnerSyncConfig>
    return {
      enabled: Boolean(parsed.enabled),
      targetUrl: String(parsed.targetUrl ?? ''),
      email: String(parsed.email ?? ''),
      password: String(parsed.password ?? ''),
    }
  } catch {
    return { enabled: false, targetUrl: '', email: '', password: '' }
  }
}

export function saveOwnerSyncConfig(config: OwnerSyncConfig) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
}

export async function loadServerOwnerSyncConfig(): Promise<ServerOwnerSyncConfig | null> {
  try {
    const res = await fetch('/api/sync/config', { credentials: 'include' })
    if (!res.ok) return null
    const payload = await res.json().catch(() => null)
    if (!payload) return null
    return {
      configured: Boolean(payload.configured),
      targetUrl: String(payload.targetUrl ?? ''),
      email: String(payload.email ?? ''),
      usesSharedSecret: Boolean(payload.usesSharedSecret),
    }
  } catch {
    return null
  }
}

export async function syncOwnerCloud(config?: OwnerSyncConfig) {
  const current = config ?? loadOwnerSyncConfig()
  if (!current.enabled) return { ok: false, message: 'Auto sync is disabled.' }

  const syncRes = await fetch('/api/sync/local', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      targetUrl: current.targetUrl,
      email: current.email,
      password: current.password,
    }),
  })

  if (!syncRes.ok) {
    const payload = await syncRes.json().catch(() => null)
    return { ok: false, message: payload?.error || 'Owner cloud sync failed.' }
  }

  const payload = await syncRes.json().catch(() => null)
  return { ok: true, message: payload?.message || 'Owner cloud sync completed.' }
}