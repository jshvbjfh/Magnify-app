import {
  clearLogEntries,
  createLogEntry,
  getLogEntries,
  type AppLogEntry,
} from './db'

type LogLevel = AppLogEntry['level']

const bufferedLogs: AppLogEntry[] = []
let flushPromise: Promise<void> | null = null

function createLogId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  const timestamp = Date.now().toString(16)
  const random = Math.random().toString(16).slice(2, 14).padEnd(12, '0')
  return `${timestamp.slice(-8)}-${random.slice(0, 4)}-4${random.slice(4, 7)}-a${random.slice(7, 10)}-${random.slice(10, 12)}${Date.now().toString(16).slice(-10)}`
}

function serializeDetails(details: unknown): string | null {
  if (details == null) return null
  if (typeof details === 'string') return details

  try {
    return JSON.stringify(details, null, 2)
  } catch {
    return String(details)
  }
}

function getConsoleMethod(level: LogLevel) {
  if (level === 'error') return console.error
  if (level === 'warn') return console.warn
  return console.log
}

export function normalizeErrorForLog(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack ?? null,
    }
  }

  return { value: String(error) }
}

async function persistLog(entry: AppLogEntry) {
  await createLogEntry(entry)
}

async function writeLog(level: LogLevel, scope: string, message: string, details?: unknown) {
  const entry: AppLogEntry = {
    id: createLogId(),
    level,
    scope,
    message,
    details: serializeDetails(details),
    created_at: new Date().toISOString(),
  }

  getConsoleMethod(level)(`[${scope}] ${message}`, details ?? '')

  try {
    await persistLog(entry)
    void flushBufferedLogs()
  } catch {
    bufferedLogs.push(entry)
  }

  return entry
}

export function logInfo(scope: string, message: string, details?: unknown) {
  return writeLog('info', scope, message, details)
}

export function logWarn(scope: string, message: string, details?: unknown) {
  return writeLog('warn', scope, message, details)
}

export function logError(scope: string, message: string, details?: unknown) {
  return writeLog('error', scope, message, details)
}

export async function flushBufferedLogs(): Promise<void> {
  if (flushPromise) return flushPromise

  flushPromise = (async () => {
    while (bufferedLogs.length > 0) {
      const nextEntry = bufferedLogs[0]

      try {
        await persistLog(nextEntry)
        bufferedLogs.shift()
      } catch {
        break
      }
    }
  })().finally(() => {
    flushPromise = null
  })

  return flushPromise
}

export async function getAppLogs(limit = 200) {
  await flushBufferedLogs()
  return getLogEntries(limit)
}

export async function clearAppLogs() {
  bufferedLogs.length = 0
  await clearLogEntries()
}