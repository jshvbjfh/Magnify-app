'use client'

import { useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'

import { getOwnerSyncRetryDelayMs, loadOwnerSyncConfig, loadServerOwnerSyncConfig, syncOwnerCloud, type ServerOwnerSyncConfig } from '@/lib/ownerSyncBrowser'

const SYNCABLE_ROLES = new Set(['admin', 'waiter', 'kitchen'])

export default function RestaurantCloudSync() {
  const { data: session } = useSession()
  const userRole = String((session?.user as any)?.role ?? '')
  const [configRevision, setConfigRevision] = useState(0)
  const [serverOwnerSyncConfig, setServerOwnerSyncConfig] = useState<ServerOwnerSyncConfig | null>(null)
  const [serverOwnerSyncConfigLoaded, setServerOwnerSyncConfigLoaded] = useState(false)

  useEffect(() => {
    const handler = () => setConfigRevision((current) => current + 1)
    window.addEventListener('ownerSyncConfigChanged', handler)
    return () => window.removeEventListener('ownerSyncConfigChanged', handler)
  }, [])

  useEffect(() => {
    if (!SYNCABLE_ROLES.has(userRole)) {
      setServerOwnerSyncConfig(null)
      setServerOwnerSyncConfigLoaded(false)
      return
    }

    let cancelled = false
    setServerOwnerSyncConfigLoaded(false)

    const loadSyncConfig = async () => {
      const config = await loadServerOwnerSyncConfig()
      if (cancelled) return
      setServerOwnerSyncConfig(config)
      setServerOwnerSyncConfigLoaded(true)
    }

    void loadSyncConfig()

    return () => {
      cancelled = true
    }
  }, [configRevision, userRole])

  useEffect(() => {
    if (!SYNCABLE_ROLES.has(userRole) || !serverOwnerSyncConfigLoaded) return

    let syncing = false
    let timeoutId: number | null = null
    let scheduledAt = 0

    const getSyncConfig = () => loadOwnerSyncConfig(serverOwnerSyncConfig)

    const clearScheduledSync = () => {
      if (timeoutId != null) {
        window.clearTimeout(timeoutId)
        timeoutId = null
      }
      scheduledAt = 0
    }

    const scheduleNextSync = (delayMs: number) => {
      const nextScheduledAt = Date.now() + delayMs
      if (timeoutId != null && scheduledAt !== 0 && scheduledAt <= nextScheduledAt) {
        return
      }

      clearScheduledSync()
      scheduledAt = nextScheduledAt
      timeoutId = window.setTimeout(() => {
        scheduledAt = 0
        void runSync()
      }, delayMs)
    }

    const scheduleSyncFromNewLocalWrites = () => {
      const config = getSyncConfig()
      if (!config.enabled || syncing) return
      scheduleNextSync(5_000)
    }

    const runSync = async () => {
      if (syncing) return

      const config = getSyncConfig()
      if (!config.enabled) {
        clearScheduledSync()
        return
      }

      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        scheduleNextSync(getOwnerSyncRetryDelayMs(1))
        window.dispatchEvent(new CustomEvent('ownerSyncStatusChanged'))
        return
      }

      syncing = true
      try {
        const result = await syncOwnerCloud(config)
        window.dispatchEvent(new CustomEvent('ownerSyncStatusChanged', { detail: result }))
        scheduleNextSync(getOwnerSyncRetryDelayMs(result.ok ? 0 : result.consecutiveFailures))
      } finally {
        syncing = false
      }
    }

    const handleOnline = () => { void runSync() }
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        void runSync()
      }
    }
    const handleLocalWrite = () => {
      scheduleSyncFromNewLocalWrites()
    }

    void runSync()
    window.addEventListener('online', handleOnline)
    window.addEventListener('refreshTransactions', handleLocalWrite)
    window.addEventListener('refreshTables', handleLocalWrite)
    window.addEventListener('refreshWastePending', handleLocalWrite)
    document.addEventListener('visibilitychange', handleVisibility)

    return () => {
      clearScheduledSync()
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('refreshTransactions', handleLocalWrite)
      window.removeEventListener('refreshTables', handleLocalWrite)
      window.removeEventListener('refreshWastePending', handleLocalWrite)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [configRevision, serverOwnerSyncConfig, serverOwnerSyncConfigLoaded, userRole])

  return null
}