import { CapacitorHttp, type HttpResponse } from '@capacitor/core'
import { getServerUrl } from '../config'

export async function apiRequest({
  method,
  path,
  token,
  body,
}: {
  method: string
  path: string
  token: string
  body?: unknown
}): Promise<HttpResponse> {
  const serverUrl = getServerUrl()
  if (!serverUrl) throw new Error('Server URL not configured.')

  const url = `${serverUrl}${path}`
  try {
    return await CapacitorHttp.request({
      url,
      method: method.toUpperCase(),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      data: body,
      responseType: 'text',
      connectTimeout: 10_000,
      readTimeout: 10_000,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(message || 'Network request failed.')
  }
}

export function parseResponse<T>(response: HttpResponse): T {
  if (typeof response.data === 'string') {
    try { return JSON.parse(response.data) as T } catch { /* fall through */ }
  }
  if (response.data && typeof response.data === 'object') return response.data as T
  return {} as T
}
