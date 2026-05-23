import { getCanonicalCloudAppUrl } from '@/lib/cloudAuthBridge'
import { normalizeTargetUrl } from '@/lib/minimalSync'
import { hash } from 'bcryptjs'
import { randomUUID } from 'crypto'

type ProvisionedRestaurantSummary = {
  name: string
  joinCode?: string | null
  syncRestaurantId?: string | null
}

type CloudSyncRequestParams = {
  restaurant: ProvisionedRestaurantSummary
  syncTargetUrl?: string | null
  syncEmail?: string | null
  syncPassword?: string | null
  adminEmail?: string | null
}

type ResolvedCloudRestaurantIdentity = {
  id: string
  name: string
  joinCode: string | null
  syncRestaurantId: string | null
}

function pickFirstNonEmpty(...values: Array<string | null | undefined>) {
  for (const value of values) {
    const normalized = String(value ?? '').trim()
    if (normalized) return normalized
  }
  return ''
}

function pickFirstSecret(...values: Array<string | null | undefined>) {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  return ''
}

function resolveCloudSyncConfig(
  params: CloudSyncRequestParams,
  options?: { preferExplicitEmail?: boolean },
) {
  const targetUrl = pickFirstNonEmpty(params.syncTargetUrl, process.env.OWNER_SYNC_TARGET_URL, getCanonicalCloudAppUrl())
  const syncEmail = options?.preferExplicitEmail
    ? pickFirstNonEmpty(params.syncEmail, params.adminEmail, process.env.OWNER_SYNC_EMAIL).toLowerCase()
    : pickFirstNonEmpty(params.syncEmail, process.env.OWNER_SYNC_EMAIL, params.adminEmail).toLowerCase()
  const syncPassword = pickFirstSecret(params.syncPassword, process.env.OWNER_SYNC_PASSWORD)
  const sharedSecret = String(process.env.OWNER_SYNC_SHARED_SECRET ?? '').trim()
  return { targetUrl, syncEmail, syncPassword, sharedSecret }
}

export async function resolveCloudRestaurantIdentity(params: CloudSyncRequestParams): Promise<
  | { ok: true; restaurant: ResolvedCloudRestaurantIdentity }
  | { ok: false; status: number; error: string }
> {
  const { targetUrl, syncEmail, syncPassword, sharedSecret } = resolveCloudSyncConfig(params, {
    preferExplicitEmail: true,
  })
  if (!targetUrl || !syncEmail || (!syncPassword && !sharedSecret)) {
    return {
      ok: false,
      status: 503,
      error: 'Magnify cloud sync is not configured on this restaurant desktop yet.',
    }
  }

  const restaurantSyncId = String(params.restaurant.syncRestaurantId ?? '').trim()

  try {
    const res = await fetch(`${normalizeTargetUrl(targetUrl)}/api/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-sync-email': syncEmail,
        ...(sharedSecret ? { 'x-sync-secret': sharedSecret } : { 'x-sync-password': syncPassword }),
      },
      body: JSON.stringify({
        resolveRestaurantOnly: true,
        ...(restaurantSyncId ? { restaurantSyncId } : {}),
      }),
      cache: 'no-store',
    })

    const payload = await res.json().catch(() => null)
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: String(payload?.error ?? 'Could not verify the linked cloud restaurant for this desktop.'),
      }
    }

    const restaurant = payload?.restaurant
    if (!restaurant || typeof restaurant.id !== 'string') {
      return {
        ok: false,
        status: 502,
        error: 'Magnify cloud did not return a restaurant identity for this desktop.',
      }
    }

    return {
      ok: true,
      restaurant: {
        id: restaurant.id,
        name: String(restaurant.name ?? '').trim() || params.restaurant.name,
        joinCode: typeof restaurant.joinCode === 'string' && restaurant.joinCode.trim()
          ? restaurant.joinCode.trim().toUpperCase()
          : null,
        syncRestaurantId: typeof restaurant.syncRestaurantId === 'string' && restaurant.syncRestaurantId.trim()
          ? restaurant.syncRestaurantId.trim()
          : null,
      },
    }
  } catch {
    return {
      ok: false,
      status: 503,
      error: 'Could not reach Magnify cloud to verify this restaurant desktop.',
    }
  }
}

export async function provisionRestaurantAccountInCloud(params: {
  restaurant: ProvisionedRestaurantSummary
  role: 'owner' | 'waiter' | 'kitchen'
  name: string
  email: string
  password: string
  staffId?: string | null
  branchId?: string | null
  syncTargetUrl?: string | null
  syncEmail?: string | null
  syncPassword?: string | null
  adminEmail?: string | null
}) {
  const { targetUrl, syncEmail, syncPassword, sharedSecret } = resolveCloudSyncConfig(params)
  const accountLabel = params.role === 'owner' ? 'Owner' : params.role === 'kitchen' ? 'Kitchen' : 'Waiter'
  const branchId = String(params.branchId ?? '').trim()

  if (!branchId) {
    return {
      ok: false as const,
      status: 400,
      error: `${accountLabel} cloud login requires an active branch. Select a branch, then try again.`,
    }
  }

  const joinCode = String(params.restaurant.joinCode ?? '').trim().toUpperCase()
  const restaurantSyncId = String(params.restaurant.syncRestaurantId ?? '').trim()
  if (!joinCode && !restaurantSyncId) {
    return {
      ok: false as const,
      status: 409,
      error: `${accountLabel} cloud login is not ready: restaurant cloud identity is missing. Complete restaurant setup, then try again.`,
    }
  }

  if (!targetUrl || !syncEmail || (!syncPassword && !sharedSecret)) {
    return {
      ok: false as const,
      status: 503,
      error: `${accountLabel} cloud login is not ready because Magnify cloud sync is not configured on this restaurant desktop yet.`,
    }
  }

  try {
    const passwordHash = await hash(params.password, 12)
    const mutationId = randomUUID()
    // Use the already-created local staff ID when available so cloud and local IDs match.
    const entityId = String(params.staffId ?? mutationId).trim() || mutationId

    const change = {
      mutationId,
      scopeId: joinCode,
      restaurantId: null,
      branchId,
      entityType: 'staff',
      entityId,
      operation: 'upsert' as const,
      payload: {
        id: entityId,
        restaurantId: joinCode,
        branchId,
        name: params.name,
        username: params.email.trim().toLowerCase(),
        password: passwordHash,
        role: params.role,
        isActive: true,
      },
      sourceDeviceId: process.env.MAGNIFY_DEVICE_ID ?? 'desktop',
      createdAt: new Date().toISOString(),
    }

    const res = await fetch(`${normalizeTargetUrl(targetUrl)}/api/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-sync-email': syncEmail,
        ...(sharedSecret ? { 'x-sync-secret': sharedSecret } : { 'x-sync-password': syncPassword }),
      },
      body: JSON.stringify({
        joinCode,
        ...(restaurantSyncId ? { restaurantSyncId } : {}),
        batchId: `provision-${mutationId.slice(0, 16)}`,
        payloadHash: mutationId,
        deviceId: process.env.MAGNIFY_DEVICE_ID ?? 'desktop',
        branchId,
        changes: [change],
        pullCursors: [],
      }),
      cache: 'no-store',
    })

    const payload = await res.json().catch(() => null)
    if (!res.ok) {
      return {
        ok: false as const,
        status: res.status,
        error: String(payload?.error ?? `Could not provision the ${accountLabel.toLowerCase()} account for cloud login.`),
      }
    }

    return { ok: true as const }
  } catch {
    return {
      ok: false as const,
      status: 503,
      error: `Could not reach Magnify cloud to provision this ${accountLabel.toLowerCase()} account.`,
    }
  }
}
