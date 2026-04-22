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

export type SyncDeviceStatus = {
  deviceId: string
  appVersion: string
  status: string
  lastSeenAt: string | null
  pendingOutboxChanges: number
  readyOutboxChanges: number
  stalledOutboxChanges: number
  nextRetryAt: string | null
  isCurrentDevice: boolean
}

export type SyncConflictEntry = {
  id: string
  scopeId: string
  restaurantId: string | null
  entityType: string
  entityId: string
  reason: string
  localMutationId: string | null
  remoteMutationId: string | null
  localChange: { operation: 'upsert' | 'delete'; payload: unknown } | null
  remoteChange: { operation: 'upsert' | 'delete'; payload: unknown } | null
  createdAt: string
}

export type OwnerSyncStatus = {
  restaurantId: string
  currentDeviceId: string
  currentStatus: 'idle' | 'syncing' | 'failed'
  branchLinked: boolean
  serverManagedConfigured: boolean
  canServerManagedSync: boolean
  recoveryRequired: boolean
  failedBatchCount: number
  processingBatchCount: number
  pendingTransactions: number
  pendingSummaries: number
  pendingOutboxChanges: number
  readyOutboxChanges: number
  stalledOutboxChanges: number
  nextRetryAt: string | null
  lastAttemptAt: string | null
  lastSuccessAt: string | null
  lastErrorAt: string | null
  lastErrorMessage: string | null
  consecutiveFailures: number
  lastSyncedTransactions: number
  lastSyncedSummaries: number
  syncConflictCount: number
  devices: SyncDeviceStatus[]
  recentEvents: Array<{
    id: string
    status: 'success' | 'failure'
    message: string
    syncedTransactions: number
    syncedSummaries: number
    consecutiveFailures: number
    createdAt: string
  }>
  recentBatches: Array<{
    id: string
    batchId: string
    status: string
    errorMessage: string | null
    syncedTransactions: number
    syncedSummaries: number
    receivedAt: string
    appliedAt: string | null
    updatedAt: string
  }>
}

export type OwnerSyncResult = {
  ok: boolean
  message: string
  consecutiveFailures: number
  syncedTransactions?: number
  syncedSummaries?: number
}

type ConflictResolution = 'accept_local' | 'accept_remote'

const STORAGE_KEY = 'magnify.ownerSync.config'

type StoredOwnerSyncConfig = Partial<Pick<OwnerSyncConfig, 'enabled' | 'targetUrl' | 'email' | 'password'>>

function readStoredOwnerSyncConfig(): StoredOwnerSyncConfig | null {
  if (typeof window === 'undefined') return null

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as StoredOwnerSyncConfig | null
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function normalizeSyncTargetUrl(value: string) {
  return String(value || '').trim().replace(/\/+$/, '')
}

function dispatchOwnerSyncRunState(syncing: boolean) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent('ownerSyncRunStateChanged', { detail: { syncing } }))
}

export function loadOwnerSyncConfig(serverConfig?: ServerOwnerSyncConfig | null): OwnerSyncConfig {
  const stored = readStoredOwnerSyncConfig()
  const storedTargetUrl = typeof stored?.targetUrl === 'string' ? normalizeSyncTargetUrl(stored.targetUrl) : ''
  const storedEmail = typeof stored?.email === 'string' ? stored.email.trim().toLowerCase() : ''
  const storedPassword = typeof stored?.password === 'string' ? stored.password : ''

  return {
    enabled: typeof stored?.enabled === 'boolean'
      ? stored.enabled
      : Boolean(serverConfig?.configured && !stored),
    targetUrl: storedTargetUrl || normalizeSyncTargetUrl(String(serverConfig?.targetUrl ?? '')),
    email: storedEmail || String(serverConfig?.email ?? '').trim().toLowerCase(),
    password: storedPassword,
  }
}

export function saveOwnerSyncConfig(config: OwnerSyncConfig) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
    enabled: config.enabled,
    targetUrl: normalizeSyncTargetUrl(config.targetUrl),
    email: config.email.trim().toLowerCase(),
    password: config.password,
  }))
  window.dispatchEvent(new CustomEvent('ownerSyncConfigChanged', { detail: { enabled: config.enabled } }))
}

export function seedOwnerSyncConfigFromLogin(params: {
  email: string
  password: string
  targetUrl?: string | null
  serverConfig?: ServerOwnerSyncConfig | null
}) {
  if (typeof window === 'undefined') return null

  const targetUrl = normalizeSyncTargetUrl(params.targetUrl || params.serverConfig?.targetUrl || '')
  const email = params.email.trim().toLowerCase()
  const password = params.password

  if (!targetUrl || !email || !password) return null

  const nextConfig: OwnerSyncConfig = {
    enabled: true,
    targetUrl,
    email,
    password,
  }

  const current = loadOwnerSyncConfig(params.serverConfig)
  if (
    current.enabled === nextConfig.enabled
    && current.targetUrl === nextConfig.targetUrl
    && current.email === nextConfig.email
    && current.password === nextConfig.password
  ) {
    return nextConfig
  }

  saveOwnerSyncConfig(nextConfig)
  return nextConfig
}

export function getOwnerSyncRetryDelayMs(consecutiveFailures: number) {
  const normalizedFailures = Math.max(0, Number(consecutiveFailures) || 0)
  if (normalizedFailures <= 0) return 30_000
  return Math.min(300_000, 30_000 * (2 ** Math.min(normalizedFailures, 4)))
}

export async function loadOwnerSyncStatus(): Promise<OwnerSyncStatus | null> {
  try {
    const res = await fetch('/api/sync/status', { credentials: 'include', cache: 'no-store' })
    if (!res.ok) return null
    const payload = await res.json().catch(() => null)
    if (!payload) return null
    return {
      restaurantId: String(payload.restaurantId ?? ''),
      currentDeviceId: String(payload.currentDeviceId ?? ''),
      currentStatus: payload.currentStatus === 'failed' ? 'failed' : payload.currentStatus === 'syncing' ? 'syncing' : 'idle',
      branchLinked: Boolean(payload.branchLinked),
      serverManagedConfigured: Boolean(payload.serverManagedConfigured),
      canServerManagedSync: Boolean(payload.canServerManagedSync),
      recoveryRequired: Boolean(payload.recoveryRequired),
      failedBatchCount: Number(payload.failedBatchCount ?? 0),
      processingBatchCount: Number(payload.processingBatchCount ?? 0),
      pendingTransactions: Number(payload.pendingTransactions ?? 0),
      pendingSummaries: Number(payload.pendingSummaries ?? 0),
      pendingOutboxChanges: Number(payload.pendingOutboxChanges ?? 0),
      readyOutboxChanges: Number(payload.readyOutboxChanges ?? 0),
      stalledOutboxChanges: Number(payload.stalledOutboxChanges ?? 0),
      nextRetryAt: payload.nextRetryAt ? String(payload.nextRetryAt) : null,
      lastAttemptAt: payload.lastAttemptAt ? String(payload.lastAttemptAt) : null,
      lastSuccessAt: payload.lastSuccessAt ? String(payload.lastSuccessAt) : null,
      lastErrorAt: payload.lastErrorAt ? String(payload.lastErrorAt) : null,
      lastErrorMessage: payload.lastErrorMessage ? String(payload.lastErrorMessage) : null,
      consecutiveFailures: Number(payload.consecutiveFailures ?? 0),
      lastSyncedTransactions: Number(payload.lastSyncedTransactions ?? 0),
      lastSyncedSummaries: Number(payload.lastSyncedSummaries ?? 0),
      syncConflictCount: Number(payload.syncConflictCount ?? 0),
      devices: Array.isArray(payload.devices)
        ? payload.devices.map((device) => ({
            deviceId: String(device?.deviceId ?? ''),
            appVersion: String(device?.appVersion ?? 'unknown'),
            status: String(device?.status ?? 'unknown'),
            lastSeenAt: device?.lastSeenAt ? String(device.lastSeenAt) : null,
            pendingOutboxChanges: Number(device?.pendingOutboxChanges ?? 0),
            readyOutboxChanges: Number(device?.readyOutboxChanges ?? 0),
            stalledOutboxChanges: Number(device?.stalledOutboxChanges ?? 0),
            nextRetryAt: device?.nextRetryAt ? String(device.nextRetryAt) : null,
            isCurrentDevice: Boolean(device?.isCurrentDevice),
          }))
        : [],
      recentEvents: Array.isArray(payload.recentEvents)
        ? payload.recentEvents.map((event) => ({
            id: String(event?.id ?? ''),
            status: event?.status === 'failure' ? 'failure' : 'success',
            message: String(event?.message ?? ''),
            syncedTransactions: Number(event?.syncedTransactions ?? 0),
            syncedSummaries: Number(event?.syncedSummaries ?? 0),
            consecutiveFailures: Number(event?.consecutiveFailures ?? 0),
            createdAt: String(event?.createdAt ?? ''),
          }))
        : [],
      recentBatches: Array.isArray(payload.recentBatches)
        ? payload.recentBatches.map((batch) => ({
            id: String(batch?.id ?? ''),
            batchId: String(batch?.batchId ?? ''),
            status: String(batch?.status ?? ''),
            errorMessage: batch?.errorMessage ? String(batch.errorMessage) : null,
            syncedTransactions: Number(batch?.syncedTransactions ?? 0),
            syncedSummaries: Number(batch?.syncedSummaries ?? 0),
            receivedAt: String(batch?.receivedAt ?? ''),
            appliedAt: batch?.appliedAt ? String(batch.appliedAt) : null,
            updatedAt: String(batch?.updatedAt ?? ''),
          }))
        : [],
    }
  } catch {
    return null
  }
}

export async function loadSyncConflicts(): Promise<SyncConflictEntry[]> {
  try {
    const res = await fetch('/api/sync/conflicts', { credentials: 'include', cache: 'no-store' })
    if (!res.ok) return []
    const payload = await res.json().catch(() => null)
    if (!payload || !Array.isArray(payload.conflicts)) return []

    return payload.conflicts.map((conflict) => ({
      id: String(conflict?.id ?? ''),
      scopeId: String(conflict?.scopeId ?? ''),
      restaurantId: conflict?.restaurantId ? String(conflict.restaurantId) : null,
      entityType: String(conflict?.entityType ?? ''),
      entityId: String(conflict?.entityId ?? ''),
      reason: String(conflict?.reason ?? ''),
      localMutationId: conflict?.localMutationId ? String(conflict.localMutationId) : null,
      remoteMutationId: conflict?.remoteMutationId ? String(conflict.remoteMutationId) : null,
      localChange: conflict?.localChange && typeof conflict.localChange === 'object'
        ? {
            operation: conflict.localChange.operation === 'delete' ? 'delete' : 'upsert',
            payload: conflict.localChange.payload,
          }
        : null,
      remoteChange: conflict?.remoteChange && typeof conflict.remoteChange === 'object'
        ? {
            operation: conflict.remoteChange.operation === 'delete' ? 'delete' : 'upsert',
            payload: conflict.remoteChange.payload,
          }
        : null,
      createdAt: String(conflict?.createdAt ?? ''),
    }))
  } catch {
    return []
  }
}

export async function resolveSyncConflict(conflictId: string, resolution: ConflictResolution) {
  const res = await fetch(`/api/sync/conflicts/${conflictId}/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ resolution }),
  })

  const payload = await res.json().catch(() => null)
  if (!res.ok) {
    return {
      ok: false,
      error: payload?.error ? String(payload.error) : 'Failed to resolve conflict.',
    }
  }

  return { ok: true }
}

export async function retryStalledSyncOutbox() {
  const res = await fetch('/api/sync/outbox/retry', {
    method: 'POST',
    credentials: 'include',
  })

  const payload = await res.json().catch(() => null)
  if (!res.ok) {
    return {
      ok: false,
      error: payload?.error ? String(payload.error) : 'Failed to requeue stalled sync changes.',
      resetCount: 0,
    }
  }

  return {
    ok: true,
    resetCount: Number(payload?.resetCount ?? 0),
  }
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

export async function syncOwnerCloud(config?: OwnerSyncConfig, options?: { ignoreEnabled?: boolean }): Promise<OwnerSyncResult> {
  const current = config ?? loadOwnerSyncConfig()
  if (!options?.ignoreEnabled && !current.enabled) return { ok: false, message: 'Auto sync is disabled.', consecutiveFailures: 0 }

  dispatchOwnerSyncRunState(true)

  try {
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
      return {
        ok: false,
        message: payload?.message || payload?.error || 'Owner cloud sync failed.',
        consecutiveFailures: Number(payload?.consecutiveFailures ?? 1),
      }
    }

    const payload = await syncRes.json().catch(() => null)
    return {
      ok: true,
      message: payload?.message || 'Owner cloud sync completed.',
      consecutiveFailures: Number(payload?.consecutiveFailures ?? 0),
      syncedTransactions: Number(payload?.syncedTransactions ?? 0),
      syncedSummaries: Number(payload?.syncedSummaries ?? 0),
    }
  } finally {
    dispatchOwnerSyncRunState(false)
  }
}