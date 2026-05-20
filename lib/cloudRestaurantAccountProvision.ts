import { getCanonicalCloudAppUrl } from '@/lib/cloudAuthBridge'
import { normalizeTargetUrl } from '@/lib/minimalSync'
import { hash } from 'bcryptjs'
import { randomUUID } from 'crypto'

type ProvisionedRestaurantSummary = {
  name: string
  joinCode?: string | null
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
  const targetUrl = pickFirstNonEmpty(params.syncTargetUrl, process.env.OWNER_SYNC_TARGET_URL, getCanonicalCloudAppUrl())
  const syncEmail = pickFirstNonEmpty(params.syncEmail, process.env.OWNER_SYNC_EMAIL, params.adminEmail).toLowerCase()
  const syncPassword = pickFirstSecret(params.syncPassword, process.env.OWNER_SYNC_PASSWORD)
  const sharedSecret = String(process.env.OWNER_SYNC_SHARED_SECRET ?? '').trim()
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
  if (!joinCode) {
    return {
      ok: false as const,
      status: 409,
      error: `${accountLabel} cloud login is not ready: restaurant joinCode is missing. Complete restaurant setup, then try again.`,
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
