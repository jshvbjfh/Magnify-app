'use client'

import { useState, useEffect } from 'react'
import { LayoutDashboard, UtensilsCrossed, Layout, ClipboardList, ChefHat, Package, BarChart3, Users, LogOut, Sparkles, Bell, X, ArrowLeftRight, BrainCircuit, Settings, Radio, Menu } from 'lucide-react'
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
import WaiterShell from '@/components/restaurant/WaiterShell'
import KitchenShell from '@/components/restaurant/KitchenShell'
import OwnerShell from '@/components/restaurant/OwnerShell'
import RestaurantLive from '@/components/restaurant/RestaurantLive'
import { loadOwnerSyncConfig, syncOwnerCloud } from '@/lib/ownerSyncBrowser'

type TabId = 'dashboard' | 'live' | 'menu' | 'tables' | 'orders' | 'kitchen' | 'inventory' | 'reports' | 'staff' | 'transactions' | 'analytics' | 'settings'

const pageMeta: Record<TabId, { title: string; sub: string }> = {
  dashboard: { title: 'Dashboard', sub: 'Your restaurant at a glance' },
  live:      { title: 'Live View', sub: 'Active orders & completed sales in real time' },
  orders:    { title: 'Orders', sub: 'Record sales & track active orders' },
  kitchen:   { title: 'Kitchen', sub: 'Kitchen display & waste tracker' },
  tables:    { title: 'Tables', sub: 'Floor plan & table status' },
  menu:      { title: 'Menu', sub: 'Dishes & recipe builder' },
  inventory: { title: 'Inventory', sub: 'Ingredients & stock levels' },
  reports:   { title: 'Reports', sub: 'Financial reports & AI analysis' },
  staff:        { title: 'Staff', sub: 'Employees & shift tracker' },
  transactions:  { title: 'Transactions', sub: 'Journal entries & financial records' },
  analytics:     { title: 'AI Analytics', sub: 'AI-generated insights about your restaurant' },
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
    { id: 'kitchen', label: 'Kitchen', icon: <ChefHat className="h-4 w-4" /> },
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
  kitchen: { label: 'Kitchen', icon: <ChefHat className="h-4 w-4" /> },
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
  const { data: session, status } = useSession()
  const [activeTab, setActiveTab] = useState<TabId>('dashboard')
  const [showJesse, setShowJesse] = useState(false)
  const [trackingMode, setTrackingMode] = useState<'simple' | 'dish_tracking'>('simple')
  const [sidebarOpen, setSidebarOpen] = useState(false)

  const userRole = (session?.user as any)?.role

  // Load tracking mode fresh from DB (session may be stale after settings change)
  useEffect(() => {
    fetch('/api/user/profile', { credentials: 'include' })
      .then(r => r.json())
      .then(d => { if (d.trackingMode) setTrackingMode(d.trackingMode) })
      .catch(() => {})
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

    let syncing = false
    const runSync = async () => {
      if (syncing) return

      const config = loadOwnerSyncConfig()
      if (!config.enabled || !config.targetUrl || !config.email || !config.password) return

      syncing = true
      try {
        await syncOwnerCloud(config)
      } finally {
        syncing = false
      }
    }

    runSync()
    const timer = window.setInterval(runSync, 120000)
    return () => window.clearInterval(timer)
  }, [userRole])

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
      return true
    })
  })).filter(group => group.items.length > 0)

  const mobileTabs: TabId[] = isDishTracking
    ? ['dashboard', 'orders', 'tables', 'inventory']
    : ['dashboard', 'transactions', 'inventory', 'reports']

  const isPrimaryMobileTab = mobileTabs.includes(activeTab)

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
            <div className="p-1.5 rounded-xl bg-gradient-to-br from-orange-400 to-red-600 flex-shrink-0">
              <Sparkles className="h-5 w-5 text-white" />
            </div>
            <div>
              <p className="text-sm font-bold text-white leading-tight">Jesse AI</p>
              <p className="text-xs text-orange-400 font-medium leading-tight">Restaurant</p>
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
                    {item.label}
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
            Ask Jesse
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
          {/* Jesse AI banner â€” shown on all pages except transactions & analytics which have their own */}
          {activeTab !== 'transactions' && activeTab !== 'analytics' && activeTab !== 'reports' && (
            <div className="bg-gradient-to-r from-orange-500 to-red-600 rounded-xl p-3 sm:p-4 flex items-center justify-between gap-3 shadow-md">
              <div className="flex items-center gap-2 sm:gap-3 min-w-0">
                <div className="p-1.5 sm:p-2 bg-white/20 rounded-lg flex-shrink-0">
                  <Sparkles className="h-4 w-4 sm:h-5 sm:w-5 text-white" />
                </div>
                <div className="min-w-0">
                  <p className="text-white font-semibold text-xs sm:text-sm">Ask Jesse anything</p>
                  <p className="text-orange-100 text-xs mt-0.5 hidden sm:block">
                    Record transactions, upload receipts, get strategy advice, or ask about your numbers.
                  </p>
                </div>
              </div>
              <button
                onClick={() => setShowJesse(true)}
                className="flex-shrink-0 flex items-center gap-1.5 sm:gap-2 px-3 sm:px-4 py-1.5 sm:py-2 bg-white text-orange-600 rounded-lg text-xs sm:text-sm font-semibold hover:bg-orange-50 transition-colors shadow"
              >
                <Sparkles className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                <span className="hidden sm:inline">Ask Jesse</span>
                <span className="sm:hidden">Ask</span>
              </button>
            </div>
          )}

          {/* Jesse AI Modal â€” centered like a dialog */}
          {showJesse && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4">
              <div className="absolute inset-0 bg-black/50" onClick={() => setShowJesse(false)} />
              <div className="relative w-full max-w-4xl h-[95vh] sm:h-[88vh] bg-white rounded-2xl shadow-2xl flex flex-col overflow-hidden">
                <div className="flex items-center justify-between px-4 sm:px-5 py-3 sm:py-4 bg-gradient-to-r from-orange-500 to-red-600 flex-shrink-0">
                  <div className="flex items-center gap-2">
                    <Sparkles className="h-5 w-5 text-white" />
                    <div>
                      <p className="font-bold text-white text-sm leading-tight">Jesse</p>
                      <p className="text-orange-100 text-xs leading-tight">Your AI restaurant assistant</p>
                    </div>
                  </div>
                  <button onClick={() => setShowJesse(false)} className="text-white/80 hover:text-white transition-colors">
                    <X className="h-5 w-5" />
                  </button>
                </div>
                <div className="flex-1 overflow-hidden">
                  <AIChat />
                </div>
              </div>
            </div>
          )}
          {renderActiveTab()}
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

