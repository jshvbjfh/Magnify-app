const RESTAURANT_DEVICE_SNAPSHOT_PREFIX = 'magnify.restaurantDeviceSnapshot.v1'

function canUseStorage() {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'
}

function buildSnapshotKey(scopeId: string) {
  return `${RESTAURANT_DEVICE_SNAPSHOT_PREFIX}:${scopeId}`
}

export function buildRestaurantSnapshotScope(params: {
  restaurantId?: string | null
  branchId?: string | null
  fallbackUserId?: string | null
}) {
  const restaurantId = String(params.restaurantId ?? '').trim()
  if (restaurantId) {
    const branchId = String(params.branchId ?? '').trim() || 'main'
    return `${restaurantId}:${branchId}`
  }

  const fallbackUserId = String(params.fallbackUserId ?? '').trim()
  return fallbackUserId || null
}

export function loadRestaurantDeviceSnapshot<T>(scopeId: string) {
  if (!canUseStorage()) return null as T | null

  try {
    const raw = window.localStorage.getItem(buildSnapshotKey(scopeId))
    if (!raw) return null
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

export function mergeRestaurantDeviceSnapshot<T extends Record<string, unknown>>(
  scopeId: string,
  partial: Partial<T>,
) {
  if (!canUseStorage()) return null as (T & { updatedAt: string }) | null

  const current = loadRestaurantDeviceSnapshot<T & { updatedAt?: string }>(scopeId) ?? {}
  const next = {
    ...current,
    ...partial,
    updatedAt: new Date().toISOString(),
  } as T & { updatedAt: string }

  window.localStorage.setItem(buildSnapshotKey(scopeId), JSON.stringify(next))
  return next
}