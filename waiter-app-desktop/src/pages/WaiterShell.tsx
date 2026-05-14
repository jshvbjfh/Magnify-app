import { useState, useEffect, useCallback } from 'react'
import { UtensilsCrossed, ArrowLeftRight, Layout, LogOut, Wifi, WifiOff, RefreshCw, ScrollText } from 'lucide-react'
import { useOnline } from '../hooks/useOnline'
import { isOfflineLikeErrorMessage } from '../services/http'
import { logInfo } from '../services/logger'
import { syncAll } from '../services/sync'
import type { WaiterUser } from '../services/auth'
import RestaurantOrders from './RestaurantOrders'
import RestaurantTables from './RestaurantTables'
import StartupLogPage from './StartupLogPage'

type TabId = 'menu' | 'transactions' | 'tables' | 'logs'

const tabs: { id: TabId; label: string; icon: React.ReactNode }[] = [
  { id: 'menu',         label: 'Menu',         icon: <UtensilsCrossed className="h-4 w-4" /> },
  { id: 'transactions', label: 'Transactions', icon: <ArrowLeftRight className="h-4 w-4" /> },
  { id: 'tables',       label: 'Tables',       icon: <Layout className="h-4 w-4" /> },
  { id: 'logs',         label: 'Logs',         icon: <ScrollText className="h-4 w-4" /> },
]

interface WaiterShellProps {
  user: WaiterUser
  onLogout: () => Promise<void> | void
}

export default function WaiterShell({ user, onLogout }: WaiterShellProps) {
  const { isOnline } = useOnline()
  const [activeTab, setActiveTab] = useState<TabId>('menu')
  const [pendingCount, setPendingCount] = useState(0)
  const [syncing, setSyncing] = useState(false)
  const [transportOfflineMode, setTransportOfflineMode] = useState(false)
  const [lastSyncError, setLastSyncError] = useState<string | null>(null)
  const [lastSyncWarning, setLastSyncWarning] = useState<string | null>(null)
  const [syncVersion, setSyncVersion] = useState(0)

  const waiterName = user?.name ?? ''
  const initials = waiterName
    ? waiterName.split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase()
    : 'W'

  const runSync = useCallback(async () => {
    if (!isOnline || syncing) return
    setSyncing(true)
    setLastSyncError(null)
    const result = await syncAll()
    if (result.authFailed) {
      setSyncing(false)
      return
    }
    if (result.error && isOfflineLikeErrorMessage(result.error)) {
      setTransportOfflineMode(true)
      setLastSyncError(null)
      setLastSyncWarning(null)
    } else if (result.error) {
      setTransportOfflineMode(false)
      setLastSyncError(result.error)
      setLastSyncWarning(null)
    } else {
      setTransportOfflineMode(false)
      setLastSyncWarning(result.warning ?? null)
      setSyncVersion(v => v + 1)
    }
    setSyncing(false)
  }, [isOnline, syncing])

  // Auto-sync when app comes online
  useEffect(() => {
    if (isOnline) runSync()
  }, [isOnline]) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-sync every 30 seconds
  useEffect(() => {
    if (!isOnline) return
    const interval = setInterval(runSync, 30_000)
    return () => clearInterval(interval)
  }, [isOnline, runSync])

  useEffect(() => {
    void logInfo('network', isOnline ? 'Device is online' : 'Device is offline')
  }, [isOnline])

  const isPOS = activeTab === 'menu'
  const showOfflineBanner = !isOnline || transportOfflineMode

  return (
    <div className="h-screen flex flex-col bg-gray-50 overflow-hidden">

      {/* ── Offline banner ── */}
      {showOfflineBanner && (
        <div className="flex items-center gap-2 bg-amber-500 text-white text-xs font-semibold px-4 py-2 flex-shrink-0">
          <WifiOff className="h-3.5 w-3.5 flex-shrink-0" />
          <span>You are now working offline! Orders will keep saving locally and sync automatically when connected.</span>
        </div>
      )}

      {/* ── Sync error banner ── */}
      {isOnline && lastSyncError && (
        <div className="flex items-center gap-2 bg-red-500 text-white text-xs font-medium px-4 py-1.5 flex-shrink-0">
          <span>Sync failed: {lastSyncError}</span>
        </div>
      )}

      {isOnline && !lastSyncError && lastSyncWarning && (
        <div className="flex items-center gap-2 bg-amber-500 text-white text-xs font-medium px-4 py-1.5 flex-shrink-0">
          <span>Sync warning: {lastSyncWarning}</span>
        </div>
      )}

      {/* ── Top navigation bar ── */}
      <header className="bg-gray-900 text-white shadow-md flex-shrink-0 z-30">
        <div className="px-4 flex items-center justify-between h-14">

          {/* Brand / waiter name */}
          <div className="flex items-center gap-2 flex-shrink-0">
            <div className="w-7 h-7 rounded-lg bg-orange-500 flex items-center justify-center text-white font-black text-xs select-none">
              {initials}
            </div>
            {waiterName && (
              <span className="text-sm font-bold text-white leading-none hidden sm:block">{waiterName}</span>
            )}
          </div>

          {/* Tab navigation */}
          <nav className="flex items-center gap-0.5 overflow-x-auto no-scrollbar">
            {tabs.map(t => (
              <button
                key={t.id}
                onClick={() => setActiveTab(t.id)}
                className={`relative flex items-center gap-1.5 px-3 py-3 rounded-lg text-sm font-medium transition-colors whitespace-nowrap flex-shrink-0 ${
                  activeTab === t.id
                    ? 'bg-white/10 text-white'
                    : 'text-gray-400 hover:text-white hover:bg-white/5'
                }`}
              >
                {t.icon}
                <span className="hidden sm:inline">{t.label}</span>
                {t.id === 'menu' && pendingCount > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 h-4 min-w-[16px] bg-orange-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center px-1">
                    {pendingCount}
                  </span>
                )}
              </button>
            ))}
          </nav>

          {/* Right side: sync indicator + sign out */}
          <div className="flex items-center gap-1 flex-shrink-0">
            {isOnline ? (
              <button
                onClick={runSync}
                disabled={syncing}
                title="Sync now"
                className="flex items-center gap-1 text-xs text-gray-400 hover:text-white px-2 py-1.5 rounded-lg hover:bg-white/5 transition-colors"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${syncing ? 'animate-spin' : ''}`} />
              </button>
            ) : (
              <WifiOff className="h-3.5 w-3.5 text-amber-400 mx-2" />
            )}
            {isOnline && <Wifi className="h-3 w-3 text-green-400 mr-1" />}
            <button
              onClick={onLogout}
              className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-white/5 transition-colors flex-shrink-0"
            >
              <LogOut className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Sign Out</span>
            </button>
          </div>
        </div>
      </header>

      {/* ── Content ── */}
      <main className={isPOS ? 'flex-1 overflow-hidden' : 'flex-1 overflow-y-auto'}>
        {activeTab === 'menu' && (
          <RestaurantOrders
            mode="pos"
            waiterName={waiterName}
            onPendingCountChange={setPendingCount}
            syncVersion={syncVersion}
          />
        )}
        {activeTab === 'transactions' && (
          <div className="max-w-5xl mx-auto px-4 py-6">
            <RestaurantOrders mode="history" waiterName={waiterName} />
          </div>
        )}
        {activeTab === 'tables' && (
          <div className="max-w-5xl mx-auto px-4 py-6">
            <RestaurantTables waiterName={waiterName} />
          </div>
        )}
        {activeTab === 'logs' && (
          <div className="max-w-5xl mx-auto px-4 py-6">
            <StartupLogPage />
          </div>
        )}
      </main>
    </div>
  )
}
