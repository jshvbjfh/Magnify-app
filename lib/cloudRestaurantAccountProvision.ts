import { getCanonicalCloudAppUrl } from '@/lib/cloudAuthBridge'
import { normalizeTargetUrl } from '@/lib/minimalSync'

type ProvisionedRestaurantSummary = {
  name: string
  syncRestaurantId: string | null
  syncToken: string | null
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

  if (!params.restaurant.syncRestaurantId || !params.restaurant.syncToken) {
    return {
      ok: false as const,
      status: 409,
      error: `${accountLabel} cloud login is not ready because this branch sync identity is missing. Reconnect branch sync, then try again.`,
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
    const res = await fetch(`${normalizeTargetUrl(targetUrl)}/api/sync/owner-accounts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-sync-email': syncEmail,
        ...(sharedSecret ? { 'x-sync-secret': sharedSecret } : { 'x-sync-password': syncPassword }),
      },
      body: JSON.stringify({
        restaurantSyncId: params.restaurant.syncRestaurantId,
        restaurantToken: params.restaurant.syncToken,
        restaurantName: params.restaurant.name,
        role: params.role,
        name: params.name,
        email: params.email,
        password: params.password,
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