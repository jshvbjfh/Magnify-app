'use client'

import { useState, useEffect, useCallback } from 'react'
import Image from 'next/image'
import { LayoutDashboard, UtensilsCrossed, Layout, ClipboardList, ChefHat, Package, BarChart3, Users, LogOut, Sparkles, Bell, X, ArrowLeftRight, BrainCircuit, Settings, Radio, Menu, RefreshCw, Plus, Edit2 } from 'lucide-react'
import { signOut, useSession, signIn } from 'next-auth/react'
import { fetchWithWakeup } from '@/lib/fetchWithWakeup'
import AIChat from '@/components/AIChat'
import RestaurantDashboard from '@/components/restaurant/RestaurantDashboard'
import RestaurantMenu from '@/components/restaurant/RestaurantMenu'
import RestaurantTables from '@/components/restaurant/RestaurantTables'
import RestaurantOrders from '@/components/restaurant/RestaurantOrders'
import RestaurantKitchen from '@/components/restaurant/RestaurantKitchen'
import RestaurantInventory from '@/components/restaurant/RestaurantInventory'
import RestaurantReports from '@/components/restaurant/RestaurantReports'
import RestaurantStaff from '@/components/restaurant/RestaurantStaff'
import RestaurantTransactions from '@/components/restaurant/RestaurantTransactions'
import RestaurantAnalytics from '@/components/restaurant/RestaurantAnalytics'
import RestaurantSettings from '@/components/restaurant/RestaurantSettings'
import RestaurantCloudSync from '@/components/restaurant/RestaurantCloudSync'
import RestaurantLive from '@/components/restaurant/RestaurantLive'
import { RestaurantBranchProvider } from '@/contexts/RestaurantBranchContext'
import { AI_ANALYTICS_ENABLED } from '@/lib/aiAnalyticsFeature'

type TabId = 'dashboard' | 'live' | 'menu' | 'tables' | 'orders' | 'kitchen' | 'inventory' | 'reports' | 'staff' | 'transactions' | 'analytics' | 'settings'
type BranchTab = {
  id: string
  name: string
  code: string
  type?: string
  isMain: boolean
}

const pageMeta: Record<TabId, { title: string; sub: string }> = {
  dashboard: { title: 'Dashboard', sub: 'Your restaurant at a glance' },
  live:      { title: 'Live View', sub: 'Active orders & completed sales in real time' },
  orders:    { title: 'Orders', sub: 'Full order lifecycle history and status control' },
  kitchen:   { title: 'Waste Management', sub: 'Waste logs and kitchen-side loss tracking' },
  tables:    { title: 'Tables', sub: 'Floor plan & table status' },
  menu:      { title: 'Menu', sub: 'Dishes & recipe builder' },
  inventory: { title: 'Inventory', sub: 'Ingredients & stock levels' },
  reports:   { title: 'Reports', sub: 'Financial reports & AI analysis' },
  staff:        { title: 'Staff', sub: 'Employees & shift tracker' },
  transactions:  { title: 'Transactions', sub: 'Journal entries & financial records' },
  analytics:     { title: 'AI Analytics', sub: AI_ANALYTICS_ENABLED ? 'AI-generated insights about your restaurant' : 'Archived and currently disabled' },
  settings:      { title: 'Settings', sub: 'Restaurant profile & receipt configuration' },
}

type NavItem = { id: TabId; label: string; icon: React.ReactNode }
const navGroups: { section?: string; items: NavItem[] }[] = [
  { items: [
    { id: 'dashboard', label: 'Dashboard', icon: <LayoutDashboard className="h-4 w-4" /> },
    { id: 'live',      label: 'Live View',  icon: <Radio className="h-4 w-4" /> },
  ]},
  { section: 'Orders', items: [
    { id: 'orders', label: 'Orders', icon: <ClipboardList className="h-4 w-4" /> },
    { id: 'transactions', label: 'Transactions', icon: <ArrowLeftRight className="h-4 w-4" /> },
  ]},
  { section: 'Floor', items: [
    { id: 'tables', label: 'Tables', icon: <Layout className="h-4 w-4" /> },
    { id: 'kitchen', label: 'Waste Management', icon: <ChefHat className="h-4 w-4" /> },
  ]},
  { section: 'Management', items: [
    { id: 'menu', label: 'Menu', icon: <UtensilsCrossed className="h-4 w-4" /> },
    { id: 'inventory', label: 'Stock', icon: <Package className="h-4 w-4" /> },
    { id: 'reports', label: 'Reports', icon: <BarChart3 className="h-4 w-4" /> },
    { id: 'analytics', label: 'AI Analytics', icon: <BrainCircuit className="h-4 w-4" /> },
    { id: 'staff', label: 'Staff', icon: <Users className="h-4 w-4" /> },
  ]},
  { section: 'Account', items: [
    { id: 'settings', label: 'Settings', icon: <Settings className="h-4 w-4" /> },
  ]},
]

const mobileTabMeta: Record<TabId, { label: string; icon: React.ReactNode }> = {
  dashboard: { label: 'Home', icon: <LayoutDashboard className="h-4 w-4" /> },
  live: { label: 'Live', icon: <Radio className="h-4 w-4" /> },
  orders: { label: 'Orders', icon: <ClipboardList className="h-4 w-4" /> },
  kitchen: { label: 'Waste', icon: <ChefHat className="h-4 w-4" /> },
  tables: { label: 'Tables', icon: <Layout className="h-4 w-4" /> },
  menu: { label: 'Menu', icon: <UtensilsCrossed className="h-4 w-4" /> },
  inventory: { label: 'Stock', icon: <Package className="h-4 w-4" /> },
  reports: { label: 'Reports', icon: <BarChart3 className="h-4 w-4" /> },
  staff: { label: 'Staff', icon: <Users className="h-4 w-4" /> },
  transactions: { label: 'Money', icon: <ArrowLeftRight className="h-4 w-4" /> },
  analytics: { label: 'AI', icon: <BrainCircuit className="h-4 w-4" /> },
  settings: { label: 'Settings', icon: <Settings className="h-4 w-4" /> },
}

const confirmedBranchCookies = new Set<string>()

export default function RestaurantShell() {
  const { data: session, status, update } = useSession()
  const [activeTab, setActiveTab] = useState<TabId>('transactions')
  const [mountedTabs, setMountedTabs] = useState<Set<TabId>>(() => new Set<TabId>(['transactions']))
  const [showJesse, setShowJesse] = useState(false)
  const [trackingMode, setTrackingMode] = useState<'simple' | 'dish_tracking'>('simple')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [licenseNotice, setLicenseNotice] = useState<{ daysLeft: number; status: string } | null>(null)
  const [licenseDismissed, setLicenseDismissed] = useState(false)
  const [wastePendingCount, setWastePendingCount] = useState(0)
  const [branches, setBranches] = useState<BranchTab[]>([])
  const [activeBranchId, setActiveBranchId] = useState<string | null>(null)
  const [branchesLoaded, setBranchesLoaded] = useState(false)
  const [branchConnecting, setBranchConnecting] = useState(false)
  const [branchSwitchingId, setBranchSwitchingId] = useState<string | null>(null)
  const [branchError, setBranchError] = useState<string | null>(null)
  const [branchNotice, setBranchNotice] = useState<string | null>(null)
  const [branchCreateOpen, setBranchCreateOpen] = useState(false)
  const [branchCreating, setBranchCreating] = useState(false)
  const [branchForm, setBranchForm] = useState({ name: '', type: 'kitchen' as 'kitchen' | 'bar' })
  const [branchEditId, setBranchEditId] = useState<string | null>(null)
  const [branchEditForm, setBranchEditForm] = useState({ name: '', code: '' })
  const [branchEditing, setBranchEditing] = useState(false)

  const userRole = (session?.user as any)?.role

  const canQueryServer = () => typeof navigator === 'undefined' || navigator.onLine !== false

  const handleTabChange = (tab: TabId) => {
    setActiveTab(tab)
    setMountedTabs(prev => { const next = new Set(prev); next.add(tab); return next })
  }

  useEffect(() => {
    if (status !== 'authenticated') return
    if (userRole === 'admin') return

    // This shell is manager-only. If a cached client transition mounts it for another
    // role, force a hard round-trip so the server can render the correct app shell.
    window.location.replace('/restaurant')
  }, [status, userRole])

useEffect(() => {
    if (status !== 'authenticated' || userRole !== 'admin') {
      setBranches([])
      setActiveBranchId(null)
      setBranchesLoaded(false)
      setBranchError(null)
      setBranchNotice(null)
      return
    }

    let cancelled = false
    setBranchesLoaded(false)
    setBranchConnecting(false)

    const loadBranches = async () => {
      try {
        const res = await fetchWithWakeup(
          '/api/restaurant/branches',
          { credentials: 'include', cache: 'no-store' },
          () => { if (!cancelled) setBranchConnecting(true) },
        )
        const data = await res.json().catch(() => null)
        if (!res.ok) throw new Error(data?.error || 'Failed to load stations')

        if (cancelled) return

        const nextActiveBranchId = typeof data?.activeBranchId === 'string' ? data.activeBranchId : null
        if (nextActiveBranchId) confirmedBranchCookies.add(nextActiveBranchId)
        setBranches(Array.isArray(data?.branches) ? data.branches : [])
        setActiveBranchId(nextActiveBranchId)
        setBranchError(null)
        setBranchConnecting(false)
      } catch (error) {
        if (cancelled) return
        setBranches([])
        setBranchConnecting(false)
        setBranchError('Could not connect. Check your internet connection.')
      } finally {
        if (!cancelled) setBranchesLoaded(true)
      }
    }

    void loadBranches()

    return () => {
      cancelled = true
    }
  }, [status, userRole])

  const handleBranchSelect = async (branchId: string) => {
    if (branchId === activeBranchId || branchSwitchingId) return

    setBranchError(null)
    setBranchNotice(null)

    if (confirmedBranchCookies.has(branchId)) {
      // Revisit: restore cached UI immediately, update server cookie in background
      setActiveBranchId(branchId)
      fetch('/api/restaurant/branches', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ branchId }),
      })
        .then(r => r.ok ? r.json() : null)
        .then(data => {
          if (data?.activeBranchId) update({ branchId: data.activeBranchId }).catch(() => undefined)
          window.dispatchEvent(new Event('refreshWastePending'))
        })
        .catch(() => { window.dispatchEvent(new Event('refreshWastePending')) })
      return
    }

    // First visit: show spinner, await PATCH so cookie is set before components fetch
    setBranchSwitchingId(branchId)

    try {
      const res = await fetch('/api/restaurant/branches', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ branchId }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) {
        throw new Error(data?.error || 'Failed to switch station')
      }

      const nextActiveBranchId = typeof data?.activeBranchId === 'string' ? data.activeBranchId : branchId
      confirmedBranchCookies.add(nextActiveBranchId)
      update({ branchId: nextActiveBranchId }).catch(() => undefined)
      setActiveBranchId(nextActiveBranchId)
      window.dispatchEvent(new Event('refreshWastePending'))
    } catch (error) {
      setBranchError(error instanceof Error ? error.message : 'Failed to switch station')
    } finally {
      setBranchSwitchingId(null)
    }
  }

  const handleBranchCreate = async () => {
    const name = branchForm.name.trim()

    if (!name || branchCreating) {
      if (!name) setBranchError('Station name is required')
      return
    }

    setBranchError(null)
  setBranchNotice(null)
    setBranchCreating(true)

    try {
      const res = await fetch('/api/restaurant/branches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          name,
          type: branchForm.type,
        }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) {
        throw new Error(data?.error || 'Failed to create station')
      }

      const nextBranches = Array.isArray(data?.branches) ? data.branches : []
      const nextActiveBranchId = typeof data?.activeBranchId === 'string'
        ? data.activeBranchId
          : null
      const createdBranchName = typeof data?.branch?.name === 'string' ? data.branch.name : name

      setBranches(nextBranches)
      setActiveBranchId(nextActiveBranchId)
      setBranchCreateOpen(false)
      setBranchForm({ name: '', type: 'kitchen' })
      setBranchNotice(`${createdBranchName} created. Select it when you want to switch.`)

      window.dispatchEvent(new Event('refreshWastePending'))
    } catch (error) {
      setBranchError(error instanceof Error ? error.message : 'Failed to create station')
    } finally {
      setBranchCreating(false)
    }
  }

  const handleBranchEdit = async () => {
    const name = branchEditForm.name.trim()
    const code = branchEditForm.code.trim()
    if (!name || !branchEditId || branchEditing) return

    setBranchEditing(true)
    setBranchError(null)

    try {
      const res = await fetch(`/api/restaurant/branches/${branchEditId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ name, code: code || undefined }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.error || 'Failed to update station')

      const nextBranches = Array.isArray(data?.branches) ? data.branches : branches
      setBranches(nextBranches)
      setBranchEditId(null)
      setBranchNotice(`"${name}" updated.`)
      window.dispatchEvent(new CustomEvent('branchNameChanged', { detail: { branches: nextBranches } }))
    } catch (error) {
      setBranchError(error instanceof Error ? error.message : 'Failed to update station')
    } finally {
      setBranchEditing(false)
    }
  }

  // Keep Neon warm — ping every 4 minutes while tab is visible so cold starts
  // don't hit users during active sessions. Stops when tab is hidden.
  useEffect(() => {
    const ping = () => {
      if (!document.hidden) {
        fetch('/api/health', { credentials: 'include' }).catch(() => undefined)
      }
    }
    const id = setInterval(ping, 4 * 60 * 1000)
    return () => clearInterval(id)
  }, [])

  // Subscription reminder: warn the manager when the plan has 3 days or fewer left.
  useEffect(() => {
    if (status !== 'authenticated' || userRole !== 'admin') return
    let cancelled = false
    const checkLicense = () => {
      fetch('/api/restaurant/license', { credentials: 'include' })
        .then(r => (r.ok ? r.json() : null))
        .then(data => {
          if (cancelled || !data) return
          const days = Number(data.daysLeft)
          if ((data.status === 'active' || data.status === 'trial') && Number.isFinite(days) && days >= 0 && days <= 3) {
            setLicenseNotice({ daysLeft: days, status: data.status })
          } else {
            setLicenseNotice(null)
          }
        })
        .catch(() => {})
    }
    checkLicense()
    // Re-check a few times a day in case the app stays open.
    const id = setInterval(checkLicense, 6 * 60 * 60 * 1000)
    return () => { cancelled = true; clearInterval(id) }
  }, [status, userRole])

  // Load tracking mode fresh from DB (session may be stale after settings change)
  useEffect(() => {
    let cancelled = false

    const loadProfile = async () => {
      if (!canQueryServer()) return

      try {
        const response = await fetch('/api/user/profile', { credentials: 'include' })
        if (!response.ok) return

        const data = await response.json()
        if (!cancelled && data?.trackingMode) {
          setTrackingMode(data.trackingMode)
        }
      } catch {}
    }

    void loadProfile()
    window.addEventListener('online', loadProfile)

    return () => {
      cancelled = true
      window.removeEventListener('online', loadProfile)
    }
  }, [])

  // Re-read when settings page broadcasts a change
  useEffect(() => {
    const handler = (e: Event) => {
      const mode = (e as CustomEvent).detail?.trackingMode
      if (mode === 'simple' || mode === 'dish_tracking') setTrackingMode(mode)
    }
    window.addEventListener('trackingModeChanged', handler)
    return () => window.removeEventListener('trackingModeChanged', handler)
  }, [])

  useEffect(() => {
    if (userRole !== 'admin') return

    let cancelled = false
    const loadWastePending = async () => {
      if (!canQueryServer()) {
        if (!cancelled) setWastePendingCount(0)
        return
      }

      try {
        const res = await fetch('/api/restaurant/waste-pending', { credentials: 'include' })
        const data = await res.json().catch(() => null)
        if (!cancelled) setWastePendingCount(Number(data?.count ?? 0))
      } catch {
        if (!cancelled) setWastePendingCount(0)
      }
    }

    loadWastePending()
    const timer = window.setInterval(loadWastePending, 30000)
    const refreshHandler = () => { void loadWastePending() }
    const onlineHandler = () => { void loadWastePending() }
    window.addEventListener('refreshWastePending', refreshHandler)
    window.addEventListener('online', onlineHandler)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      window.removeEventListener('refreshWastePending', refreshHandler)
      window.removeEventListener('online', onlineHandler)
    }
  }, [activeBranchId, userRole])

  // Block rendering until session is resolved — prevents flashing manager UI for non-admin accounts
  if (status === 'loading') return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="flex flex-col items-center gap-3 text-gray-400">
        <div className="h-8 w-8 rounded-full border-4 border-orange-200 border-t-orange-500 animate-spin"/>
        <span className="text-sm">Loading…</span>
      </div>
    </div>
  )

  // If session was cleared (e.g. network failure on app resume), redirect to login
  // instead of falling through to the admin dashboard with no valid session.
  if (status === 'unauthenticated' || !userRole) {
    void signIn()
    return null
  }

  // Only admin accounts reach this point.
  if (userRole !== 'admin') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="flex flex-col items-center gap-3 text-gray-400">
          <div className="h-8 w-8 rounded-full border-4 border-orange-200 border-t-orange-500 animate-spin"/>
          <span className="text-sm">Loading your workspace…</span>
        </div>
      </div>
    )
  }

  const isDishTracking = trackingMode === 'dish_tracking'

  // Filter nav groups based on mode
  const visibleNavGroups = navGroups.map(group => ({
    ...group,
    items: group.items.filter(item => {
      if (!isDishTracking && (item.id === 'orders' || item.id === 'kitchen' || item.id === 'menu' || item.id === 'tables')) return false
      if (!AI_ANALYTICS_ENABLED && item.id === 'analytics') return false
      return true
    })
  })).filter(group => group.items.length > 0)

  const mobileTabs: TabId[] = isDishTracking
    ? ['dashboard', 'orders', 'tables', 'inventory']
    : ['dashboard', 'transactions', 'inventory', 'reports']

  const isPrimaryMobileTab = mobileTabs.includes(activeTab)
  const activeBranch = branches.find(b => b.id === activeBranchId) ?? null
  const restaurantBranchContextValue = {
    restaurantId: typeof (session?.user as any)?.restaurantId === 'string' ? (session?.user as any).restaurantId : null,
    branchId: activeBranchId,
    branchName: activeBranch?.name ?? null,
    branchType: (activeBranch?.type === 'bar' ? 'bar' : 'kitchen') as 'kitchen' | 'bar',
  }

  const sessionRestaurantId = typeof (session?.user as any)?.restaurantId === 'string'
    ? (session?.user as any).restaurantId as string
    : undefined

  // Render each tab once it has been visited, then keep it mounted and hidden.
  // This prevents re-fetching data every time the user switches tabs.
  const renderPersistentTabs = () => (
    <>
      {mountedTabs.has('dashboard') && <div style={{ display: activeTab === 'dashboard' ? undefined : 'none' }}><RestaurantDashboard onAskJesse={() => setShowJesse(true)} /></div>}
      {mountedTabs.has('live') && <div style={{ display: activeTab === 'live' ? undefined : 'none' }}><RestaurantLive /></div>}
      {mountedTabs.has('menu') && <div style={{ display: activeTab === 'menu' ? undefined : 'none' }}><RestaurantMenu onAskJesse={() => setShowJesse(true)} /></div>}
      {mountedTabs.has('tables') && <div style={{ display: activeTab === 'tables' ? undefined : 'none' }}><RestaurantTables onAskJesse={() => setShowJesse(true)} restaurantId={sessionRestaurantId} /></div>}
      {mountedTabs.has('orders') && <div style={{ display: activeTab === 'orders' ? undefined : 'none' }}><RestaurantOrders onAskJesse={() => setShowJesse(true)} /></div>}
      {mountedTabs.has('kitchen') && <div style={{ display: activeTab === 'kitchen' ? undefined : 'none' }}><RestaurantKitchen onAskJesse={() => setShowJesse(true)} /></div>}
      {mountedTabs.has('inventory') && <div style={{ display: activeTab === 'inventory' ? undefined : 'none' }}><RestaurantInventory onAskJesse={() => setShowJesse(true)} /></div>}
      {mountedTabs.has('reports') && <div style={{ display: activeTab === 'reports' ? undefined : 'none' }}><RestaurantReports onAskJesse={() => setShowJesse(true)} /></div>}
      {mountedTabs.has('staff') && <div style={{ display: activeTab === 'staff' ? undefined : 'none' }}><RestaurantStaff onAskJesse={() => setShowJesse(true)} /></div>}
      {mountedTabs.has('transactions') && <div style={{ display: activeTab === 'transactions' ? undefined : 'none' }}><RestaurantTransactions onAskJesse={() => setShowJesse(true)} /></div>}
      {mountedTabs.has('analytics') && <div style={{ display: activeTab === 'analytics' ? undefined : 'none' }}><RestaurantAnalytics onAskJesse={() => setShowJesse(true)} /></div>}
      {mountedTabs.has('settings') && <div style={{ display: activeTab === 'settings' ? undefined : 'none' }}><RestaurantSettings /></div>}
    </>
  )

  return (
    <div className="min-h-screen bg-gray-50 flex overflow-x-hidden">
      <RestaurantCloudSync key={activeBranchId ?? 'no-branch'} />
      {/* Mobile backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside className={`fixed top-0 left-0 h-full w-[85vw] max-w-[20rem] bg-gray-900 text-white flex flex-col z-50 transition-transform duration-300 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'} lg:translate-x-0 lg:w-52 lg:max-w-none xl:w-64`}>
        {/* Brand */}
        <div className="p-4 border-b border-gray-700">
          <div className="flex items-center gap-2">
            <Image
              src="/icon.png"
              alt="Magnify"
              width={32}
              height={32}
              className="h-8 w-8 rounded-lg flex-shrink-0"
              priority
            />
            <div className="min-w-0">
              <p className="text-base font-bold text-white leading-tight truncate">Magnify</p>
            </div>
            {/* Close button (mobile only) */}
            <button
              onClick={() => setSidebarOpen(false)}
              className="ml-auto text-gray-400 hover:text-white lg:hidden"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          {session?.user?.name && (
            <p className="mt-2 text-xs text-gray-400 truncate">{session.user.name}</p>
          )}
        </div>

        {/* Nav */}
        <nav className="flex-1 p-3 overflow-y-auto">
          {visibleNavGroups.map((group, gi) => (
            <div key={gi}>
              {gi > 0 && (
                <div className="my-2">
                  <div className="h-px bg-gray-700"/>
                  {group.section && (
                    <p className="text-[10px] font-bold text-gray-500 uppercase tracking-widest px-2 mt-2 mb-1">{group.section}</p>
                  )}
                </div>
              )}
              <div className="space-y-0.5">
                {group.items.map(item => (
                  <button
                    key={item.id}
                    onClick={() => { handleTabChange(item.id); setSidebarOpen(false) }}
                    className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm font-medium transition-all text-left ${
                      activeTab === item.id
                        ? 'bg-orange-500 text-white shadow-md'
                        : 'text-gray-400 hover:text-white hover:bg-gray-800'
                    }`}
                  >
                    {item.icon}
                    <span className="flex-1">{item.label}</span>
                    {item.id === 'kitchen' && wastePendingCount > 0 && (
                      <span className="min-w-5 rounded-full bg-red-500 px-1.5 py-0.5 text-center text-[10px] font-bold text-white">
                        {wastePendingCount}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </nav>

        {/* Footer */}
        <div className="p-3 border-t border-gray-700 space-y-1">
          <button
            onClick={() => setShowJesse(true)}
            className="w-full flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm font-medium bg-gradient-to-r from-orange-500 to-red-600 text-white hover:from-orange-600 hover:to-red-700 transition-colors"
          >
            <Sparkles className="h-4 w-4" />
            Ask Jesse AI
          </button>
          <button
            onClick={() => signOut({ callbackUrl: '/login' })}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-gray-400 hover:text-white hover:bg-gray-800 transition-all"
          >
            <LogOut className="h-4 w-4" />
            Sign Out
          </button>
        </div>
      </aside>

      {/* Main */}
      <div className="lg:ml-52 xl:ml-64 flex-1 flex flex-col min-h-screen min-w-0 overflow-x-hidden">
        {/* Top bar */}
        <header className="sticky top-0 z-20 bg-white border-b border-gray-200 px-4 lg:px-6 py-3 flex items-center justify-between shadow-sm">
          {/* Hamburger (mobile) */}
          <button
            onClick={() => setSidebarOpen(true)}
            className="mr-3 p-2 rounded-lg hover:bg-gray-100 transition-colors lg:hidden"
          >
            <Menu className="h-5 w-5 text-gray-600" />
          </button>
          <div className="min-w-0">
            <h1 className="text-base lg:text-lg font-bold text-gray-900 truncate">{pageMeta[activeTab].title}</h1>
            <p className="text-xs text-gray-500 hidden sm:block">{pageMeta[activeTab].sub}</p>
          </div>
          <div className="flex items-center gap-2 ml-auto">
            <button className="relative p-2 rounded-lg hover:bg-gray-100 transition-colors hidden sm:block">
              <Bell className="h-5 w-5 text-gray-600" />
              <span className="absolute top-1 right-1 h-2 w-2 rounded-full bg-red-500"></span>
            </button>
            <div className="flex items-center gap-2 px-2 py-1.5 bg-orange-50 rounded-lg border border-orange-200">
              <div className="h-6 w-6 rounded-full bg-gradient-to-br from-orange-400 to-red-600 flex items-center justify-center flex-shrink-0">
                <span className="text-xs font-bold text-white">
                  {session?.user?.name?.charAt(0).toUpperCase() ?? 'R'}
                </span>
              </div>
              <span className="text-xs font-medium text-gray-700 hidden md:block">
                {session?.user?.name ?? 'Restaurant'}
              </span>
            </div>
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1 p-3 sm:p-4 lg:p-6 pb-24 lg:pb-6 min-w-0 space-y-4">
          {licenseNotice && !licenseDismissed && (
            <div className="flex items-start justify-between gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 shadow-sm">
              <div className="flex items-start gap-2 text-sm text-amber-800">
                <Bell className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600" />
                <span>
                  <span className="font-semibold">
                    Your {licenseNotice.status === 'trial' ? 'free trial' : 'subscription'} ends in {licenseNotice.daysLeft} day{licenseNotice.daysLeft === 1 ? '' : 's'}.
                  </span>{' '}
                  Renew now to avoid any interruption to service.
                </span>
              </div>
              <button onClick={() => setLicenseDismissed(true)} className="flex-shrink-0 text-amber-500 hover:text-amber-700" aria-label="Dismiss">
                <X className="h-4 w-4" />
              </button>
            </div>
          )}
          <div className="rounded-xl border border-gray-200 bg-white px-3 py-3 shadow-sm">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-widest text-gray-500">
                  <span>Stations</span>
                  {branchesLoaded && branches.length > 0 ? (
                    <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] text-gray-600">
                      {branches.length}
                    </span>
                  ) : null}
                </div>
                <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
                  {branchesLoaded ? branches.map((branch) => {
                    const isActive = branch.id === activeBranchId
                    const isSwitching = branch.id === branchSwitchingId

                    return (
                      <div key={branch.id} className="relative group flex-shrink-0">
                        <button
                          onClick={() => void handleBranchSelect(branch.id)}
                          disabled={isSwitching || isActive}
                          className={`min-w-[10rem] rounded-xl border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-70 ${isActive ? 'border-orange-500 bg-orange-50 text-orange-700' : 'border-gray-200 bg-gray-50 text-gray-700 hover:bg-gray-100'}`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate text-sm font-semibold">{branch.name}</span>
                            {isSwitching ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : null}
                          </div>
                          <div className="mt-1 flex items-center gap-2 text-[11px] text-gray-500">
                            <span className="capitalize">{branch.type ?? 'kitchen'}</span>
                            {branch.isMain ? <span className="rounded-full bg-white px-1.5 py-0.5">Main</span> : null}
                          </div>
                        </button>
                        {/* Edit pencil — visible on hover or when active */}
                        <button
                          type="button"
                          title="Rename station"
                          onClick={(e) => {
                            e.stopPropagation()
                            setBranchEditId(branch.id)
                            setBranchEditForm({ name: branch.name, code: branch.code })
                            setBranchError(null)
                          }}
                          className="absolute -top-1.5 -right-1.5 h-6 w-6 rounded-full bg-white border border-gray-200 shadow-sm flex items-center justify-center text-gray-400 hover:text-orange-500 hover:border-orange-300 opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          <Edit2 className="h-3 w-3" />
                        </button>
                      </div>
                    )
                  }).concat(
                    <button
                      key="create-branch"
                      type="button"
                      onClick={() => {
                        setBranchError(null)
                        setBranchNotice(null)
                        setBranchCreateOpen(true)
                      }}
                      className="min-w-[10rem] rounded-xl border border-dashed border-gray-300 bg-white px-3 py-2 text-left text-gray-700 transition-colors hover:border-orange-300 hover:bg-orange-50"
                    >
                      <div className="flex items-center gap-2 text-sm font-semibold">
                        <Plus className="h-4 w-4 text-orange-500" />
                        <span>New station</span>
                      </div>
                      <p className="mt-1 text-[11px] text-gray-500">Create a clean station with its own staff, stock, orders, and reports.</p>
                    </button>,
                  ) : (
                    <div className="flex gap-2">
                      <div className="h-14 w-40 animate-pulse rounded-xl bg-gray-100" />
                      <div className="h-14 w-40 animate-pulse rounded-xl bg-gray-100" />
                    </div>
                  )}
                </div>
                {branchConnecting && (
                  <p className="mt-2 text-xs text-amber-600 flex items-center gap-1.5">
                    <RefreshCw className="h-3 w-3 animate-spin" />
                    Connecting to server...
                  </p>
                )}
                {branchError ? (
                  <p className="mt-2 text-xs text-red-600">{branchError}</p>
                ) : branchNotice ? (
                  <p className="mt-2 text-xs text-emerald-600">{branchNotice}</p>
                ) : (
                  <p className="mt-2 text-xs text-gray-500">Switch station here to update this whole workspace.</p>
                )}
              </div>
              <button
                onClick={() => setShowJesse(true)}
                className="flex-shrink-0 inline-flex items-center justify-center gap-2 rounded-lg bg-orange-500 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-600 transition-colors"
              >
                <Sparkles className="h-4 w-4" />
                Ask Jesse AI
              </button>
            </div>
          </div>

          {branchCreateOpen ? (
            <div className="fixed inset-0 z-40 flex items-center justify-center p-4">
              <div
                className="absolute inset-0 bg-black/40"
                onClick={() => {
                  if (branchCreating) return
                  setBranchCreateOpen(false)
                }}
              />
              <div className="relative w-full max-w-md rounded-2xl border border-gray-200 bg-white p-5 shadow-2xl">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-lg font-bold text-gray-900">Create station</p>
                    <p className="mt-1 text-sm text-gray-500">This starts as a clean station. Its staff, tables, menu, inventory, orders, and reports stay separate from the others.</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      if (branchCreating) return
                      setBranchCreateOpen(false)
                    }}
                    className="rounded-lg p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>

                <div className="mt-4 space-y-4">
                  <div>
                    <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">Station name</label>
                    <input
                      value={branchForm.name}
                      onChange={(event) => setBranchForm((current) => ({ ...current, name: event.target.value }))}
                      placeholder="e.g. BBQ, Bar, Lounge, Bakery"
                      className="w-full rounded-xl border border-gray-300 px-3 py-2 text-sm text-gray-900 outline-none transition focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
                      disabled={branchCreating}
                    />
                  </div>

                  <div>
                    <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">Station type</label>
                    <div className="flex gap-4">
                      {(['kitchen', 'bar'] as const).map((t) => (
                        <label key={t} className="flex cursor-pointer items-center gap-2">
                          <input
                            type="radio"
                            value={t}
                            checked={branchForm.type === t}
                            onChange={() => setBranchForm((f) => ({ ...f, type: t }))}
                            disabled={branchCreating}
                            className="accent-orange-500"
                          />
                          <span className="text-sm font-medium capitalize text-gray-700">{t}</span>
                        </label>
                      ))}
                    </div>
                    <p className="mt-1 text-xs text-gray-500">Kitchen stations handle food orders. Bar stations handle drinks.</p>
                  </div>

                  {branchError ? <p className="text-sm text-red-600">{branchError}</p> : null}

                  <div className="flex items-center justify-end gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => setBranchCreateOpen(false)}
                      className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
                      disabled={branchCreating}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleBranchCreate()}
                      className="inline-flex items-center gap-2 rounded-lg bg-orange-500 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-orange-600 disabled:cursor-not-allowed disabled:opacity-70"
                      disabled={branchCreating}
                    >
                      {branchCreating ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                      <span>{branchCreating ? 'Creating…' : 'Create station'}</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ) : null}

          {/* Branch edit modal */}
          {branchEditId ? (
            <div className="fixed inset-0 z-40 flex items-center justify-center p-4">
              <div className="absolute inset-0 bg-black/40" onClick={() => { if (!branchEditing) setBranchEditId(null) }} />
              <div className="relative w-full max-w-sm rounded-2xl border border-gray-200 bg-white p-5 shadow-2xl">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-lg font-bold text-gray-900">Rename station</p>
                  <button type="button" onClick={() => setBranchEditId(null)} className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700"><X className="h-4 w-4" /></button>
                </div>
                <div className="mt-4 space-y-3">
                  <div>
                    <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">Station name</label>
                    <input
                      value={branchEditForm.name}
                      onChange={(e) => setBranchEditForm(f => ({ ...f, name: e.target.value }))}
                      onKeyDown={(e) => { if (e.key === 'Enter') void handleBranchEdit() }}
                      placeholder="e.g. BBQ, Bar, Lounge"
                      className="w-full rounded-xl border border-gray-300 px-3 py-2 text-sm outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
                      disabled={branchEditing}
                      autoFocus
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">Code (optional)</label>
                    <input
                      value={branchEditForm.code}
                      onChange={(e) => setBranchEditForm(f => ({ ...f, code: e.target.value.toUpperCase() }))}
                      onKeyDown={(e) => { if (e.key === 'Enter') void handleBranchEdit() }}
                      placeholder="e.g. BBQ"
                      className="w-full rounded-xl border border-gray-300 px-3 py-2 text-sm outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
                      disabled={branchEditing}
                    />
                  </div>
                  {branchError ? <p className="text-sm text-red-600">{branchError}</p> : null}
                  <div className="flex items-center justify-end gap-2 pt-1">
                    <button type="button" onClick={() => setBranchEditId(null)} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50" disabled={branchEditing}>Cancel</button>
                    <button type="button" onClick={() => void handleBranchEdit()} className="inline-flex items-center gap-2 rounded-lg bg-orange-500 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-600 disabled:opacity-70" disabled={branchEditing}>
                      {branchEditing ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Edit2 className="h-4 w-4" />}
                      <span>{branchEditing ? 'Saving…' : 'Save'}</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ) : null}

          {/* Jesse AI Modal */}
          {showJesse && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4">
              <div className="absolute inset-0 bg-black/50" onClick={() => setShowJesse(false)} />
              <div className="relative w-full max-w-4xl h-[95vh] sm:h-[88vh] bg-white rounded-2xl shadow-2xl flex flex-col overflow-hidden">
                <div className="flex items-center justify-between px-4 sm:px-5 py-3 sm:py-4 border-b border-orange-100 bg-white flex-shrink-0">
                  <div className="flex items-center gap-2">
                    <Sparkles className="h-5 w-5 text-orange-500" />
                    <div>
                      <p className="font-bold text-gray-900 text-sm leading-tight">Jesse</p>
                      <p className="text-gray-500 text-xs leading-tight">Your AI restaurant assistant</p>
                    </div>
                  </div>
                  <button onClick={() => setShowJesse(false)} className="text-gray-400 hover:text-gray-700 transition-colors">
                    <X className="h-5 w-5" />
                  </button>
                </div>
                <div className="flex-1 overflow-hidden">
                  <AIChat />
                </div>
              </div>
            </div>
          )}
          <RestaurantBranchProvider value={restaurantBranchContextValue}>
            {renderPersistentTabs()}
          </RestaurantBranchProvider>
        </main>

        <nav className="fixed bottom-0 inset-x-0 z-30 bg-white/95 backdrop-blur border-t border-gray-200 px-2 py-2 lg:hidden">
          <div className="grid grid-cols-5 gap-1">
            {mobileTabs.map(tab => {
              const meta = mobileTabMeta[tab]
              const isActive = activeTab === tab
              return (
                <button
                  key={tab}
                  onClick={() => handleTabChange(tab)}
                  className={`flex flex-col items-center justify-center gap-1 rounded-xl py-2 text-[11px] font-medium transition-colors ${isActive ? 'bg-orange-50 text-orange-600' : 'text-gray-500 hover:bg-gray-50'}`}
                >
                  {meta.icon}
                  <span>{meta.label}</span>
                </button>
              )
            })}
            <button
              onClick={() => setSidebarOpen(true)}
              className={`flex flex-col items-center justify-center gap-1 rounded-xl py-2 text-[11px] font-medium transition-colors ${!isPrimaryMobileTab ? 'bg-orange-50 text-orange-600' : 'text-gray-500 hover:bg-gray-50'}`}
            >
              <Menu className="h-4 w-4" />
              <span>More</span>
            </button>
          </div>
        </nav>
      </div>
    </div>
  )
}

