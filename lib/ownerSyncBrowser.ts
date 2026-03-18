export type OwnerSyncConfig = {
  enabled: boolean
  targetUrl: string
  email: string
  password: string
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

function normalizeTargetUrl(value: string) {
  return value.trim().replace(/\/$/, '')
}

export async function syncOwnerCloud(config?: OwnerSyncConfig) {
  const current = config ?? loadOwnerSyncConfig()
  if (!current.enabled) return { ok: false, message: 'Auto sync is disabled.' }
  if (!current.targetUrl || !current.email || !current.password) {
    return { ok: false, message: 'Sync target URL, email, and password are required.' }
  }

  const exportRes = await fetch('/api/restaurant/sync/export', { credentials: 'include' })
  if (!exportRes.ok) {
    const text = await exportRes.text()
    return { ok: false, message: text || 'Failed to export local branch snapshot.' }
  }

  const { snapshot } = await exportRes.json()
  const importRes = await fetch(`${normalizeTargetUrl(current.targetUrl)}/api/restaurant/sync/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: current.email,
      password: current.password,
      snapshot,
    }),
  })

  if (!importRes.ok) {
    const payload = await importRes.json().catch(() => null)
    return { ok: false, message: payload?.error || 'Remote owner sync failed.' }
  }

  return { ok: true, message: 'Owner cloud sync completed.' }
}