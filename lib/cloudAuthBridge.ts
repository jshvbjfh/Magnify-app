type RemoteSignupPayload = {
  name: string
  email: string
  password: string
  trackingMode?: string
  qrOrderingMode?: string
  role?: string
}

type RemoteVerifiedUser = {
  id: string
  name: string | null
  email: string
  role: string
  businessType: string | null
  trackingMode: string | null
  isActive: boolean
  isSuperAdmin: boolean
  subscriptionPlan: string | null
  subscriptionActivatedAt: string | null
  subscriptionExpiry: string | null
}

export type RemoteVerifiedRestaurant = {
  id: string
  name: string
  joinCode: string | null
  qrOrderingMode: string | null
  licenseActive: boolean
  licenseExpiry: string | null
  syncRestaurantId: string | null
  syncToken: string | null
  owner: {
    name: string | null
    email: string
    role: string
    businessType: string | null
    trackingMode: string | null
    isActive: boolean
  } | null
}

type RemoteVerificationResult =
  | {
      ok: true
      user: RemoteVerifiedUser
      restaurant: RemoteVerifiedRestaurant | null
    }
  | {
      ok: false
      status: number
      error: string
    }

const BRIDGE_TIMEOUT_MS = 10_000

function normalizeBridgeUrl(rawValue: string, options: { allowLocalhost: boolean }) {
  const raw = String(rawValue || '').trim().replace(/\/+$/, '')
  if (!raw) return null

  try {
    const parsed = new URL(raw)
    if (!options.allowLocalhost && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')) {
      return null
    }
    return parsed.toString().replace(/\/+$/, '')
  } catch {
    return null
  }
}

export function getCanonicalCloudAppUrl() {
  const explicitBridgeUrl = normalizeBridgeUrl(process.env.DESKTOP_AUTH_BRIDGE_URL ?? '', { allowLocalhost: true })
  if (explicitBridgeUrl) return explicitBridgeUrl

  return normalizeBridgeUrl(process.env.NEXT_PUBLIC_APP_URL ?? '', { allowLocalhost: false })
}

async function postJson(url: string, body: unknown) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), BRIDGE_TIMEOUT_MS)

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: 'no-store',
    })
    const payload = await res.json().catch(() => null)
    return { res, payload }
  } finally {
    clearTimeout(timeout)
  }
}

export function isLocalFirstDesktopAuthBridgeEnabled() {
  return String(process.env.ELECTRON_DATA_MODE ?? '').trim().toLowerCase() === 'local-first' && Boolean(getCanonicalCloudAppUrl())
}

export async function mirrorSignupToCloud(payload: RemoteSignupPayload) {
  const baseUrl = getCanonicalCloudAppUrl()
  if (!baseUrl) {
    return {
      ok: false,
      status: 503,
      body: { error: 'Cloud signup bridge is not configured.' },
    }
  }

  try {
    const { res, payload: body } = await postJson(`${baseUrl}/api/auth/signup`, payload)
    return {
      ok: res.ok,
      status: res.status,
      body,
    }
  } catch {
    return {
      ok: false,
      status: 503,
      body: {
        error: 'Could not reach Magnify cloud to register this account. Connect to the internet and try again.',
      },
    }
  }
}

export async function verifyCloudCredentials(email: string, password: string): Promise<RemoteVerificationResult> {
  const baseUrl = getCanonicalCloudAppUrl()
  if (!baseUrl) {
    return {
      ok: false,
      status: 503,
      error: 'Cloud auth bridge is not configured.',
    }
  }

  try {
    const { res, payload } = await postJson(`${baseUrl}/api/auth/desktop-auth`, { email, password })
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: String(payload?.error ?? 'Unable to verify account with Magnify cloud.'),
      }
    }

    return {
      ok: true,
      user: payload.user as RemoteVerifiedUser,
      restaurant: payload.restaurant ? (payload.restaurant as RemoteVerifiedRestaurant) : null,
    }
  } catch {
    return {
      ok: false,
      status: 503,
      error: 'Could not reach Magnify cloud to verify this account.',
    }
  }
}