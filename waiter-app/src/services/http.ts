import { Capacitor, CapacitorHttp, type HttpHeaders, type HttpResponse } from '@capacitor/core'
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

function getTransportLabel() {
  return Capacitor.getPlatform() === 'web'
    ? 'web-fetch'
    : `capacitor-http:${Capacitor.getPlatform()}`
}

export function classifyNetworkFailure(error: unknown): {
  kind: NetworkFailureKind
  rawMessage: string
  userMessage: string
} {
  const rawMessage = String(error ?? '').trim()
  const message = rawMessage.toLowerCase()

  if (!message) {
    return {
      kind: 'network',
      rawMessage,
      userMessage: NETWORK_CONNECTION_MESSAGE,
    }
  }

  if (message === DEVICE_OFFLINE_MESSAGE.toLowerCase()) {
    return {
      kind: 'offline',
      rawMessage,
      userMessage: DEVICE_OFFLINE_MESSAGE,
    }
  }

  if (
    message.includes('unable to resolve host')
    || message.includes('no address associated with hostname')
    || message.includes('eai_again')
    || message.includes('enotfound')
  ) {
    return {
      kind: 'dns',
      rawMessage,
      userMessage: DNS_RESOLUTION_MESSAGE,
    }
  }

  if (
    message.includes('internet appears to be offline')
    || message.includes('device is offline')
    || message.includes('network is unreachable')
    || message.includes('no internet')
    || message.includes('offline')
  ) {
    return {
      kind: 'offline',
      rawMessage,
      userMessage: DEVICE_OFFLINE_MESSAGE,
    }
  }

  if (message.includes('timeout') || message.includes('timed out')) {
    return {
      kind: 'timeout',
      rawMessage,
      userMessage: NETWORK_TIMEOUT_MESSAGE,
    }
  }

  if (
    message.includes('failed to connect')
    || message.includes('network request failed')
    || message.includes('network error')
  ) {
    return {
      kind: 'network',
      rawMessage,
      userMessage: NETWORK_CONNECTION_MESSAGE,
    }
  }

  return {
    kind: 'other',
    rawMessage,
    userMessage: rawMessage,
  }
}

export function isOfflineLikeErrorMessage(error: unknown) {
  return classifyNetworkFailure(error).kind === 'offline'
}

export function getResponseHeader(headers: HttpHeaders, name: string): string | null {
  const targetName = name.toLowerCase()

  for (const [headerName, headerValue] of Object.entries(headers)) {
    if (headerName.toLowerCase() === targetName) {
      return headerValue
    }
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
  if (data == null || data === '') {
    return { body: {}, parsedFromJson: false }
  }

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
      transport: getTransportLabel(),
      error: requestError.message,
    })

    throw requestError
  }

  try {
    return await CapacitorHttp.request({
      url,
      method: normalizedMethod,
      headers,
      data,
      responseType: 'text',
      // 30s tolerates Neon serverless cold starts (the DB scales to zero and a
      // reconnect can take ~15s). The old 15s budget expired mid-cold-start and
      // surfaced as a sync failure on exactly the pulls that needed to succeed.
      // Must stay >= the server's maxDuration for /api/mobile/*.
      connectTimeout: 30_000,
      readTimeout: 30_000,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const isDeviceOnline = await getDeviceOnlineStatus()
    const classifiedFailure = isDeviceOnline
      ? classifyNetworkFailure(message)
      : {
          kind: 'offline' as const,
          rawMessage: message,
          userMessage: DEVICE_OFFLINE_MESSAGE,
        }

    await logError(scope, 'Network request failed', {
      endpoint: url,
      method: normalizedMethod,
      transport: getTransportLabel(),
      kind: classifiedFailure.kind,
      error: message,
      userMessage: classifiedFailure.userMessage,
    })

    const requestError = new Error(classifiedFailure.userMessage)
    requestError.name = 'NetworkRequestError'
    throw requestError
  }
}