'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  BarChart3,
  CalendarRange,
  ChefHat,
  Clock3,
  Crown,
  LogOut,
  Package,
  RefreshCw,
  TrendingDown,
  TrendingUp,
  Wallet,
} from 'lucide-react'
import { signOut } from 'next-auth/react'

type OwnerView = 'overview' | 'history' | 'reports' | 'inventory'
type Period = 'today' | 'week' | 'month'
type FilterState = {
  mode: 'preset' | 'custom'
  period: Period
  from: string
  to: string
}

type DashboardData = {
  restaurantName: string
  period: Period | 'custom'
  rangeLabel: string
  from: string
  to: string
  sync: {
    source: 'live' | 'snapshot'
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

const VIEW_OPTIONS: { id: OwnerView; label: string }[] = [
  { id: 'overview', label: 'Today' },
  { id: 'history', label: 'History' },
  { id: 'reports', label: 'Reports' },
  { id: 'inventory', label: 'Inventory' },
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
  const [view, setView] = useState<OwnerView>('overview')
  const [filters, setFilters] = useState<FilterState>({ mode: 'preset', period: 'today', from: today, to: today })
  const [draftFrom, setDraftFrom] = useState(today)
  const [draftTo, setDraftTo] = useState(today)
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastRefresh, setLastRefresh] = useState<string | null>(null)

  const load = useCallback(async (currentFilters: FilterState) => {
    setLoading(true)
    setError(null)

    try {
      const params = new URLSearchParams()
      if (currentFilters.mode === 'custom') {
        params.set('from', currentFilters.from)
        params.set('to', currentFilters.to)
      } else {
        params.set('period', currentFilters.period)
      }

      const res = await fetch(`/api/owner/dashboard?${params.toString()}`, { credentials: 'include' })
      if (!res.ok) {
        setError('Failed to load owner dashboard data.')
        return
      }

      const json = await res.json()
      setData(json)
      setLastRefresh(new Date().toISOString())
    } catch {
      setError('Network error. Check your connection and try again.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load(filters)
  }, [filters, load])

  useEffect(() => {
    const timer = setInterval(() => {
      load(filters)
    }, 30000)
    return () => clearInterval(timer)
  }, [filters, load])

  const applyPreset = (period: Period) => {
    setFilters((current) => ({ ...current, mode: 'preset', period }))
  }

  const applyCustomRange = () => {
    if (!draftFrom || !draftTo) return
    setFilters({ mode: 'custom', period: 'today', from: draftFrom, to: draftTo })
  }

  const summary = data?.summary
  const status = data?.status
  const costBreakdown = data?.costBreakdown

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="mx-auto flex min-h-screen w-full max-w-6xl flex-col">
        <header className="sticky top-0 z-20 border-b border-gray-200 bg-white/95 px-4 py-4 backdrop-blur sm:px-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="rounded-2xl bg-gradient-to-br from-orange-500 to-red-600 p-3 shadow-sm">
                <Crown className="h-5 w-5 text-white" />
              </div>
              <div>
                <h1 className="text-lg font-bold text-gray-900 sm:text-xl">{data?.restaurantName ?? 'Owner Dashboard'}</h1>
                <p className="text-xs text-gray-500 sm:text-sm">
                  Remote owner view · last refreshed {lastRefresh ? formatCompactDate(lastRefresh) : 'just now'}
                </p>
                {data?.sync ? (
                  <p className="mt-1 text-[11px] text-gray-400">
                    Source: {data.sync.source === 'snapshot' ? 'restaurant desktop sync' : 'cloud live data'} · branch sync time {formatCompactDate(data.sync.generatedAt)}
                  </p>
                ) : null}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={() => load(filters)}
                className="inline-flex items-center gap-2 rounded-xl bg-gray-100 px-3 py-2 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-200 hover:text-gray-900"
              >
                <RefreshCw className="h-4 w-4" />
                Refresh
              </button>
              <button
                onClick={() => signOut({ callbackUrl: '/login' })}
                className="inline-flex items-center gap-2 rounded-xl bg-gray-100 px-3 py-2 text-sm font-medium text-gray-600 transition-colors hover:bg-red-50 hover:text-red-600"
              >
                <LogOut className="h-4 w-4" />
                Sign Out
              </button>
            </div>
          </div>

          <div className="mt-4 flex flex-col gap-3">
            <div className="flex flex-wrap gap-2">
              {VIEW_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  onClick={() => setView(option.id)}
                  className={`rounded-xl px-3 py-2 text-sm font-semibold transition-colors ${
                    view === option.id ? 'bg-orange-500 text-white shadow-sm' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>

            <div className="rounded-2xl border border-gray-200 bg-gray-50 p-3">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
                <div className="flex flex-wrap gap-2">
                  {(['today', 'week', 'month'] as Period[]).map((period) => (
                    <button
                      key={period}
                      onClick={() => applyPreset(period)}
                      className={`rounded-xl px-3 py-2 text-sm font-medium capitalize transition-colors ${
                        filters.mode === 'preset' && filters.period === period
                          ? 'bg-white text-gray-900 shadow-sm'
                          : 'bg-gray-200/70 text-gray-600 hover:bg-gray-200'
                      }`}
                    >
                      {period === 'today' ? 'Today' : period === 'week' ? 'Last 7 days' : 'This month'}
                    </button>
                  ))}
                </div>

                <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto]">
                  <input
                    type="date"
                    value={draftFrom}
                    onChange={(event) => setDraftFrom(event.target.value)}
                    className="rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:border-orange-400"
                  />
                  <input
                    type="date"
                    value={draftTo}
                    onChange={(event) => setDraftTo(event.target.value)}
                    className="rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:border-orange-400"
                  />
                  <button
                    onClick={applyCustomRange}
                    className="inline-flex items-center justify-center gap-2 rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-black"
                  >
                    <CalendarRange className="h-4 w-4" />
                    Apply dates
                  </button>
                </div>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-gray-500">
                <span className="rounded-full bg-white px-3 py-1 font-medium text-gray-700 shadow-sm">Range: {data?.rangeLabel ?? 'Today'}</span>
                {data ? <span>Showing {data.from} to {data.to}</span> : null}
              </div>
            </div>
          </div>
        </header>

        <main className="flex-1 px-4 py-4 sm:px-6 sm:py-6">
          {error ? (
            <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
          ) : null}

          {loading && !data ? (
            <div className="flex items-center justify-center py-24 text-gray-400">
              <div className="mr-3 h-8 w-8 animate-spin rounded-full border-4 border-orange-200 border-t-orange-500" />
              Loading owner dashboard…
            </div>
          ) : null}

          {data && summary && status && costBreakdown ? (
            <div className="space-y-5 sm:space-y-6">
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

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <KpiCard
                  label="Revenue"
                  value={formatCurrency(summary.revenue)}
                  sub={`${summary.salesCount} sale${summary.salesCount === 1 ? '' : 's'} in ${data.rangeLabel.toLowerCase()}`}
                  tone="text-gray-900"
                  icon={<TrendingUp className="h-4 w-4" />}
                />
                <KpiCard
                  label="Expenses"
                  value={formatCurrency(summary.expenses)}
                  sub="Food, labor, waste, and recorded expenses"
                  tone="text-red-600"
                  icon={<Wallet className="h-4 w-4" />}
                />
                <KpiCard
                  label="Profit / Loss"
                  value={formatCurrency(summary.profit)}
                  sub={summary.profit >= 0 ? 'Business is above break-even' : 'Business is below break-even'}
                  tone={summary.profit >= 0 ? 'text-green-600' : 'text-red-600'}
                  icon={summary.profit >= 0 ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
                />
                <KpiCard
                  label="Transactions"
                  value={summary.transactionCount.toString()}
                  sub="Recent entries in selected range"
                  tone="text-gray-900"
                  icon={<BarChart3 className="h-4 w-4" />}
                />
              </div>

              {view === 'overview' ? (
                <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1.2fr_0.8fr]">
                  <SectionCard
                    title="Today's transaction feed"
                    sub="This is the default owner view: money in, money out, and what happened most recently."
                  >
                    {data.transactions.length === 0 ? (
                      <p className="text-sm text-gray-400">No transactions recorded in this range yet.</p>
                    ) : (
                      <div className="space-y-3">
                        {data.transactions.map((txn) => (
                          <div key={txn.id} className="flex items-start justify-between gap-3 rounded-2xl border border-gray-100 bg-gray-50 px-3 py-3">
                            <div className="min-w-0">
                              <p className="truncate text-sm font-semibold text-gray-900">{txn.description}</p>
                              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-500">
                                <span>{new Date(txn.date).toLocaleString('en-RW', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                                <span className="rounded-full bg-white px-2 py-1">{txn.accountName}</span>
                                <span className="rounded-full bg-white px-2 py-1">{txn.paymentMethod}</span>
                              </div>
                            </div>
                            <div className="text-right">
                              <p className={`text-sm font-bold ${txn.categoryType === 'expense' ? 'text-red-600' : 'text-green-600'}`}>
                                {txn.categoryType === 'expense' ? '-' : '+'}{formatCurrency(txn.amount)}
                              </p>
                              <p className="mt-1 text-xs text-gray-400">{txn.categoryName}</p>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </SectionCard>

                  <div className="space-y-5">
                    <SectionCard title="Closing picture" sub="Fast reading for the owner at a glance.">
                      <div className="space-y-3">
                        <div className="rounded-2xl bg-orange-50 p-3">
                          <p className="text-xs font-semibold uppercase tracking-wide text-orange-600">Closing revenue</p>
                          <p className="mt-1 text-xl font-bold text-gray-900">{formatCurrency(summary.revenue)}</p>
                        </div>
                        <div className="rounded-2xl bg-red-50 p-3">
                          <p className="text-xs font-semibold uppercase tracking-wide text-red-600">Closing expenses</p>
                          <p className="mt-1 text-xl font-bold text-gray-900">{formatCurrency(summary.expenses)}</p>
                        </div>
                        <div className={`rounded-2xl p-3 ${summary.profit >= 0 ? 'bg-green-50' : 'bg-red-50'}`}>
                          <p className={`text-xs font-semibold uppercase tracking-wide ${summary.profit >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                            Closing profit / loss
                          </p>
                          <p className="mt-1 text-xl font-bold text-gray-900">{formatCurrency(summary.profit)}</p>
                        </div>
                      </div>
                    </SectionCard>

                    <SectionCard title="Low stock alerts" sub="Things the owner may need to follow up on quickly.">
                      {data.lowStock.length === 0 ? (
                        <p className="text-sm font-medium text-green-600">All tracked ingredients are above reorder level.</p>
                      ) : (
                        <div className="space-y-3">
                          {data.lowStock.slice(0, 5).map((item) => (
                            <div key={item.name} className="flex items-start gap-3 rounded-2xl border border-red-100 bg-red-50 px-3 py-3">
                              <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-red-500" />
                              <div>
                                <p className="text-sm font-semibold text-gray-900">{item.name}</p>
                                <p className="text-xs text-red-600">
                                  {item.quantity} {item.unit} left · reorder at {item.reorderLevel}
                                </p>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </SectionCard>
                  </div>
                </div>
              ) : null}

              {view === 'history' ? (
                <div className="grid grid-cols-1 gap-5 xl:grid-cols-[0.95fr_1.05fr]">
                  <SectionCard title="Daily history" sub="Select any dates above to see what each day made and spent.">
                    {data.dailyHistory.length === 0 ? (
                      <p className="text-sm text-gray-400">No daily history for this range yet.</p>
                    ) : (
                      <div className="space-y-3">
                        {data.dailyHistory.map((day) => (
                          <div key={day.date} className="rounded-2xl border border-gray-100 bg-gray-50 px-4 py-3">
                            <div className="flex items-start justify-between gap-3">
                              <div>
                                <p className="text-sm font-bold text-gray-900">{day.label}</p>
                                <p className="text-xs text-gray-500">{day.date}</p>
                              </div>
                              <p className={`text-sm font-bold ${day.profit >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                {formatCurrency(day.profit)}
                              </p>
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

                  <SectionCard title="History summary" sub="The owner only needs trends that are easy to read.">
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <div className="rounded-2xl border border-gray-100 bg-gray-50 p-4">
                        <div className="flex items-center gap-2 text-gray-500">
                          <CalendarRange className="h-4 w-4" />
                          <p className="text-xs font-semibold uppercase tracking-wide">Date range</p>
                        </div>
                        <p className="mt-2 text-sm font-semibold text-gray-900">{data.rangeLabel}</p>
                        <p className="mt-1 text-xs text-gray-500">From {data.from} to {data.to}</p>
                      </div>
                      <div className="rounded-2xl border border-gray-100 bg-gray-50 p-4">
                        <div className="flex items-center gap-2 text-gray-500">
                          <Clock3 className="h-4 w-4" />
                          <p className="text-xs font-semibold uppercase tracking-wide">Last activity</p>
                        </div>
                        <p className="mt-2 text-sm font-semibold text-gray-900">{formatCompactDate(status.lastActivityAt)}</p>
                        <p className="mt-1 text-xs text-gray-500">Useful when the owner is not on the restaurant LAN.</p>
                      </div>
                    </div>

                    <div className="mt-4 rounded-2xl border border-gray-100 bg-white p-4">
                      <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">What this solves</p>
                      <div className="mt-3 space-y-2 text-sm text-gray-600">
                        <p>Revenue answers “how much came in?”</p>
                        <p>Expenses answers “how much went out or was consumed?”</p>
                        <p>Profit / loss answers “did the branch actually make money?”</p>
                      </div>
                    </div>
                  </SectionCard>
                </div>
              ) : null}

              {view === 'reports' ? (
                <div className="grid grid-cols-1 gap-5 xl:grid-cols-[0.9fr_1.1fr]">
                  <SectionCard title="Financial reports" sub="Owner-facing numbers: food, labor, waste, and overall operating pressure.">
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <div className="rounded-2xl bg-orange-50 p-4">
                        <div className="flex items-center gap-2 text-orange-600">
                          <ChefHat className="h-4 w-4" />
                          <p className="text-xs font-semibold uppercase tracking-wide">Food cost</p>
                        </div>
                        <p className="mt-2 text-xl font-bold text-gray-900">{costBreakdown.foodCostPct}%</p>
                        <p className="mt-1 text-xs text-gray-500">{formatCurrency(costBreakdown.cogs)}</p>
                      </div>
                      <div className="rounded-2xl bg-blue-50 p-4">
                        <div className="flex items-center gap-2 text-blue-600">
                          <Wallet className="h-4 w-4" />
                          <p className="text-xs font-semibold uppercase tracking-wide">Labor cost</p>
                        </div>
                        <p className="mt-2 text-xl font-bold text-gray-900">{costBreakdown.laborPct}%</p>
                        <p className="mt-1 text-xs text-gray-500">{formatCurrency(costBreakdown.laborCost)}</p>
                      </div>
                      <div className="rounded-2xl bg-red-50 p-4">
                        <div className="flex items-center gap-2 text-red-600">
                          <AlertTriangle className="h-4 w-4" />
                          <p className="text-xs font-semibold uppercase tracking-wide">Waste</p>
                        </div>
                        <p className="mt-2 text-xl font-bold text-gray-900">{costBreakdown.wastePct}%</p>
                        <p className="mt-1 text-xs text-gray-500">{formatCurrency(costBreakdown.wasteCost)}</p>
                      </div>
                      <div className="rounded-2xl bg-gray-100 p-4">
                        <div className="flex items-center gap-2 text-gray-600">
                          <BarChart3 className="h-4 w-4" />
                          <p className="text-xs font-semibold uppercase tracking-wide">Prime cost</p>
                        </div>
                        <p className="mt-2 text-xl font-bold text-gray-900">{costBreakdown.primeCostPct}%</p>
                        <p className="mt-1 text-xs text-gray-500">{formatCurrency(costBreakdown.primeCost)}</p>
                      </div>
                    </div>

                    <div className="mt-4 rounded-2xl border border-gray-100 bg-gray-50 p-4">
                      <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Recorded expense entries</p>
                      <p className="mt-2 text-lg font-bold text-gray-900">{formatCurrency(costBreakdown.recordedExpenses)}</p>
                      <p className="mt-1 text-xs text-gray-500">These are direct expense transactions entered into the books.</p>
                    </div>
                  </SectionCard>

                  <SectionCard title="Top dishes" sub="Best earners in the selected range.">
                    {data.topDishes.length === 0 ? (
                      <p className="text-sm text-gray-400">No dish sales recorded in this range yet.</p>
                    ) : (
                      <div className="space-y-3">
                        {data.topDishes.map((dish, index) => (
                          <div key={dish.name} className="flex items-center justify-between gap-3 rounded-2xl border border-gray-100 bg-gray-50 px-4 py-3">
                            <div className="min-w-0">
                              <p className="text-sm font-semibold text-gray-900">#{index + 1} {dish.name}</p>
                              <p className="mt-1 text-xs text-gray-500">{dish.qty} sold</p>
                            </div>
                            <p className="text-sm font-bold text-gray-900">{formatCurrency(dish.revenue)}</p>
                          </div>
                        ))}
                      </div>
                    )}
                  </SectionCard>
                </div>
              ) : null}

              {view === 'inventory' ? (
                <div className="grid grid-cols-1 gap-5 xl:grid-cols-[0.9fr_1.1fr]">
                  <SectionCard title="Inventory movement" sub="Owner view of stock flowing through the business.">
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <div className="rounded-2xl bg-orange-50 p-4">
                        <p className="text-xs font-semibold uppercase tracking-wide text-orange-600">Purchased value</p>
                        <p className="mt-2 text-xl font-bold text-gray-900">{formatCurrency(data.inventory.purchaseCost)}</p>
                      </div>
                      <div className="rounded-2xl bg-red-50 p-4">
                        <p className="text-xs font-semibold uppercase tracking-wide text-red-600">Used value</p>
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

                  <SectionCard title="Inventory watchlist" sub="Useful for remote owner checks without walking into the store.">
                    {data.inventory.items.length === 0 ? (
                      <p className="text-sm text-gray-400">No inventory movement recorded in this range yet.</p>
                    ) : (
                      <div className="space-y-3">
                        {data.inventory.items.map((item) => (
                          <div key={item.name} className={`rounded-2xl border px-4 py-3 ${item.isLow ? 'border-red-200 bg-red-50' : 'border-gray-100 bg-gray-50'}`}>
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                  <Package className="h-4 w-4 text-gray-500" />
                                  <p className="truncate text-sm font-semibold text-gray-900">{item.name}</p>
                                </div>
                                <p className="mt-1 text-xs text-gray-500">
                                  Remaining: {item.remainingQty} {item.unit} · Used: {item.usedQty} {item.unit}
                                </p>
                              </div>
                              {item.isLow ? (
                                <span className="rounded-full bg-white px-2 py-1 text-xs font-semibold text-red-600">Low</span>
                              ) : null}
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
      </div>
    </div>
  )
}
