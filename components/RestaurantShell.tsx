'use client'

import { useState, useEffect } from 'react'
import Image from 'next/image'
import { LayoutDashboard, UtensilsCrossed, Layout, ClipboardList, ChefHat, Package, BarChart3, Users, LogOut, Sparkles, Bell, X, ArrowLeftRight, BrainCircuit, Settings, Radio, Menu, RefreshCw, Plus } from 'lucide-react'
import { signOut, useSession } from 'next-auth/react'
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
import WaiterShell from '@/components/restaurant/WaiterShell'
import KitchenShell from '@/components/restaurant/KitchenShell'
import OwnerShell from '@/components/restaurant/OwnerShell'
import RestaurantLive from '@/components/restaurant/RestaurantLive'
import { RestaurantBranchProvider } from '@/contexts/RestaurantBranchContext'
import { AI_ANALYTICS_ENABLED } from '@/lib/aiAnalyticsFeature'

type TabId = 'dashboard' | 'live' | 'menu' | 'tables' | 'orders' | 'kitchen' | 'inventory' | 'reports' | 'staff' | 'transactions' | 'analytics' | 'settings'
type BranchTab = {
  id: string
  name: string
  code: string
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
    { id: 'inventory', label: 'Inventory', icon: <Package className="h-4 w-4" /> },
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

export default function RestaurantShell() {
  const { data: session, status, update } = useSession()
  const [activeTab, setActiveTab] = useState<TabId>('transactions')
  const [showJesse, setShowJesse] = useState(false)
  const [trackingMode, setTrackingMode] = useState<'simple' | 'dish_tracking'>('simple')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [wastePendingCount, setWastePendingCount] = useState(0)
  const [branches, setBranches] = useState<BranchTab[]>([])
  const [activeBranchId, setActiveBranchId] = useState<string | null>(null)
  const [branchesLoaded, setBranchesLoaded] = useState(false)
  const [branchSwitchingId, setBranchSwitchingId] = useState<string | null>(null)
  const [branchError, setBranchError] = useState<string | null>(null)
  const [branchNotice, setBranchNotice] = useState<string | null>(null)
  const [branchCreateOpen, setBranchCreateOpen] = useState(false)
  const [branchCreating, setBranchCreating] = useState(false)
  const [branchForm, setBranchForm] = useState({ name: '', code: '' })

  const userRole = (session?.user as any)?.role

  const canQueryServer = () => typeof navigator === 'undefined' || navigator.onLine !== false

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

    const loadBranches = async () => {
      try {
        const res = await fetch('/api/restaurant/branches', { credentials: 'include', cache: 'no-store' })
        const data = await res.json().catch(() => null)
        if (!res.ok) {
          throw new Error(data?.error || 'Failed to load branches')
        }

        if (cancelled) return

        setBranches(Array.isArray(data?.branches) ? data.branches : [])
        setActiveBranchId(typeof data?.activeBranchId === 'string' ? data.activeBranchId : null)
        setBranchError(null)
      } catch (error) {
        if (cancelled) return
        setBranches([])
        setBranchError(error instanceof Error ? error.message : 'Branches are unavailable right now.')
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
        throw new Error(data?.error || 'Failed to switch branch')
      }

      const nextActiveBranchId = typeof data?.activeBranchId === 'string' ? data.activeBranchId : branchId
      await update({ branchId: nextActiveBranchId }).catch(() => undefined)
      setActiveBranchId(nextActiveBranchId)
      window.dispatchEvent(new Event('refreshWastePending'))
    } catch (error) {
      setBranchError(error instanceof Error ? error.message : 'Failed to switch branch')
    } finally {
      setBranchSwitchingId(null)
    }
  }

  const handleBranchCreate = async () => {
    const name = branchForm.name.trim()
    const code = branchForm.code.trim()

    if (!name || branchCreating) {
      if (!name) setBranchError('Branch name is required')
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
          code: code || null,
        }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) {
        throw new Error(data?.error || 'Failed to create branch')
      }

      const nextBranches = Array.isArray(data?.branches) ? data.branches : []
      const nextActiveBranchId = typeof data?.activeBranchId === 'string'
        ? data.activeBranchId
          : null
      const createdBranchName = typeof data?.branch?.name === 'string' ? data.branch.name : name

      setBranches(nextBranches)
      setActiveBranchId(nextActiveBranchId)
      setBranchCreateOpen(false)
      setBranchForm({ name: '', code: '' })
      setBranchNotice(`${createdBranchName} created. Select it when you want to switch.`)

      window.dispatchEvent(new Event('refreshWastePending'))
    } catch (error) {
      setBranchError(error instanceof Error ? error.message : 'Failed to create branch')
    } finally {
      setBranchCreating(false)
    }
  }

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

  // Block rendering until session is resolved â€” prevents flashing manager UI for kitchen/waiter accounts
  if (status === 'loading') return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="flex flex-col items-center gap-3 text-gray-400">
        <div className="h-8 w-8 rounded-full border-4 border-orange-200 border-t-orange-500 animate-spin"/>
        <span className="text-sm">Loadingâ€¦</span>
      </div>
    </div>
  )

  // Route non-admin accounts to their own views â€” MUST be after all hooks
  if (userRole === 'waiter') return <WaiterShell />
  if (userRole === 'kitchen') return <KitchenShell />
  if (userRole === 'owner') return <OwnerShell />

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
  const restaurantBranchContextValue = {
    restaurantId: typeof (session?.user as any)?.restaurantId === 'string' ? (session?.user as any).restaurantId : null,
    branchId: activeBranchId,
  }

  const renderActiveTab = () => {
    if (activeTab === 'dashboard') return <RestaurantDashboard onAskJesse={() => setShowJesse(true)} />
    if (activeTab === 'live') return <RestaurantLive />
    if (activeTab === 'menu') return <RestaurantMenu onAskJesse={() => setShowJesse(true)} />
    if (activeTab === 'tables') return <RestaurantTables onAskJesse={() => setShowJesse(true)} restaurantId={(session?.user as any)?.restaurantId} />
    if (activeTab === 'orders') return <RestaurantOrders onAskJesse={() => setShowJesse(true)} />
    if (activeTab === 'kitchen') return <RestaurantKitchen onAskJesse={() => setShowJesse(true)} />
    if (activeTab === 'inventory') return <RestaurantInventory onAskJesse={() => setShowJesse(true)} />
    if (activeTab === 'reports') return <RestaurantReports onAskJesse={() => setShowJesse(true)} />
    if (activeTab === 'staff') return <RestaurantStaff onAskJesse={() => setShowJesse(true)} />
    if (activeTab === 'transactions') return <RestaurantTransactions onAskJesse={() => setShowJesse(true)} />
    if (activeTab === 'analytics') return <RestaurantAnalytics onAskJesse={() => setShowJesse(true)} />
    return <RestaurantSettings />
  }

  return (
    <div className="min-h-screen bg-gray-50 flex overflow-x-hidden">
      <RestaurantCloudSync key={activeBranchId ?? 'no-branch'} />
      {/* â”€â”€ Mobile backdrop â”€â”€ */}
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
                    onClick={() => { setActiveTab(item.id); setSidebarOpen(false) }}
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
            className="w-full flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm font-medium bg-gradient-to-r from-orange-500 to-red-600 text-white hover:from-orange-600 hover:to-red-700 transition-all shadow-md"
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
          <div className="rounded-xl border border-gray-200 bg-white px-3 py-3 shadow-sm">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-widest text-gray-500">
                  <span>Branches</span>
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
                      <button
                        key={branch.id}
                        onClick={() => void handleBranchSelect(branch.id)}
                        disabled={isSwitching || isActive}
                        className={`min-w-[10rem] rounded-xl border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-70 ${isActive ? 'border-orange-500 bg-orange-50 text-orange-700' : 'border-gray-200 bg-gray-50 text-gray-700 hover:bg-gray-100'}`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-sm font-semibold">{branch.name}</span>
                          {isSwitching ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : null}
                        </div>
                        <div className="mt-1 flex items-center gap-2 text-[11px] text-gray-500">
                          <span className="truncate">{branch.code}</span>
                          {branch.isMain ? <span className="rounded-full bg-white px-1.5 py-0.5">Main</span> : null}
                        </div>
                      </button>
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
                        <span>New branch</span>
                      </div>
                      <p className="mt-1 text-[11px] text-gray-500">Create a clean branch with its own staff, stock, orders, and reports.</p>
                    </button>,
                  ) : (
                    <div className="flex gap-2">
                      <div className="h-14 w-40 animate-pulse rounded-xl bg-gray-100" />
                      <div className="h-14 w-40 animate-pulse rounded-xl bg-gray-100" />
                    </div>
                  )}
                </div>
                {branchError ? (
                  <p className="mt-2 text-xs text-red-600">{branchError}</p>
                ) : branchNotice ? (
                  <p className="mt-2 text-xs text-emerald-600">{branchNotice}</p>
                ) : (
                  <p className="mt-2 text-xs text-gray-500">Switch branch here to update this whole workspace.</p>
                )}
              </div>
              <button
                onClick={() => setShowJesse(true)}
                className="flex-shrink-0 inline-flex items-center justify-center gap-2 rounded-lg bg-orange-500 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-orange-600"
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
                    <p className="text-lg font-bold text-gray-900">Create branch</p>
                    <p className="mt-1 text-sm text-gray-500">This starts as a clean branch. Its staff, tables, menu, inventory, orders, and reports stay separate from the others.</p>
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
                    <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">Branch name</label>
                    <input
                      value={branchForm.name}
                      onChange={(event) => setBranchForm((current) => ({ ...current, name: event.target.value }))}
                      placeholder="Kigali Downtown"
                      className="w-full rounded-xl border border-gray-300 px-3 py-2 text-sm text-gray-900 outline-none transition focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
                      disabled={branchCreating}
                    />
                  </div>

                  <div>
                    <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">Branch code (optional)</label>
                    <input
                      value={branchForm.code}
                      onChange={(event) => setBranchForm((current) => ({ ...current, code: event.target.value.toUpperCase() }))}
                      placeholder="KGLDT"
                      className="w-full rounded-xl border border-gray-300 px-3 py-2 text-sm text-gray-900 outline-none transition focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
                      disabled={branchCreating}
                    />
                    <p className="mt-1 text-xs text-gray-500">If you leave this blank, the app will create a safe unique code for you.</p>
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
                      <span>{branchCreating ? 'Creating…' : 'Create branch'}</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ) : null}

          {/* Jesse AI Modal â€” centered like a dialog */}
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
            <div key={`${activeTab}:${activeBranchId ?? 'no-branch'}`}>
              {renderActiveTab()}
            </div>
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
                  onClick={() => setActiveTab(tab)}
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

