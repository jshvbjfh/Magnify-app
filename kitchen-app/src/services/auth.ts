import { CapacitorHttp } from '@capacitor/core'
import { setServerUrl, API } from '../config'

const TOKEN_KEY = 'kitchen_token'
const USER_KEY = 'kitchen_user'

export interface KitchenUser {
  id: string
  name: string
  email: string
  role: string
  restaurantId: string
  branchId: string
}

function decodeJwtPayload(token: string): { exp?: number } | null {
  const [, payload] = token.split('.')
  if (!payload) return null
  try {
    const norm = payload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = norm.padEnd(norm.length + ((4 - (norm.length % 4)) % 4), '=')
    return JSON.parse(atob(padded)) as { exp?: number }
  } catch {
    return null
  }
}

function isTokenExpired(token: string): boolean {
  const payload = decodeJwtPayload(token)
  const exp = payload?.exp
  return typeof exp !== 'number' || exp * 1000 <= Date.now()
}

export function getToken(): string | null {
  const token = localStorage.getItem(TOKEN_KEY)
  if (!token) return null
  if (isTokenExpired(token)) {
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(USER_KEY)
    return null
  }
  return token
}

export function getUser(): KitchenUser | null {
  const raw = localStorage.getItem(USER_KEY)
  if (!raw) return null
  try { return JSON.parse(raw) as KitchenUser } catch { return null }
}

export function isLoggedIn(): boolean {
  return getToken() !== null && getUser() !== null
}

export async function login(serverUrl: string, username: string, password: string): Promise<KitchenUser> {
  setServerUrl(serverUrl)
  const url = API.login()
  if (!url) throw new Error('Server URL is required.')

  let response
  try {
    response = await CapacitorHttp.request({
      url,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      data: { username: username.trim().toLowerCase(), password },
      responseType: 'text',
      connectTimeout: 15_000,
      readTimeout: 15_000,
    })
  } catch {
    throw new Error('Could not connect to the server. Check the server URL.')
  }

  let body: Record<string, unknown> = {}
  if (typeof response.data === 'string') {
    try { body = JSON.parse(response.data) as Record<string, unknown> } catch { /* fall through */ }
  } else if (response.data && typeof response.data === 'object') {
    body = response.data as Record<string, unknown>
  }

  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      typeof body.error === 'string'
        ? body.error
        : response.status === 401
          ? 'Invalid username or password.'
          : 'Login failed. Please try again.'
    )
  }

  const { token, user } = body as { token: string; user: KitchenUser }
  if (!token || !user) throw new Error('Invalid response from server.')

  if (user.role !== 'kitchen' && user.role !== 'admin') {
    throw new Error('This app is for kitchen staff accounts only.')
  }

  localStorage.setItem(TOKEN_KEY, token)
  localStorage.setItem(USER_KEY, JSON.stringify(user))
  return user
}

export function logout() {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(USER_KEY)
}
