// Desktop HTTP service — uses native fetch() instead of CapacitorHttp.
// Maintains the same public interface as the Android waiter-app http.ts.

import type { HttpHeaders, HttpResponse } from '../types/http'
import { API_CONFIG_ERROR } from '../config'
import { logError } from './logger'
import { getDeviceOnlineStatus } from './network'

export const DEVICE_OFFLINE_MESSAGE = 'Your device is offline, please connect first.'
export const DNS_RESOLUTION_MESSAGE = 'Server address could not be reached. Check the server URL or DNS connection.'
export const NETWORK_TIMEOUT_MESSAGE = 'The network request timed out. Please try again.'
export const NETWORK_CONNECTION_MESSAGE = 'Network connection failed. Please try again.'

export type NetworkFailureKind = 'offline' | 'dns' | 'timeout' | 'network' | 'other'

interface RequestOptions {
  scope: string
  method: string
  url: string
  headers?: HttpHeaders
  data?: unknown
}

export function classifyNetworkFailure(error: unknown): {
  kind: NetworkFailureKind
  rawMessage: string
  userMessage: string
} {
  const rawMessage = String(error ?? '').trim()
  const message = rawMessage.toLowerCase()

  if (!message) {
    return { kind: 'network', rawMessage, userMessage: NETWORK_CONNECTION_MESSAGE }
  }

  if (message === DEVICE_OFFLINE_MESSAGE.toLowerCase()) {
    return { kind: 'offline', rawMessage, userMessage: DEVICE_OFFLINE_MESSAGE }
  }

  if (
    message.includes('unable to resolve host')
    || message.includes('no address associated with hostname')
    || message.includes('eai_again')
    || message.includes('enotfound')
    || message.includes('failed to fetch')
    || message.includes('networkerror')
  ) {
    return { kind: 'dns', rawMessage, userMessage: DNS_RESOLUTION_MESSAGE }
  }

  if (
    message.includes('internet appears to be offline')
    || message.includes('device is offline')
    || message.includes('network is unreachable')
    || message.includes('no internet')
    || message.includes('offline')
  ) {
    return { kind: 'offline', rawMessage, userMessage: DEVICE_OFFLINE_MESSAGE }
  }

  if (message.includes('timeout') || message.includes('timed out')) {
    return { kind: 'timeout', rawMessage, userMessage: NETWORK_TIMEOUT_MESSAGE }
  }

  if (
    message.includes('failed to connect')
    || message.includes('network request failed')
    || message.includes('network error')
    || message.includes('load failed')
  ) {
    return { kind: 'network', rawMessage, userMessage: NETWORK_CONNECTION_MESSAGE }
  }

  return { kind: 'other', rawMessage, userMessage: rawMessage }
}

export function isOfflineLikeErrorMessage(error: unknown) {
  return classifyNetworkFailure(error).kind === 'offline'
}

export function getResponseHeader(headers: HttpHeaders, name: string): string | null {
  const targetName = name.toLowerCase()
  for (const [headerName, headerValue] of Object.entries(headers)) {
    if (headerName.toLowerCase() === targetName) return headerValue
  }
  return null
}

export function responseDataToText(data: unknown): string {
  if (typeof data === 'string') return data
  if (data == null) return ''
  try {
    return JSON.stringify(data)
  } catch {
    return String(data)
  }
}

export function responseDataToRecord(data: unknown): {
  body: Record<string, unknown>
  parsedFromJson: boolean
} {
  if (data == null || data === '') return { body: {}, parsedFromJson: false }

  if (typeof data === 'string') {
    try {
      const parsed = JSON.parse(data)
      if (parsed && typeof parsed === 'object') {
        return { body: parsed as Record<string, unknown>, parsedFromJson: true }
      }
    } catch {
      return { body: {}, parsedFromJson: false }
    }
    return { body: {}, parsedFromJson: false }
  }

  if (typeof data === 'object') {
    return { body: data as Record<string, unknown>, parsedFromJson: true }
  }

  return { body: {}, parsedFromJson: false }
}

type ElectronHttp = {
  request: (opts: {
    method: string
    url: string
    headers: Record<string, string>
    body?: string
    timeoutMs?: number
  }) => Promise<{ status: number; headers: Record<string, string>; data: string }>
}

export async function sendRequest({
  scope,
  method,
  url,
  headers,
  data,
}: RequestOptions): Promise<HttpResponse> {
  const normalizedMethod = method.toUpperCase()

  if (!url) {
    const requestError = new Error(API_CONFIG_ERROR ?? 'API endpoint is not configured')
    requestError.name = 'ApiConfigError'
    await logError(scope, 'API request blocked: endpoint not configured', {
      endpoint: url,
      method: normalizedMethod,
      transport: 'electron-ipc',
      error: requestError.message,
    })
    throw requestError
  }

  const w = window as unknown as { electronHttp?: ElectronHttp }
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 15_000)

  try {
    // Route through main process IPC — Node.js has no CORS restrictions.
    if (w.electronHttp?.request) {
      clearTimeout(timeoutId)
      const bodyStr =
        data !== undefined && data !== null && normalizedMethod !== 'GET'
          ? typeof data === 'string' ? data : JSON.stringify(data)
          : undefined

      const result = await w.electronHttp.request({
        method: normalizedMethod,
        url,
        headers: (headers ?? {}) as Record<string, string>,
        body: bodyStr,
        timeoutMs: 15_000,
      })

      return { status: result.status, data: result.data, headers: result.headers, url }
    }

    // Fallback: direct fetch (not used in packaged Electron, kept for non-Electron environments)
    const fetchOptions: RequestInit = {
      method: normalizedMethod,
      headers: headers as Record<string, string>,
      signal: controller.signal,
    }
    if (data !== undefined && data !== null && normalizedMethod !== 'GET') {
      fetchOptions.body = typeof data === 'string' ? data : JSON.stringify(data)
    }

    const response = await fetch(url, fetchOptions)
    const text = await response.text()

    const responseHeaders: HttpHeaders = {}
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value
    })

    return {
      status: response.status,
      data: text,
      headers: responseHeaders,
      url: response.url,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const aborted = error instanceof Error && error.name === 'AbortError'
    const effectiveMessage = aborted ? 'Request timed out' : message

    const isDeviceOnline = await getDeviceOnlineStatus()
    const classifiedFailure = isDeviceOnline
      ? classifyNetworkFailure(effectiveMessage)
      : { kind: 'offline' as const, rawMessage: effectiveMessage, userMessage: DEVICE_OFFLINE_MESSAGE }

    await logError(scope, 'Network request failed', {
      endpoint: url,
      method: normalizedMethod,
      transport: w.electronHttp ? 'electron-ipc' : 'fetch',
      kind: classifiedFailure.kind,
      error: effectiveMessage,
      userMessage: classifiedFailure.userMessage,
    })

    const requestError = new Error(classifiedFailure.userMessage)
    requestError.name = 'NetworkRequestError'
    throw requestError
  } finally {
    clearTimeout(timeoutId)
  }
}
