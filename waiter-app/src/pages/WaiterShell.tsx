import { useState, useEffect, useCallback, useRef } from 'react'
import { UtensilsCrossed, ClipboardList, Layout, LogOut, Wifi, WifiOff, RefreshCw, ScrollText, Printer, ChefHat, Power, Download } from 'lucide-react'
import { useOnline } from '../hooks/useOnline'
import { useUpdateCheck } from '../hooks/useUpdateCheck'
import { isOfflineLikeErrorMessage } from '../services/http'
import { getConfig, setConfig, getOrders } from '../services/db'
import { logInfo } from '../services/logger'
import { syncAll, type BranchInfo } from '../services/sync'
import { getActiveShift, areShiftsEnabled } from '../services/shifts'
import { APP_VERSION } from '../config'
import type { WaiterUser } from '../services/auth'
import RestaurantOrders from './RestaurantOrders'
import RestaurantTables from './RestaurantTables'
import MepPage from './MepPage'
import PrinterSettings from './PrinterSettings'
import StartupLogPage from './StartupLogPage'
import WaiterGatePage from './WaiterGatePage'
import ShiftGatePage from './ShiftGatePage'
import SupervisorPinDialog from './SupervisorPinDialog'

type TabId = 'menu' | 'pending' | 'tables' | 'mep' | 'printers' | 'logs'

const tabs: { id: TabId; label: string; icon: React.ReactNode }[] = [
  { id: 'menu',     label: 'Menu',           icon: <UtensilsCrossed className="h-4 w-4" /> },
  { id: 'tables',   label: 'Tables',         icon: <Layout className="h-4 w-4" /> },
  { id: 'pending',  label: 'Pending Orders', icon: <ClipboardList className="h-4 w-4" /> },
  { id: 'mep',      label: 'MEP',            icon: <ChefHat className="h-4 w-4" /> },
  { id: 'printers', label: 'Printers',       icon: <Printer className="h-4 w-4" /> },
  { id: 'logs',     label: 'Logs',           icon: <ScrollText className="h-4 w-4" /> },
]

interface WaiterShellProps {
  user: WaiterUser
  onLogout: () => Promise<void> | void
}

export default function WaiterShell({ user, onLogout }: WaiterShellProps) {
  const { isOnline } = useOnline()
  // Android-only: the desktop self-updates via electron-updater, but an APK has
  // to tell the waiter a new build exists and link them to the download.
  const availableUpdate = useUpdateCheck()
  const [activeTab, setActiveTab] = useState<TabId>('menu')
  // Selected table is shared: waiters pick it on the Tables tab, serve it on the Menu tab.
  const [selectedTableKey, setSelectedTableKey] = useState<string>('takeaway')
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
  // Opening-page identity: the waiter who entered their code. Null = locked,
  // shows the gate page. Deliberately not persisted — every app start asks.
  const [activeWaiter, setActiveWaiter] = useState<string | null>(null)
  // Whether a shift is currently open (null = still checking). No open shift →
  // the start-shift screen gates everything; opening one reveals the waiter gate.
  const [shiftOpen, setShiftOpen] = useState<boolean | null>(null)
  // Whether this venue runs shifts at all. Off → no start/end-shift screens.
  const [shiftsOn, setShiftsOn] = useState(true)
  // Supervisor PIN prompt guarding Sign Out — signing out unregisters the
  // device, so it takes the same approval as cancelling an order.
  const [confirmSignOut, setConfirmSignOut] = useState(false)
  const [restaurantName, setRestaurantName] = useState<string>('')
  // Edit-pending flow: set from the Pending tab, consumed by the POS tab.
  const [editingOrderId, setEditingOrderId] = useState<string | null>(null)

  const waiterName = activeWaiter ?? user?.name ?? ''
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

  // Keep the Pending Orders badge current regardless of which tab is open.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const restaurantId = await getConfig('restaurantId')
        const orders = await getOrders({ statuses: ['PENDING', 'UNCONFIRMED'], restaurantId })
        if (!cancelled) setPendingCount(orders.length)
      } catch { /* DB not ready yet */ }
    })()
    return () => { cancelled = true }
  }, [syncVersion, activeTab])

  // Track whether a shift is open — re-checked on every sync so a shift opened
  // or closed on another terminal reflects here too. A venue with shifts switched
  // off has no gate to pass, so it counts as permanently open here.
  const refreshShift = useCallback(async () => {
    try {
      const [enabled, name] = await Promise.all([areShiftsEnabled(), getConfig('restaurantName')])
      setShiftsOn(enabled)
      setRestaurantName(name?.trim() || '')
      setShiftOpen(enabled ? Boolean(await getActiveShift()) : true)
    } catch {
      setShiftOpen(false)
    }
  }, [])

  useEffect(() => {
    void refreshShift()
  }, [refreshShift, syncVersion])

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

  const handleBranchSelect = async (branchId: string) => {
    if (branchId === activeBranchId || branchSwitchingId) return
    if (!isOnline) {
      setLastSyncWarning('Connect to the internet to switch stations.')
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

  // Gate order: a shift must be open before any orders can be taken, then a
  // waiter must identify themselves. Both are rendered in place of the shell but
  // sync keeps running behind them (a fresh install pulls codes + the open shift
  // while the gate shows). While the first shift check is still pending, show
  // nothing rather than flashing the start-shift screen over an open shift.
  if (shiftOpen === null) {
    return <div className="h-screen bg-gray-900" />
  }

  if (!shiftOpen) {
    return (
      <ShiftGatePage
        restaurantName={restaurantName}
        onShiftStarted={() => { setShiftOpen(true); void runSync() }}
      />
    )
  }

  if (!activeWaiter) {
    return (
      <WaiterGatePage
        accountName={user?.name ?? ''}
        syncVersion={syncVersion}
        shiftsEnabled={shiftsOn}
        onUnlock={(name) => setActiveWaiter(name)}
        onShiftEnded={() => { setActiveWaiter(null); setShiftOpen(false); void runSync() }}
      />
    )
  }

  return (
    <div className="h-screen flex flex-col bg-gray-50 overflow-hidden">

      {/* ── Update banner ── */}
      {availableUpdate && (
        <a
          href={availableUpdate.downloadUrl}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-2 bg-blue-600 text-white text-xs font-semibold px-4 py-2 flex-shrink-0"
        >
          <Download className="h-3.5 w-3.5 flex-shrink-0" />
          <span>Update v{availableUpdate.version} available — tap to download</span>
        </a>
      )}

      {/* ── Offline banner ──
          Two different failures used to share this one message, which sent staff
          to check a router that was working fine. The device having no network is
          not the same as the server being unreachable, so they now say so
          separately, and the unreachable case offers a retry instead of just
          telling the waiter to wait. */}
      {!isOnline && (
        <div className="flex items-center gap-2 bg-amber-500 text-white text-xs font-semibold px-4 py-2 flex-shrink-0">
          <WifiOff className="h-3.5 w-3.5 flex-shrink-0" />
          <span>You are now working offline! Orders will keep saving locally and sync automatically when connected.</span>
        </div>
      )}

      {isOnline && transportOfflineMode && (
        <div className="flex items-center gap-2 bg-amber-600 text-white text-xs font-semibold px-4 py-2 flex-shrink-0">
          <WifiOff className="h-3.5 w-3.5 flex-shrink-0" />
          <span className="flex-1">Can't reach the server — orders are saving locally.</span>
          <button
            type="button"
            onClick={() => { void runSync() }}
            disabled={syncing}
            className="flex items-center gap-1 rounded-md bg-white/20 px-2 py-0.5 font-bold hover:bg-white/30 disabled:opacity-60 flex-shrink-0"
          >
            <RefreshCw className={`h-3 w-3 ${syncing ? 'animate-spin' : ''}`} />
            {syncing ? 'Retrying…' : 'Retry'}
          </button>
        </div>
      )}

      {/* ── Sync error banner ──
          Not gated on isOnline any more: a failure that happened while connected
          is still the reason orders are stuck, and hiding it the moment the
          device drops leaves the waiter with no explanation at all. */}
      {lastSyncError && (
        <div className="flex items-center gap-2 bg-red-500 text-white text-xs font-medium px-4 py-1.5 flex-shrink-0">
          <span className="flex-1">Sync failed: {lastSyncError}</span>
          {isOnline && (
            <button
              type="button"
              onClick={() => { void runSync() }}
              disabled={syncing}
              className="flex items-center gap-1 rounded-md bg-white/20 px-2 py-0.5 font-bold hover:bg-white/30 disabled:opacity-60 flex-shrink-0"
            >
              <RefreshCw className={`h-3 w-3 ${syncing ? 'animate-spin' : ''}`} />
              {syncing ? 'Retrying…' : 'Retry'}
            </button>
          )}
        </div>
      )}

      {isOnline && !lastSyncError && lastSyncWarning && (
        <div className="flex items-center gap-2 bg-amber-500 text-white text-xs font-medium px-4 py-1.5 flex-shrink-0">
          <span>Sync warning: {lastSyncWarning}</span>
        </div>
      )}

      {/* ── Top navigation bar ── */}
      <header className="bg-gray-900 text-white shadow-md flex-shrink-0 z-30 pt-12">
        <div className="px-4 flex items-center justify-between h-14">

          {/* Brand / waiter name */}
          <div className="flex items-center gap-2 flex-shrink-0">
            <div className="w-7 h-7 rounded-lg bg-orange-500 flex items-center justify-center text-white font-black text-xs select-none">
              {initials}
            </div>
            {waiterName && (
              <span className="text-sm font-bold text-white leading-none hidden sm:block">{waiterName}</span>
            )}
            {/* Build version — so any terminal's installed version is visible at a glance. */}
            <span className="text-[10px] font-mono text-gray-400 leading-none select-none">
              v{APP_VERSION}
            </span>
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
                {t.id === 'pending' && pendingCount > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 h-4 min-w-[16px] bg-orange-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center px-1">
                    {pendingCount}
                  </span>
                )}
              </button>
            ))}
          </nav>

          {/* Right side: exit-to-gate + sync indicator + sign out */}
          <div className="flex items-center gap-1 flex-shrink-0">
            {/* Exit (switch waiter) is the button staff hit every handover, so it
                is the wide, solid one. Sign Out sits beside it as a quiet outline
                — same neighbourhood, unmistakably not the same action. */}
            <button
              onClick={() => setActiveWaiter(null)}
              title="Exit to the waiter code page"
              className="flex items-center justify-center gap-2 min-w-[104px] text-sm font-bold px-5 py-2 rounded-lg bg-red-600 text-white hover:bg-red-700 shadow-sm transition-colors flex-shrink-0"
            >
              <Power className="h-4 w-4" />
              <span>Exit</span>
            </button>
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
              onClick={() => setConfirmSignOut(true)}
              title="Sign this device out (supervisor PIN required)"
              className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border border-white/15 text-gray-400 hover:text-white hover:bg-white/5 transition-colors flex-shrink-0"
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
            syncVersion={syncVersion}
            selectedTableKey={selectedTableKey}
            onSelectTableKey={setSelectedTableKey}
            editingOrderId={editingOrderId}
            onEditDone={() => setEditingOrderId(null)}
          />
        )}
        {activeTab === 'pending' && (
          <div className="max-w-5xl mx-auto px-4 py-6">
            <RestaurantOrders
              mode="pending"
              waiterName={waiterName}
              activeBranchId={activeBranchId}
              syncVersion={syncVersion}
              onEditOrder={(orderId) => { setEditingOrderId(orderId); setActiveTab('menu') }}
            />
          </div>
        )}
        {activeTab === 'tables' && (
          <div className="max-w-5xl mx-auto px-4 py-6">
            <RestaurantTables
              waiterName={waiterName}
              activeBranchId={activeBranchId}
              onSelectTable={(key) => { setSelectedTableKey(key); setActiveTab('menu') }}
            />
          </div>
        )}
        {activeTab === 'mep' && (
          <div className="max-w-5xl mx-auto px-4 py-6">
            <MepPage
              waiterName={waiterName}
              activeBranchId={activeBranchId}
              syncVersion={syncVersion}
              isOnline={isOnline && !transportOfflineMode}
              requestSync={() => { void runSync() }}
            />
          </div>
        )}
        {activeTab === 'printers' && (
          <div className="max-w-5xl mx-auto px-4 py-6">
            <PrinterSettings />
          </div>
        )}
        {activeTab === 'logs' && (
          <div className="max-w-5xl mx-auto px-4 py-6">
            <StartupLogPage />
          </div>
        )}
      </main>

      {confirmSignOut && (
        <SupervisorPinDialog
          title="Sign out device"
          prompt="Signing out unregisters this till. Enter the supervisor PIN to confirm."
          confirmLabel="Sign out"
          busyLabel="Signing out…"
          onClose={() => setConfirmSignOut(false)}
          onApproved={async () => { await onLogout() }}
        />
      )}
    </div>
  )
}
