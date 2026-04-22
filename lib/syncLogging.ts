type SyncLogLevel = 'info' | 'warn' | 'error'

type SyncLogMeta = Record<string, unknown>

function compactMeta(meta: SyncLogMeta) {
  return Object.fromEntries(Object.entries(meta).filter(([, value]) => value !== undefined))
}

export function logSyncActivity(level: SyncLogLevel, event: string, meta: SyncLogMeta = {}) {
  const entry = {
    domain: 'sync',
    event,
    timestamp: new Date().toISOString(),
    ...compactMeta(meta),
  }

  const message = JSON.stringify(entry)

  if (level === 'error') {
    console.error(message)
    return
  }

  if (level === 'warn') {
    console.warn(message)
    return
  }

  console.log(message)
}