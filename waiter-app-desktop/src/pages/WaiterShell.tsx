import { useState, useEffect, useCallback, useRef } from 'react'
import { UtensilsCrossed, ArrowLeftRight, Layout, LogOut, Wifi, WifiOff, RefreshCw, ScrollText } from 'lucide-react'
import { useOnline } from '../hooks/useOnline'
import { isOfflineLikeErrorMessage } from '../services/http'
import { getConfig, setConfig } from '../services/db'
import { logInfo } from '../services/logger'
import { syncAll, type BranchInfo } from '../services/sync'
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
  const [branches, setBranches] = useState<BranchInfo[]>([])
  const [activeBranchId, setActiveBranchId] = useState<string | null>(user?.branchId ?? null)
  const [branchSwitchingId, setBranchSwitchingId] = useState<string | null>(null)
  const [pendingCount, setPendingCount] = useState(0)
  const [syncing, setSyncing] = useState(false)
  const [transportOfflineMode, setTransportOfflineMode] = useState(false)
  const [lastSyncError, setLastSyncError] = useState<string | null>(null)
  const [lastSyncWarning, setLastSyncWarning] = useState<string | null>(null)
  const [syncVersion, setSyncVersion] = useState(0)
  const syncingRef = useRef(false)

  const waiterName = user?.name ?? ''
  const initials = waiterName
    ? waiterName.split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase()
    : 'W'

  const loadStoredBranchState = useCallback(async () => {
    try {
      const [rawBranches, rawActiveBranchId, rawBranchId] = await Promise.all([
        getConfig('branches'),
        getConfig('activeBranchId'),
        getConfig('branchId'),
      ])

      const parsedBranches = rawBranches
        ? JSON.parse(rawBranches) as BranchInfo[]
        : []

      setBranches(Array.isArray(parsedBranches) ? parsedBranches : [])

      const normalizedActiveBranchId = typeof rawActiveBranchId === 'string' && rawActiveBranchId.trim()
        ? rawActiveBranchId.trim()
        : typeof rawBranchId === 'string' && rawBranchId.trim()
          ? rawBranchId.trim()
          : parsedBranches[0]?.id ?? null

      setActiveBranchId(normalizedActiveBranchId)
    } catch {
      setBranches([])
    }
  }, [])

  const runSync = useCallback(async (options?: { branchId?: string; persistBranch?: boolean }) => {
    if (!isOnline || syncingRef.current) return
    syncingRef.current = true
    setSyncing(true)
    setLastSyncError(null)
    try {
      const result = await syncAll(options?.branchId)
      if (result.authFailed) {
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
        if (options?.persistBranch && options.branchId && !result.warning) {
          await setConfig('activeBranchId', options.branchId)
          await setConfig('branchId', options.branchId)
        }
        await loadStoredBranchState()
        setTransportOfflineMode(false)
        setLastSyncWarning(result.warning ?? null)
        setSyncVersion(v => v + 1)
      }
    } finally {
      syncingRef.current = false
      setSyncing(false)
    }
  }, [isOnline, loadStoredBranchState])

  useEffect(() => {
    void loadStoredBranchState()
  }, [loadStoredBranchState])

  // Auto-sync when app comes online
  useEffect(() => {
    if (isOnline) void runSync()
  }, [isOnline, runSync])

  // Auto-sync every 10 seconds
  useEffect(() => {
    if (!isOnline) return
    const interval = setInterval(runSync, 10_000)
    return () => clearInterval(interval)
  }, [isOnline, runSync])

  useEffect(() => {
    void logInfo('network', isOnline ? 'Device is online' : 'Device is offline')
  }, [isOnline])

  const isPOS = activeTab === 'menu'
  const showOfflineBanner = !isOnline || transportOfflineMode

  const handleBranchSelect = async (branchId: string) => {
    if (branchId === activeBranchId || branchSwitchingId) return
    if (!isOnline) {
      setLastSyncWarning('Connect to the internet to switch branches.')
      return
    }

    // Optimistic switch: persist the new branch and update UI immediately,
    // then sync in the background so the user isn't blocked waiting for the network.
    await setConfig('activeBranchId', branchId)
    await setConfig('branchId', branchId)
    setActiveBranchId(branchId)
    setSyncVersion(v => v + 1)

    setBranchSwitchingId(branchId)
    try {
      const deadline = Date.now() + 10_000
      while (syncingRef.current && Date.now() < deadline) {
        await new Promise<void>(r => setTimeout(r, 150))
      }
      await runSync({ branchId, persistBranch: false })
    } finally {
      setBranchSwitchingId(null)
    }
  }

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
                onClick={() => { void runSync() }}
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

      {branches.length > 0 && (
        <div className="border-b border-orange-100 bg-white px-4 py-2 flex justify-center items-center gap-2 overflow-x-auto no-scrollbar flex-shrink-0">
          {branches.map((branch) => {
            const isActive = branch.id === activeBranchId
            const isSwitching = branch.id === branchSwitchingId
            return (
              <button
                key={branch.id}
                type="button"
                onClick={() => { void handleBranchSelect(branch.id) }}
                disabled={isSwitching}
                className={`flex-shrink-0 rounded-full border px-4 py-1.5 text-sm font-semibold transition-colors ${
                  isActive
                    ? 'border-orange-500 bg-orange-500 text-white'
                    : 'border-orange-200 bg-orange-50 text-orange-700 hover:bg-orange-100'
                } ${isSwitching ? 'cursor-wait opacity-70' : ''}`}
              >
                {branch.name}
              </button>
            )
          })}
        </div>
      )}

      {/* ── Content ── */}
      <main className={isPOS ? 'flex-1 overflow-hidden' : 'flex-1 overflow-y-auto'}>
        {activeTab === 'menu' && (
          <RestaurantOrders
            mode="pos"
            waiterName={waiterName}
            activeBranchId={activeBranchId}
            onPendingCountChange={setPendingCount}
            syncVersion={syncVersion}
          />
        )}
        {activeTab === 'transactions' && (
          <div className="max-w-5xl mx-auto px-4 py-6">
            <RestaurantOrders mode="history" waiterName={waiterName} activeBranchId={activeBranchId} />
          </div>
        )}
        {activeTab === 'tables' && (
          <div className="max-w-5xl mx-auto px-4 py-6">
            <RestaurantTables waiterName={waiterName} activeBranchId={activeBranchId} />
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
