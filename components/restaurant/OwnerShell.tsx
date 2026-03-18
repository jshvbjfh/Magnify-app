'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  BarChart3,
  CalendarDays,
  CalendarRange,
  ChefHat,
  Clock3,
  Crown,
  FileText,
  Home,
  LogOut,
  Package,
  RefreshCw,
  TrendingDown,
  TrendingUp,
  Wallet,
} from 'lucide-react'
import { signOut } from 'next-auth/react'

type OwnerView = 'home' | 'details' | 'history' | 'reports' | 'inventory'
type Period = 'today' | 'week' | 'month'
type FilterState = {
  mode: 'preset' | 'custom'
  period: Period
  from: string
  to: string
}

type DashboardData = {
  restaurantName: string
  selectedRestaurantId: string
  restaurants: { id: string; name: string }[]
  period: Period | 'custom'
  rangeLabel: string
  from: string
  to: string
  sync: {
    source: 'live' | 'snapshot' | 'minimal'
    generatedAt: string
  }
  summary: {
    revenue: number
    expenses: number
    profit: number
    salesCount: number
    transactionCount: number
    activeOrders: number
  }
  costBreakdown: {
    cogs: number
    foodCostPct: number
    laborCost: number
    laborPct: number
    wasteCost: number
    wastePct: number
    recordedExpenses: number
    primeCost: number
    primeCostPct: number
  }
  status: {
    level: 'live' | 'recent' | 'stale'
    label: string
    detail: string
    lastActivityAt: string | null
    activeOrders: number
  }
  transactions: {
    id: string
    date: string
    description: string
    amount: number
    type: string
    paymentMethod: string
    accountName: string
    categoryName: string
    categoryType: string
    isManual: boolean
  }[]
  dailyHistory: {
    date: string
    label: string
    revenue: number
    expenses: number
    profit: number
  }[]
  topDishes: { name: string; revenue: number; qty: number }[]
  lowStock: { name: string; quantity: number; reorderLevel: number; unit: string }[]
  inventory: {
    purchaseCost: number
    usedCost: number
    stockValue: number
    lowStockCount: number
    items: {
      name: string
      unit: string
      remainingQty: number
      purchasedQty: number
      purchaseCost: number
      usedQty: number
      usedCost: number
      stockValue: number
      isLow: boolean
    }[]
  }
}

const NAV_ITEMS: { id: OwnerView; label: string; icon: React.ReactNode }[] = [
  { id: 'home',      label: 'Home',      icon: <Home className="h-5 w-5" /> },
  { id: 'details',   label: 'Details',   icon: <FileText className="h-5 w-5" /> },
  { id: 'history',   label: 'History',   icon: <CalendarDays className="h-5 w-5" /> },
  { id: 'reports',   label: 'Reports',   icon: <BarChart3 className="h-5 w-5" /> },
  { id: 'inventory', label: 'Inventory', icon: <Package className="h-5 w-5" /> },
]

function formatCurrency(value: number) {
  return `${value.toLocaleString('en-RW')} RWF`
}

function formatCompactDate(value: string | null) {
  if (!value) return 'No activity yet'
  return new Intl.DateTimeFormat('en-RW', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

function getStatusClasses(level: DashboardData['status']['level']) {
  if (level === 'live') return 'bg-green-50 text-green-700 border-green-200'
  if (level === 'recent') return 'bg-amber-50 text-amber-700 border-amber-200'
  return 'bg-gray-100 text-gray-600 border-gray-200'
}

function getProfitSignal(profit: number) {
  if (profit > 0) {
    return {
      hero: 'border-green-200 bg-[linear-gradient(135deg,#ecfdf5,white_55%,#dcfce7)]',
      pill: 'bg-green-100 text-green-700',
      text: 'text-green-700',
      label: 'Making money',
    }
  }

  if (profit < 0) {
    return {
      hero: 'border-red-200 bg-[linear-gradient(135deg,#fef2f2,white_55%,#fee2e2)]',
      pill: 'bg-red-100 text-red-700',
      text: 'text-red-700',
      label: 'Losing money',
    }
  }

  return {
    hero: 'border-amber-200 bg-[linear-gradient(135deg,#fffbeb,white_55%,#fef3c7)]',
    pill: 'bg-amber-100 text-amber-700',
    text: 'text-amber-700',
    label: 'At break-even',
  }
}

function KpiCard({
  label,
  value,
  sub,
  tone = 'text-gray-900',
  icon,
}: {
  label: string
  value: string
  sub?: string
  tone?: string
  icon: React.ReactNode
}) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">{label}</p>
        <div className="rounded-xl bg-gray-100 p-2 text-gray-500">{icon}</div>
      </div>
      <p className={`mt-3 text-2xl font-bold ${tone}`}>{value}</p>
      {sub ? <p className="mt-1 text-xs text-gray-400">{sub}</p> : null}
    </div>
  )
}

function SectionCard({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-gray-200 bg-white shadow-sm">
      <div className="border-b border-gray-100 px-4 py-4 sm:px-5">
        <h3 className="text-sm font-bold text-gray-900 sm:text-base">{title}</h3>
        {sub ? <p className="mt-1 text-xs text-gray-500">{sub}</p> : null}
      </div>
      <div className="p-4 sm:p-5">{children}</div>
    </section>
  )
}

export default function OwnerShell() {
  const today = new Date().toISOString().slice(0, 10)
  const [view, setView] = useState<OwnerView>('home')
  const [filters, setFilters] = useState<FilterState>({ mode: 'preset', period: 'today', from: today, to: today })
  const [draftFrom, setDraftFrom] = useState(today)
  const [draftTo, setDraftTo] = useState(today)
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastRefresh, setLastRefresh] = useState<string | null>(null)
  const [selectedRestaurantId, setSelectedRestaurantId] = useState<string>('')
  const [selectedHomeDate, setSelectedHomeDate] = useState<string>(today)

  const load = useCallback(async (currentFilters: FilterState, currentRestaurantId?: string, currentView?: OwnerView) => {
    setLoading(true)
    setError(null)

    try {
      const params = new URLSearchParams()
      if (currentView === 'home') {
        params.set('period', 'week')
      } else {
        if (currentFilters.mode === 'custom') {
          params.set('from', currentFilters.from)
          params.set('to', currentFilters.to)
        } else {
          params.set('period', currentFilters.period)
        }
      }

      if (currentRestaurantId) {
        params.set('restaurantId', currentRestaurantId)
      }

      const res = await fetch(`/api/owner/dashboard?${params.toString()}`, { credentials: 'include' })
      if (!res.ok) {
        setError('Failed to load owner dashboard data.')
        return
      }

      const json = await res.json()
      setData(json)
      if (json.selectedRestaurantId) {
        setSelectedRestaurantId(json.selectedRestaurantId)
      }
      if (currentView === 'home' && Array.isArray(json.dailyHistory)) {
        const dates = json.dailyHistory.map((day: { date: string }) => day.date)
        if (dates.includes(today)) {
          setSelectedHomeDate((current) => dates.includes(current) ? current : today)
        } else if (dates.length > 0) {
          setSelectedHomeDate((current) => dates.includes(current) ? current : dates[dates.length - 1])
        }
      }
      setLastRefresh(new Date().toISOString())
    } catch {
      setError('Network error. Check your connection and try again.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load(filters, selectedRestaurantId, view)
  }, [filters, load, selectedRestaurantId, view])

  useEffect(() => {
    const timer = setInterval(() => {
      load(filters, selectedRestaurantId, view)
    }, 30000)
    return () => clearInterval(timer)
  }, [filters, load, selectedRestaurantId, view])

  const applyPreset = (period: Period) => {
    setFilters((current) => ({ ...current, mode: 'preset', period }))
  }

  const openHome = () => {
    setView('home')
    setFilters({ mode: 'preset', period: 'today', from: today, to: today })
    setDraftFrom(today)
    setDraftTo(today)
    setSelectedHomeDate(today)
  }

  const applyCustomRange = () => {
    if (!draftFrom || !draftTo) return
    setFilters({ mode: 'custom', period: 'today', from: draftFrom, to: draftTo })
  }

  const summary = data?.summary
  const status = data?.status
  const costBreakdown = data?.costBreakdown
  const selectedDay = data?.dailyHistory.find((day) => day.date === selectedHomeDate) ?? data?.dailyHistory.find((day) => day.date === today) ?? data?.dailyHistory[data.dailyHistory.length - 1]
  const homeSummary = selectedDay ? {
    revenue: selectedDay.revenue,
    expenses: selectedDay.expenses,
    profit: selectedDay.profit,
  } : summary
  const profitSignal = homeSummary ? getProfitSignal(homeSummary.profit) : null
  const cashFlowTotal = homeSummary ? Math.max(homeSummary.revenue + homeSummary.expenses, 1) : 1
  const revenueShare = homeSummary ? Math.max((homeSummary.revenue / cashFlowTotal) * 100, homeSummary.revenue > 0 ? 12 : 0) : 0
  const expenseShare = homeSummary ? Math.max((homeSummary.expenses / cashFlowTotal) * 100, homeSummary.expenses > 0 ? 12 : 0) : 0

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="mx-auto flex min-h-screen w-full max-w-6xl flex-col">

        {/* â”€â”€ Header â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
        <header className="sticky top-0 z-20 border-b border-gray-200 bg-white/95 px-4 py-3 backdrop-blur sm:px-6">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <div className="rounded-2xl bg-gradient-to-br from-orange-500 to-red-600 p-2.5 shadow-sm shrink-0">
                <Crown className="h-4 w-4 text-white" />
              </div>
              <div className="min-w-0">
                <h1 className="truncate text-base font-bold text-gray-900 sm:text-lg">{data?.restaurantName ?? 'Owner Dashboard'}</h1>
                <p className="text-[11px] text-gray-400">
                  {lastRefresh ? `Updated ${formatCompactDate(lastRefresh)}` : 'Loadingâ€¦'}
                  {data?.sync ? ` Â· ${data.sync.source === 'snapshot' ? 'snapshot' : data.sync.source === 'minimal' ? 'auto-sync' : 'live'}` : ''}
                </p>
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              {data?.restaurants && data.restaurants.length > 1 ? (
                <select
                  value={selectedRestaurantId}
                  onChange={(e) => setSelectedRestaurantId(e.target.value)}
                  className="rounded-xl border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 outline-none focus:border-orange-400"
                >
                  {data.restaurants.map((r) => (
                    <option key={r.id} value={r.id}>{r.name}</option>
                  ))}
                </select>
              ) : null}
              <button
                onClick={() => load(filters, selectedRestaurantId, view)}
                className="inline-flex items-center gap-1.5 rounded-xl bg-gray-100 px-3 py-1.5 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-200"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Refresh</span>
              </button>
              <button
                onClick={() => signOut({ callbackUrl: '/login' })}
                className="inline-flex items-center gap-1.5 rounded-xl bg-gray-100 px-3 py-1.5 text-sm font-medium text-gray-600 transition-colors hover:bg-red-50 hover:text-red-600"
              >
                <LogOut className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Sign out</span>
              </button>
            </div>
          </div>

          {/* Date controls â€” only for non-home views */}
          {view !== 'home' ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {(['today', 'week', 'month'] as Period[]).map((p) => (
                <button
                  key={p}
                  onClick={() => applyPreset(p)}
                  className={`rounded-xl px-3 py-1.5 text-xs font-semibold capitalize transition-colors ${
                    filters.mode === 'preset' && filters.period === p
                      ? 'bg-orange-500 text-white shadow-sm'
                      : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                  }`}
                >
                  {p === 'today' ? 'Today' : p === 'week' ? '7 days' : 'Month'}
                </button>
              ))}
              <input
                type="date"
                value={draftFrom}
                onChange={(e) => setDraftFrom(e.target.value)}
                className="rounded-xl border border-gray-200 bg-white px-3 py-1.5 text-xs outline-none focus:border-orange-400"
              />
              <span className="text-xs text-gray-400">to</span>
              <input
                type="date"
                value={draftTo}
                onChange={(e) => setDraftTo(e.target.value)}
                className="rounded-xl border border-gray-200 bg-white px-3 py-1.5 text-xs outline-none focus:border-orange-400"
              />
              <button
                onClick={applyCustomRange}
                className="inline-flex items-center gap-1.5 rounded-xl bg-gray-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-black"
              >
                <CalendarRange className="h-3 w-3" />
                Apply
              </button>
            </div>
          ) : null}
        </header>

        {/* â”€â”€ Main content â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
        <main className="flex-1 px-4 py-4 pb-24 sm:px-6 sm:py-6">
          {error ? (
            <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
          ) : null}

          {loading && !data ? (
            <div className="flex items-center justify-center py-24 text-gray-400">
              <div className="mr-3 h-8 w-8 animate-spin rounded-full border-4 border-orange-200 border-t-orange-500" />
              Loadingâ€¦
            </div>
          ) : null}

          {data && summary && status && costBreakdown ? (
            <div className="space-y-5 sm:space-y-6">

              {/* Status bar */}
              <div className={`rounded-2xl border px-4 py-3 ${getStatusClasses(status.level)}`}>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-start gap-3">
                    <Activity className="mt-0.5 h-4 w-4 flex-shrink-0" />
                    <div>
                      <p className="text-sm font-bold">{status.label}</p>
                      <p className="text-xs opacity-90">{status.detail}</p>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs font-medium">
                    <span className="rounded-full bg-white/70 px-3 py-1">Last activity: {formatCompactDate(status.lastActivityAt)}</span>
                    <span className="rounded-full bg-white/70 px-3 py-1">Active orders: {status.activeOrders}</span>
                  </div>
                </div>
              </div>

              {/* â”€â”€ HOME view â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
              {view === 'home' ? (
                <div className="space-y-4">
                  {/* Day selector */}
                  <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
                    <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Select a day</p>
                    <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
                      {data.dailyHistory.length === 0 ? (
                        <p className="text-sm text-gray-400">No daily data yet.</p>
                      ) : data.dailyHistory.map((day) => {
                        const selected = selectedDay?.date === day.date
                        return (
                          <button
                            key={day.date}
                            onClick={() => setSelectedHomeDate(day.date)}
                            className={`min-w-[110px] rounded-2xl border px-4 py-3 text-left transition-colors ${selected ? 'border-orange-300 bg-orange-50' : 'border-gray-200 bg-gray-50 hover:bg-gray-100'}`}
                          >
                            <p className={`text-[11px] font-semibold uppercase tracking-wide ${selected ? 'text-orange-600' : 'text-gray-400'}`}>{day.label}</p>
                            <p className={`mt-2 text-base font-bold ${day.profit >= 0 ? 'text-green-600' : 'text-red-600'}`}>{formatCurrency(day.profit)}</p>
                            <p className="mt-1 text-[11px] text-gray-400">{day.date === today ? 'Today' : day.date}</p>
                          </button>
                        )
                      })}
                    </div>
                  </div>

                  {/* Profit hero */}
                  {profitSignal && homeSummary ? (
                    <section className={`rounded-[24px] border p-5 shadow-sm ${profitSignal.hero}`}>
                      <p className={`text-[11px] font-bold uppercase tracking-[0.2em] ${profitSignal.text}`}>
                        {selectedDay?.date === today ? 'Today' : selectedDay?.label ?? 'Selected day'}
                      </p>
                      <div className="mt-4 grid grid-cols-3 gap-3">
                        <div className="rounded-2xl border border-white bg-white/90 p-4 shadow-sm">
                          <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Revenue</p>
                          <p className="mt-2 text-xl font-bold text-gray-900">{formatCurrency(homeSummary.revenue)}</p>
                        </div>
                        <div className="rounded-2xl border border-red-100 bg-red-50 p-4 shadow-sm">
                          <p className="text-[11px] font-semibold uppercase tracking-wide text-red-500">Expenses</p>
                          <p className="mt-2 text-xl font-bold text-red-600">{formatCurrency(homeSummary.expenses)}</p>
                        </div>
                        <div className={`rounded-2xl border p-4 shadow-sm ${homeSummary.profit >= 0 ? 'border-green-100 bg-green-50' : 'border-red-100 bg-red-50'}`}>
                          <p className={`text-[11px] font-semibold uppercase tracking-wide ${homeSummary.profit >= 0 ? 'text-green-600' : 'text-red-500'}`}>
                            {homeSummary.profit >= 0 ? 'Profit' : 'Loss'}
                          </p>
                          <p className={`mt-2 text-xl font-bold ${homeSummary.profit >= 0 ? 'text-green-700' : 'text-red-600'}`}>
                            {formatCurrency(homeSummary.profit)}
                          </p>
                        </div>
                      </div>

                      {/* cash flow bar */}
                      <div className="mt-4 rounded-2xl bg-white/80 p-4">
                        <div className="flex items-center justify-between text-xs text-gray-500 mb-2">
                          <span>Cash in vs cash out</span>
                          <span className={`font-bold ${profitSignal.text}`}>{profitSignal.label}</span>
                        </div>
                        <div className="h-3 overflow-hidden rounded-full bg-gray-200">
                          <div className="flex h-full">
                            <div className="bg-green-500 transition-all" style={{ width: `${revenueShare}%` }} />
                            <div className="bg-red-500 transition-all" style={{ width: `${expenseShare}%` }} />
                          </div>
                        </div>
                        <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                          <div className="rounded-xl bg-green-50 px-3 py-2">
                            <p className="font-semibold text-green-700">Cash in</p>
                            <p className="mt-1 font-bold text-gray-900">{formatCurrency(homeSummary.revenue)}</p>
                          </div>
                          <div className="rounded-xl bg-red-50 px-3 py-2">
                            <p className="font-semibold text-red-700">Cash out</p>
                            <p className="mt-1 font-bold text-gray-900">{formatCurrency(homeSummary.expenses)}</p>
                          </div>
                        </div>
                      </div>
                    </section>
                  ) : null}

                  {/* Top dishes quick peek */}
                  {data.topDishes.length > 0 ? (
                    <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
                      <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Top dishes today</p>
                      <div className="mt-3 space-y-2">
                        {data.topDishes.slice(0, 3).map((dish, i) => (
                          <div key={dish.name} className="flex items-center justify-between gap-3 rounded-xl bg-gray-50 px-3 py-2">
                            <p className="text-sm font-semibold text-gray-800">#{i + 1} {dish.name}</p>
                            <p className="text-sm font-bold text-gray-900">{formatCurrency(dish.revenue)}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {/* Low stock quick peek */}
                  {data.lowStock.length > 0 ? (
                    <div className="rounded-2xl border border-red-200 bg-red-50 p-4">
                      <p className="text-xs font-semibold uppercase tracking-wide text-red-600">Low stock alerts</p>
                      <div className="mt-3 space-y-2">
                        {data.lowStock.slice(0, 3).map((item) => (
                          <div key={item.name} className="flex items-center gap-2 text-sm">
                            <AlertTriangle className="h-3.5 w-3.5 text-red-500 shrink-0" />
                            <span className="font-semibold text-gray-900">{item.name}</span>
                            <span className="text-red-600">{item.quantity} {item.unit} left</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {/* â”€â”€ DETAILS view â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
              {view === 'details' ? (
                <>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <KpiCard label="Revenue" value={formatCurrency(summary.revenue)} sub={`${summary.salesCount} sales`} tone="text-gray-900" icon={<TrendingUp className="h-4 w-4" />} />
                    <KpiCard label="Expenses" value={formatCurrency(summary.expenses)} sub="Food, labor, waste" tone="text-red-600" icon={<Wallet className="h-4 w-4" />} />
                    <KpiCard label="Profit / Loss" value={formatCurrency(summary.profit)} sub={summary.profit >= 0 ? 'Above break-even' : 'Below break-even'} tone={summary.profit >= 0 ? 'text-green-600' : 'text-red-600'} icon={summary.profit >= 0 ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />} />
                    <KpiCard label="Transactions" value={summary.transactionCount.toString()} sub="In selected range" tone="text-gray-900" icon={<BarChart3 className="h-4 w-4" />} />
                  </div>

                  <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1.2fr_0.8fr]">
                    <SectionCard title="Transaction feed" sub="Money in and money out.">
                      {data.transactions.length === 0 ? (
                        <p className="text-sm text-gray-400">No transactions in this range yet.</p>
                      ) : (
                        <div className="space-y-3">
                          {data.transactions.map((txn) => (
                            <div key={txn.id} className="flex items-start justify-between gap-3 rounded-2xl border border-gray-100 bg-gray-50 px-3 py-3">
                              <div className="min-w-0">
                                <p className="truncate text-sm font-semibold text-gray-900">{txn.description}</p>
                                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-500">
                                  <span>{new Date(txn.date).toLocaleString('en-RW', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                                  <span className="rounded-full bg-white px-2 py-0.5">{txn.accountName}</span>
                                </div>
                              </div>
                              <p className={`shrink-0 text-sm font-bold ${txn.categoryType === 'expense' ? 'text-red-600' : 'text-green-600'}`}>
                                {txn.categoryType === 'expense' ? '-' : '+'}{formatCurrency(txn.amount)}
                              </p>
                            </div>
                          ))}
                        </div>
                      )}
                    </SectionCard>

                    <div className="space-y-5">
                      <SectionCard title="Summary" sub="Closing numbers.">
                        <div className="space-y-3">
                          <div className="rounded-2xl bg-orange-50 p-3">
                            <p className="text-xs font-semibold uppercase tracking-wide text-orange-600">Revenue</p>
                            <p className="mt-1 text-xl font-bold text-gray-900">{formatCurrency(summary.revenue)}</p>
                          </div>
                          <div className="rounded-2xl bg-red-50 p-3">
                            <p className="text-xs font-semibold uppercase tracking-wide text-red-600">Expenses</p>
                            <p className="mt-1 text-xl font-bold text-gray-900">{formatCurrency(summary.expenses)}</p>
                          </div>
                          <div className={`rounded-2xl p-3 ${summary.profit >= 0 ? 'bg-green-50' : 'bg-red-50'}`}>
                            <p className={`text-xs font-semibold uppercase tracking-wide ${summary.profit >= 0 ? 'text-green-700' : 'text-red-700'}`}>Profit / Loss</p>
                            <p className="mt-1 text-xl font-bold text-gray-900">{formatCurrency(summary.profit)}</p>
                          </div>
                        </div>
                      </SectionCard>

                      <SectionCard title="Low stock" sub="Items to restock.">
                        {data.lowStock.length === 0 ? (
                          <p className="text-sm font-medium text-green-600">All stock above reorder level.</p>
                        ) : (
                          <div className="space-y-2">
                            {data.lowStock.slice(0, 5).map((item) => (
                              <div key={item.name} className="flex items-center gap-3 rounded-2xl border border-red-100 bg-red-50 px-3 py-2">
                                <AlertTriangle className="h-4 w-4 shrink-0 text-red-500" />
                                <div>
                                  <p className="text-sm font-semibold text-gray-900">{item.name}</p>
                                  <p className="text-xs text-red-600">{item.quantity} {item.unit} left</p>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </SectionCard>
                    </div>
                  </div>
                </>
              ) : null}

              {/* â”€â”€ HISTORY view â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
              {view === 'history' ? (
                <div className="grid grid-cols-1 gap-5 xl:grid-cols-[0.95fr_1.05fr]">
                  <SectionCard title="Daily history" sub="What each day made and spent.">
                    {data.dailyHistory.length === 0 ? (
                      <p className="text-sm text-gray-400">No history in this range yet.</p>
                    ) : (
                      <div className="space-y-3">
                        {data.dailyHistory.map((day) => (
                          <div key={day.date} className="rounded-2xl border border-gray-100 bg-gray-50 px-4 py-3">
                            <div className="flex items-start justify-between gap-3">
                              <div>
                                <p className="text-sm font-bold text-gray-900">{day.label}</p>
                                <p className="text-xs text-gray-400">{day.date}</p>
                              </div>
                              <p className={`text-sm font-bold ${day.profit >= 0 ? 'text-green-600' : 'text-red-600'}`}>{formatCurrency(day.profit)}</p>
                            </div>
                            <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                              <div className="rounded-xl bg-white px-3 py-2">
                                <p className="text-gray-400">Revenue</p>
                                <p className="mt-1 font-semibold text-gray-900">{formatCurrency(day.revenue)}</p>
                              </div>
                              <div className="rounded-xl bg-white px-3 py-2">
                                <p className="text-gray-400">Expenses</p>
                                <p className="mt-1 font-semibold text-gray-900">{formatCurrency(day.expenses)}</p>
                              </div>
                              <div className="rounded-xl bg-white px-3 py-2">
                                <p className="text-gray-400">Result</p>
                                <p className={`mt-1 font-semibold ${day.profit >= 0 ? 'text-green-600' : 'text-red-600'}`}>{formatCurrency(day.profit)}</p>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </SectionCard>

                  <SectionCard title="Summary" sub="Trends at a glance.">
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <div className="rounded-2xl bg-gray-50 p-4">
                        <div className="flex items-center gap-2 text-gray-500">
                          <CalendarDays className="h-4 w-4" />
                          <p className="text-xs font-semibold uppercase tracking-wide">Range</p>
                        </div>
                        <p className="mt-2 text-sm font-semibold text-gray-900">{data.rangeLabel}</p>
                        <p className="mt-1 text-xs text-gray-400">{data.from} â†’ {data.to}</p>
                      </div>
                      <div className="rounded-2xl bg-gray-50 p-4">
                        <div className="flex items-center gap-2 text-gray-500">
                          <Clock3 className="h-4 w-4" />
                          <p className="text-xs font-semibold uppercase tracking-wide">Last activity</p>
                        </div>
                        <p className="mt-2 text-sm font-semibold text-gray-900">{formatCompactDate(status.lastActivityAt)}</p>
                      </div>
                    </div>
                  </SectionCard>
                </div>
              ) : null}

              {/* â”€â”€ REPORTS view â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
              {view === 'reports' ? (
                <div className="grid grid-cols-1 gap-5 xl:grid-cols-[0.9fr_1.1fr]">
                  <SectionCard title="Cost breakdown" sub="Food, labor, waste, prime cost.">
                    <div className="grid grid-cols-2 gap-3">
                      <div className="rounded-2xl bg-orange-50 p-4">
                        <div className="flex items-center gap-2 text-orange-600">
                          <ChefHat className="h-4 w-4" />
                          <p className="text-xs font-semibold uppercase tracking-wide">Food cost</p>
                        </div>
                        <p className="mt-2 text-xl font-bold text-gray-900">{costBreakdown.foodCostPct}%</p>
                        <p className="mt-1 text-xs text-gray-400">{formatCurrency(costBreakdown.cogs)}</p>
                      </div>
                      <div className="rounded-2xl bg-blue-50 p-4">
                        <div className="flex items-center gap-2 text-blue-600">
                          <Wallet className="h-4 w-4" />
                          <p className="text-xs font-semibold uppercase tracking-wide">Labor</p>
                        </div>
                        <p className="mt-2 text-xl font-bold text-gray-900">{costBreakdown.laborPct}%</p>
                        <p className="mt-1 text-xs text-gray-400">{formatCurrency(costBreakdown.laborCost)}</p>
                      </div>
                      <div className="rounded-2xl bg-red-50 p-4">
                        <div className="flex items-center gap-2 text-red-600">
                          <AlertTriangle className="h-4 w-4" />
                          <p className="text-xs font-semibold uppercase tracking-wide">Waste</p>
                        </div>
                        <p className="mt-2 text-xl font-bold text-gray-900">{costBreakdown.wastePct}%</p>
                        <p className="mt-1 text-xs text-gray-400">{formatCurrency(costBreakdown.wasteCost)}</p>
                      </div>
                      <div className="rounded-2xl bg-gray-100 p-4">
                        <div className="flex items-center gap-2 text-gray-600">
                          <BarChart3 className="h-4 w-4" />
                          <p className="text-xs font-semibold uppercase tracking-wide">Prime cost</p>
                        </div>
                        <p className="mt-2 text-xl font-bold text-gray-900">{costBreakdown.primeCostPct}%</p>
                        <p className="mt-1 text-xs text-gray-400">{formatCurrency(costBreakdown.primeCost)}</p>
                      </div>
                    </div>
                    <div className="mt-3 rounded-2xl bg-gray-50 p-4">
                      <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Recorded expenses</p>
                      <p className="mt-2 text-lg font-bold text-gray-900">{formatCurrency(costBreakdown.recordedExpenses)}</p>
                    </div>
                  </SectionCard>

                  <SectionCard title="Top dishes" sub="Best earners in the selected range.">
                    {data.topDishes.length === 0 ? (
                      <p className="text-sm text-gray-400">No dish sales in this range yet.</p>
                    ) : (
                      <div className="space-y-3">
                        {data.topDishes.map((dish, i) => (
                          <div key={dish.name} className="flex items-center justify-between gap-3 rounded-2xl border border-gray-100 bg-gray-50 px-4 py-3">
                            <div>
                              <p className="text-sm font-semibold text-gray-900">#{i + 1} {dish.name}</p>
                              <p className="mt-0.5 text-xs text-gray-400">{dish.qty} sold</p>
                            </div>
                            <p className="text-sm font-bold text-gray-900">{formatCurrency(dish.revenue)}</p>
                          </div>
                        ))}
                      </div>
                    )}
                  </SectionCard>
                </div>
              ) : null}

              {/* â”€â”€ INVENTORY view â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
              {view === 'inventory' ? (
                <div className="grid grid-cols-1 gap-5 xl:grid-cols-[0.9fr_1.1fr]">
                  <SectionCard title="Stock overview" sub="Purchased, used, and on hand.">
                    <div className="grid grid-cols-2 gap-3">
                      <div className="rounded-2xl bg-orange-50 p-4">
                        <p className="text-xs font-semibold uppercase tracking-wide text-orange-600">Purchased</p>
                        <p className="mt-2 text-xl font-bold text-gray-900">{formatCurrency(data.inventory.purchaseCost)}</p>
                      </div>
                      <div className="rounded-2xl bg-red-50 p-4">
                        <p className="text-xs font-semibold uppercase tracking-wide text-red-600">Used</p>
                        <p className="mt-2 text-xl font-bold text-gray-900">{formatCurrency(data.inventory.usedCost)}</p>
                      </div>
                      <div className="rounded-2xl bg-green-50 p-4">
                        <p className="text-xs font-semibold uppercase tracking-wide text-green-600">Stock value</p>
                        <p className="mt-2 text-xl font-bold text-gray-900">{formatCurrency(data.inventory.stockValue)}</p>
                      </div>
                      <div className="rounded-2xl bg-gray-100 p-4">
                        <p className="text-xs font-semibold uppercase tracking-wide text-gray-600">Low stock items</p>
                        <p className="mt-2 text-xl font-bold text-gray-900">{data.inventory.lowStockCount}</p>
                      </div>
                    </div>
                  </SectionCard>

                  <SectionCard title="Inventory watchlist" sub="Remote stock check.">
                    {data.inventory.items.length === 0 ? (
                      <p className="text-sm text-gray-400">No inventory in this range yet.</p>
                    ) : (
                      <div className="space-y-3">
                        {data.inventory.items.map((item) => (
                          <div key={item.name} className={`rounded-2xl border px-4 py-3 ${item.isLow ? 'border-red-200 bg-red-50' : 'border-gray-100 bg-gray-50'}`}>
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                  <Package className="h-4 w-4 text-gray-400" />
                                  <p className="truncate text-sm font-semibold text-gray-900">{item.name}</p>
                                </div>
                                <p className="mt-1 text-xs text-gray-400">
                                  Remaining: {item.remainingQty} {item.unit} Â· Used: {item.usedQty} {item.unit}
                                </p>
                              </div>
                              {item.isLow ? <span className="rounded-full bg-white px-2 py-0.5 text-xs font-semibold text-red-600">Low</span> : null}
                            </div>
                            <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                              <div className="rounded-xl bg-white px-3 py-2">
                                <p className="text-gray-400">Bought</p>
                                <p className="mt-1 font-semibold text-gray-900">{formatCurrency(item.purchaseCost)}</p>
                              </div>
                              <div className="rounded-xl bg-white px-3 py-2">
                                <p className="text-gray-400">Used</p>
                                <p className="mt-1 font-semibold text-gray-900">{formatCurrency(item.usedCost)}</p>
                              </div>
                              <div className="rounded-xl bg-white px-3 py-2">
                                <p className="text-gray-400">On hand</p>
                                <p className="mt-1 font-semibold text-gray-900">{formatCurrency(item.stockValue)}</p>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </SectionCard>
                </div>
              ) : null}

            </div>
          ) : null}
        </main>

        {/* â”€â”€ Bottom nav bar â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
        <nav className="fixed bottom-0 inset-x-0 z-30 bg-white/95 backdrop-blur border-t border-gray-200 px-2 py-2">
          <div className="mx-auto grid max-w-6xl grid-cols-5 gap-1">
            {NAV_ITEMS.map((item) => {
              const active = view === item.id
              return (
                <button
                  key={item.id}
                  onClick={() => item.id === 'home' ? openHome() : setView(item.id)}
                  className={`flex flex-col items-center justify-center gap-1 rounded-xl py-2 text-[11px] font-medium transition-colors ${active ? 'bg-orange-50 text-orange-600' : 'text-gray-500 hover:bg-gray-50'}`}
                >
                  {item.icon}
                  <span>{item.label}</span>
                </button>
              )
            })}
          </div>
        </nav>

      </div>
    </div>
  )
}
