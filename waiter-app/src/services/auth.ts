import { getSession, setSession, clearSession, setConfig, getConfig, clearLocalMenu } from './db'
import { API } from '../config'
import {
  getResponseHeader,
  responseDataToRecord,
  responseDataToText,
  sendRequest,
} from './http'
import { logError, logInfo, logWarn } from './logger'

export interface WaiterUser {
  id: string
  name: string
  email: string
  role: string
  restaurantId: string
  branchId: string | null
}

const SESSION_KEY = 'waiter_session'
const USER_KEY = 'waiter_user'

export const SESSION_INVALID_MESSAGE = 'Session expired. Please sign in again.'

export type SessionInvalidationReason = 'missing-session' | 'expired-token' | 'unauthorized'

interface StoredSession {
  token: string
  user: WaiterUser
}

type SessionInvalidationListener = (reason: SessionInvalidationReason) => void

const sessionInvalidationListeners = new Set<SessionInvalidationListener>()

function decodeJwtPayload(token: string): { exp?: number } | null {
  const [, payload] = token.split('.')
  if (!payload) return null

  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=')
    return JSON.parse(atob(padded)) as { exp?: number }
  } catch {
    return null
  }
}

export function getTokenExpiryMs(token: string): number | null {
  const payload = decodeJwtPayload(token)
  return typeof payload?.exp === 'number' ? payload.exp * 1000 : null
}

export function isTokenExpired(token: string): boolean {
  const expiryMs = getTokenExpiryMs(token)
  return expiryMs == null || expiryMs <= Date.now()
}

export function addAuthInvalidationListener(listener: SessionInvalidationListener) {
  sessionInvalidationListeners.add(listener)

  return () => {
    sessionInvalidationListeners.delete(listener)
  }
}

function notifyAuthInvalidated(reason: SessionInvalidationReason) {
  for (const listener of sessionInvalidationListeners) {
    listener(reason)
  }
}

export async function invalidateSession(reason: SessionInvalidationReason): Promise<void> {
  await clearSession()
  await logWarn('auth', 'Session invalidated', { reason })
  notifyAuthInvalidated(reason)
}

export async function getValidatedSession(): Promise<StoredSession | null> {
  const [token, rawUser] = await Promise.all([
    getSession(SESSION_KEY),
    getSession(USER_KEY),
  ])

  if (!token || !rawUser) {
    await clearSession()
    return null
  }

  if (isTokenExpired(token)) {
    await clearSession()
    return null
  }

  try {
    return {
      token,
      user: JSON.parse(rawUser) as WaiterUser,
    }
  } catch {
    await clearSession()
    return null
  }
}

export async function login(email: string, password: string): Promise<WaiterUser> {
  if (!API.login) throw new Error('API base URL is not configured. Set VITE_API_BASE_URL in your build.')
  const normalizedEmail = email.trim().toLowerCase()
  const method = 'POST'

  await logInfo('auth', 'Submitting login request', {
    endpoint: API.login,
    method,
    email: normalizedEmail,
  })

  const response = await sendRequest({
    scope: 'auth',
    method,
    url: API.login,
    headers: { 'Content-Type': 'application/json' },
    data: { username: normalizedEmail, password },
  })

  const rawBody = responseDataToText(response.data)
  const { body, parsedFromJson } = responseDataToRecord(response.data)
  const contentType = getResponseHeader(response.headers, 'content-type')

  if (response.status < 200 || response.status >= 300) {
    const httpError = new Error(`HTTP ${response.status}`)

    await logWarn('auth', 'Login rejected', {
      endpoint: API.login,
      method,
      status: response.status,
      error: httpError.message,
    })

    if (!parsedFromJson && rawBody) {
      await logError('auth', 'Login response was not JSON', {
        endpoint: API.login,
        method,
        status: response.status,
        contentType,
        preview: rawBody.slice(0, 240),
      })
      throw new Error('Could not connect to the restaurant server. Open startup.log for details.')
    }

    const fallbackError = response.status === 401
      ? 'Invalid email or password.'
      : 'Login failed. Please try again.'

    throw new Error(typeof body.error === 'string' ? body.error : fallbackError)
  }

  if (!parsedFromJson && rawBody) {
    await logError('auth', 'Login response was not JSON', {
      endpoint: API.login,
      method,
      status: response.status,
      contentType,
      preview: rawBody.slice(0, 240),
    })
    throw new Error('Could not connect to the restaurant server. Open startup.log for details.')
  }

  const { token, user } = body as { token: string; user: WaiterUser }

  if (!token || !user) {
    await logError('auth', 'Login response missing token or user', {
      endpoint: API.login,
      method,
      status: response.status,
      body,
    })
    throw new Error('Login response was incomplete. Open startup.log for details.')
  }

  // Persist session to SQLite
  await setSession(SESSION_KEY, token)
  await setSession(USER_KEY, JSON.stringify(user))

  // If the restaurant changed, wipe cached menu so the new waiter never sees
  // the previous session's dishes/tables before the first pull sync completes.
  const prevRestaurantId = (await getConfig('restaurantId'))?.trim() ?? ''
  if (prevRestaurantId && prevRestaurantId !== user.restaurantId) {
    await clearLocalMenu()
  }

  // Cache restaurant + branch in config for offline reads
  await setConfig('restaurantId', user.restaurantId)
  await setConfig('branchId', user.branchId ?? '')
  await setConfig('activeBranchId', user.branchId ?? '')
  await setConfig('branches', '')
  await setConfig('waiterName', user.name)

  await logInfo('auth', 'Login succeeded', {
    userId: user.id,
    role: user.role,
    restaurantId: user.restaurantId,
    branchId: user.branchId,
  })

  return user
}

export async function getStoredUser(): Promise<WaiterUser | null> {
  const session = await getValidatedSession()
  return session?.user ?? null
}

export async function getToken(): Promise<string | null> {
  const token = await getSession(SESSION_KEY)

  if (!token) {
    await invalidateSession('missing-session')
    return null
  }

  if (isTokenExpired(token)) {
    await invalidateSession('expired-token')
    return null
  }

  return token
}

export async function logout(): Promise<void> {
  await clearSession()
  await setConfig('restaurantId', '')
  await setConfig('branchId', '')
  await setConfig('activeBranchId', '')
  await setConfig('branches', '')
  await setConfig('waiterName', '')
  await logInfo('auth', 'Session cleared by logout')
}
