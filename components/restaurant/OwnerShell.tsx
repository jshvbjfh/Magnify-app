'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Bell,
  CalendarDays,
  ChefHat,
  Clock3,
  Crown,
  DollarSign,
  FileText,
  Home,
  LogOut,
  Menu,
  Package,
  RefreshCw,
  ReceiptText,
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
  selectedBranchId?: string
  branches?: { id: string; name: string; code: string; isMain: boolean }[]
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
    orderCount?: number
    clientCount?: number
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
    sourceKind?: string | null
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
    orderCount?: number
    clientCount?: number
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

const EMPTY_SUMMARY: DashboardData['summary'] = {
  revenue: 0,
  expenses: 0,
  profit: 0,
  salesCount: 0,
  transactionCount: 0,
  activeOrders: 0,
  orderCount: 0,
  clientCount: 0,
}

const EMPTY_COST_BREAKDOWN: DashboardData['costBreakdown'] = {
  cogs: 0,
  foodCostPct: 0,
  laborCost: 0,
  laborPct: 0,
  wasteCost: 0,
  wastePct: 0,
  recordedExpenses: 0,
  primeCost: 0,
  primeCostPct: 0,
}

const EMPTY_STATUS: DashboardData['status'] = {
  level: 'stale',
  label: 'Quiet',
  detail: 'No synced branch activity yet.',
  lastActivityAt: null,
  activeOrders: 0,
}

const EMPTY_INVENTORY: DashboardData['inventory'] = {
  purchaseCost: 0,
  usedCost: 0,
  stockValue: 0,
  lowStockCount: 0,
  items: [],
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function asString(value: unknown, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

function normalizeStatusLevel(value: unknown): DashboardData['status']['level'] {
  return value === 'live' || value === 'recent' || value === 'stale' ? value : 'stale'
}

function normalizeDashboardData(payload: unknown, fallbackDate: string): DashboardData | null {
  if (!isRecord(payload)) return null

  const rawSummary = isRecord(payload.summary) ? payload.summary : null
  const rawCostBreakdown = isRecord(payload.costBreakdown) ? payload.costBreakdown : null
  const rawStatus = isRecord(payload.status) ? payload.status : null
  const rawInventory = isRecord(payload.inventory) ? payload.inventory : null
  const rawSync = isRecord(payload.sync) ? payload.sync : null

  return {
    restaurantName: asString(payload.restaurantName, 'Owner workspace'),
    selectedRestaurantId: asString(payload.selectedRestaurantId),
    restaurants: Array.isArray(payload.restaurants) ? payload.restaurants as DashboardData['restaurants'] : [],
    selectedBranchId: typeof payload.selectedBranchId === 'string' && payload.selectedBranchId ? payload.selectedBranchId : undefined,
    branches: Array.isArray(payload.branches) ? payload.branches as NonNullable<DashboardData['branches']> : [],
    period: payload.period === 'today' || payload.period === 'week' || payload.period === 'month' || payload.period === 'custom'
      ? payload.period
      : 'today',
    rangeLabel: asString(payload.rangeLabel, 'Today'),
    from: asString(payload.from, fallbackDate),
    to: asString(payload.to, fallbackDate),
    sync: {
      source: rawSync?.source === 'live' || rawSync?.source === 'snapshot' || rawSync?.source === 'minimal'
        ? rawSync.source
        : 'minimal',
      generatedAt: asString(rawSync?.generatedAt, new Date().toISOString()),
    },
    summary: {
      revenue: asNumber(rawSummary?.revenue),
      expenses: asNumber(rawSummary?.expenses),
      profit: asNumber(rawSummary?.profit),
      salesCount: asNumber(rawSummary?.salesCount),
      transactionCount: asNumber(rawSummary?.transactionCount),
      activeOrders: asNumber(rawSummary?.activeOrders),
      orderCount: asNumber(rawSummary?.orderCount),
      clientCount: asNumber(rawSummary?.clientCount),
    },
    costBreakdown: {
      cogs: asNumber(rawCostBreakdown?.cogs),
      foodCostPct: asNumber(rawCostBreakdown?.foodCostPct),
      laborCost: asNumber(rawCostBreakdown?.laborCost),
      laborPct: asNumber(rawCostBreakdown?.laborPct),
      wasteCost: asNumber(rawCostBreakdown?.wasteCost),
      wastePct: asNumber(rawCostBreakdown?.wastePct),
      recordedExpenses: asNumber(rawCostBreakdown?.recordedExpenses),
      primeCost: asNumber(rawCostBreakdown?.primeCost),
      primeCostPct: asNumber(rawCostBreakdown?.primeCostPct),
    },
    status: {
      level: normalizeStatusLevel(rawStatus?.level),
      label: asString(rawStatus?.label, EMPTY_STATUS.label),
      detail: asString(rawStatus?.detail, EMPTY_STATUS.detail),
      lastActivityAt: typeof rawStatus?.lastActivityAt === 'string' ? rawStatus.lastActivityAt : null,
      activeOrders: asNumber(rawStatus?.activeOrders),
    },
    transactions: Array.isArray(payload.transactions) ? payload.transactions as DashboardData['transactions'] : [],
    dailyHistory: Array.isArray(payload.dailyHistory) ? payload.dailyHistory as DashboardData['dailyHistory'] : [],
    topDishes: Array.isArray(payload.topDishes) ? payload.topDishes as DashboardData['topDishes'] : [],
    lowStock: Array.isArray(payload.lowStock) ? payload.lowStock as DashboardData['lowStock'] : [],
    inventory: {
      purchaseCost: asNumber(rawInventory?.purchaseCost),
      usedCost: asNumber(rawInventory?.usedCost),
      stockValue: asNumber(rawInventory?.stockValue),
      lowStockCount: asNumber(rawInventory?.lowStockCount),
      items: Array.isArray(rawInventory?.items) ? rawInventory.items as DashboardData['inventory']['items'] : [],
    },
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

function isWasteLikeTransaction(entry: { sourceKind?: string | null; description: string }) {
  const normalizedSourceKind = String(entry.sourceKind || '').trim().toLowerCase()
  if (normalizedSourceKind === 'inventory_waste') return true
  return entry.description.trim().toLowerCase().startsWith('waste:')
}

function toDateKey(value: Date) {
  const year = value.getFullYear()
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const day = String(value.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function buildRecentDateKeys(days: number, endDateKey: string) {
  const end = new Date(`${endDateKey}T12:00:00`)
  const keys: string[] = []

  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const current = new Date(end)
    current.setDate(end.getDate() - offset)
    keys.push(toDateKey(current))
  }

  return keys
}

function getLatestActiveHomeDate(days: DashboardData['dailyHistory'], fallbackDate: string) {
  const activeDay = [...days].reverse().find((day) => {
    const orderCount = day.orderCount ?? 0
    const clientCount = day.clientCount ?? 0
    return day.revenue !== 0 || day.expenses !== 0 || day.profit !== 0 || orderCount > 0 || clientCount > 0
  })

  return activeDay?.date ?? fallbackDate
}

function formatDateCardParts(dateKey: string) {
  const value = new Date(`${dateKey}T12:00:00`)
  return {
    weekday: value.toLocaleDateString('en-RW', { weekday: 'short' }),
    month: value.toLocaleDateString('en-RW', { month: 'short' }),
    day: value.getDate(),
  }
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

function getChange(current: number, previous?: number) {
  if (previous === undefined) return null
  if (previous === 0) return current === 0 ? 0 : 100
  return ((current - previous) / Math.abs(previous)) * 100
}

function formatChange(delta: number | null) {
  if (delta === null || !Number.isFinite(delta)) return null
  const abs = Math.abs(delta)
  const digits = abs >= 10 ? 0 : 1
  return `${delta > 0 ? '+' : delta < 0 ? '-' : ''}${abs.toFixed(digits)}%`
}

function getChangeTone(delta: number | null, inverse = false) {
  if (delta === null) return 'bg-gray-100 text-gray-500'
  const good = inverse ? delta <= 0 : delta >= 0
  return good ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-600'
}

function HomeOverviewCard({
  label,
  value,
  icon,
  chip,
  chipTone,
  valueTone = 'text-slate-900',
}: {
  label: string
  value: string
  icon: React.ReactNode
  chip?: string | null
  chipTone?: string
  valueTone?: string
}) {
  return (
    <article className="rounded-[26px] border border-slate-200/80 bg-white px-4 py-4 shadow-[0_10px_28px_rgba(15,23,42,0.08)] sm:px-5 sm:py-5">
      <div className="flex items-start justify-between gap-3">
        <div className="rounded-2xl bg-orange-50 p-3 text-orange-500">
          {icon}
        </div>
        {chip ? (
          <span className={`rounded-full px-3 py-1 text-xs font-semibold ${chipTone ?? 'bg-green-100 text-green-700'}`}>
            {chip}
          </span>
        ) : null}
      </div>
      <p className="mt-4 text-[15px] font-semibold text-slate-500">{label}</p>
      <p className={`mt-2 text-[2rem] font-semibold leading-none tracking-[-0.03em] ${valueTone}`}>{value}</p>
    </article>
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
  const homeHistoryStart = new Date(new Date(`${today}T12:00:00`).getTime() - (27 * 86400000)).toISOString().slice(0, 10)
  const detailHistoryStart = '2000-01-01'
  const [view, setView] = useState<OwnerView>('home')
  const [filters, setFilters] = useState<FilterState>({ mode: 'preset', period: 'today', from: today, to: today })
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastRefresh, setLastRefresh] = useState<string | null>(null)
  const [selectedBranchId, setSelectedBranchId] = useState<string>('')
  const [branchSwitchingId, setBranchSwitchingId] = useState<string | null>(null)
  const [selectedHomeDate, setSelectedHomeDate] = useState<string>(today)
  const [selectedDetailsDate, setSelectedDetailsDate] = useState<string>(today)

  const load = useCallback(async (currentFilters: FilterState, currentBranchId?: string, currentView?: OwnerView) => {
    setLoading(true)
    setError(null)

    try {
      const params = new URLSearchParams()
      if (currentView === 'home') {
        params.set('from', homeHistoryStart)
        params.set('to', today)
      } else if (currentView === 'details') {
        params.set('from', detailHistoryStart)
        params.set('to', today)
        params.set('transactionHistory', 'full')
      } else {
        if (currentFilters.mode === 'custom') {
          params.set('from', currentFilters.from)
          params.set('to', currentFilters.to)
        } else {
          params.set('period', currentFilters.period)
        }
      }

      if (currentBranchId) {
        params.set('branchId', currentBranchId)
      }

      const res = await fetch(`/api/owner/dashboard?${params.toString()}`, { credentials: 'include' })
      if (!res.ok) {
        setError('Failed to load owner dashboard data.')
        return
      }

      const json = await res.json()
      const normalized = normalizeDashboardData(json, today)
      if (!normalized) {
        setError('Failed to load owner dashboard data.')
        return
      }

      setData(normalized)
      if (normalized.selectedBranchId) {
        setSelectedBranchId(normalized.selectedBranchId)
      }
      if (currentView === 'home') {
        const allowedDates = new Set(buildRecentDateKeys(28, today))
        const latestActiveDate = getLatestActiveHomeDate(normalized.dailyHistory, today)
        setSelectedHomeDate((current) => {
          if (allowedDates.has(current) && current !== today) return current
          return latestActiveDate
        })
      }
      setLastRefresh(new Date().toISOString())
    } catch {
      setError('Network error. Check your connection and try again.')
    } finally {
      setLoading(false)
    }
  }, [detailHistoryStart, homeHistoryStart, today])

  useEffect(() => {
    void load(filters, selectedBranchId, view)
  }, [filters, load, view])

  useEffect(() => {
    const timer = setInterval(() => {
      void load(filters, selectedBranchId, view)
    }, 30000)
    return () => clearInterval(timer)
  }, [filters, load, selectedBranchId, view])

  useEffect(() => {
    if (view !== 'details') return

    setSelectedDetailsDate((current) => current || today)
  }, [data, today, view])

  const applyPreset = (period: Period) => {
    setFilters((current) => ({ ...current, mode: 'preset', period }))
  }

  const handleBranchSelect = async (branchId: string) => {
    if (!branchId || branchId === selectedBranchId || branchSwitchingId) return

    setBranchSwitchingId(branchId)
    setError(null)

    try {
      const response = await fetch('/api/restaurant/branches', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ branchId }),
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok) {
        throw new Error(payload?.error || 'Failed to switch branch')
      }

      const nextBranchId = typeof payload?.activeBranchId === 'string' ? payload.activeBranchId : branchId
      await load(filters, nextBranchId, view)
    } catch (switchError) {
      setError(switchError instanceof Error ? switchError.message : 'Failed to switch branch')
    } finally {
      setBranchSwitchingId(null)
    }
  }

  const openHome = () => {
    setView('home')
    setFilters({ mode: 'preset', period: 'today', from: today, to: today })
    setSelectedHomeDate(today)
  }

  const summary = data?.summary ?? EMPTY_SUMMARY
  const status = data?.status ?? EMPTY_STATUS
  const costBreakdown = data?.costBreakdown ?? EMPTY_COST_BREAKDOWN
  const isHomeView = view === 'home'
  const fullDailyHistory = data?.dailyHistory ?? []
  const homeHistoryDates = Array.from(new Set([...buildRecentDateKeys(28, today), selectedHomeDate])).sort((a, b) => a.localeCompare(b))
  const homeHistory = homeHistoryDates.map((date) => {
    const existing = fullDailyHistory.find((day) => day.date === date)
    return existing ?? {
      date,
      label: new Intl.DateTimeFormat('en-RW', { month: 'short', day: 'numeric' }).format(new Date(`${date}T12:00:00`)),
      revenue: 0,
      expenses: 0,
      profit: 0,
      orderCount: 0,
      clientCount: 0,
    }
  })
  const homeHistoryCards = [...homeHistory].reverse()
  const selectedDay = homeHistory.find((day) => day.date === selectedHomeDate) ?? homeHistory[homeHistory.length - 1]
  const selectedDayIndex = selectedDay ? homeHistory.findIndex((day) => day.date === selectedDay.date) : -1
  const previousDay = selectedDayIndex > 0 ? homeHistory[selectedDayIndex - 1] : null
  const homeSummary = selectedDay ? {
    revenue: selectedDay.revenue,
    expenses: selectedDay.expenses,
    profit: selectedDay.profit,
  } : summary
  const homeOrderCount = selectedDay?.orderCount ?? summary?.orderCount ?? 0
  const profitSignal = homeSummary ? getProfitSignal(homeSummary.profit) : null
  const cashFlowTotal = homeSummary ? Math.max(homeSummary.revenue + homeSummary.expenses, 1) : 1
  const revenueShare = homeSummary ? Math.max((homeSummary.revenue / cashFlowTotal) * 100, homeSummary.revenue > 0 ? 12 : 0) : 0
  const expenseShare = homeSummary ? Math.max((homeSummary.expenses / cashFlowTotal) * 100, homeSummary.expenses > 0 ? 12 : 0) : 0
  const revenueChange = homeSummary ? getChange(homeSummary.revenue, previousDay?.revenue) : null
  const profitChange = homeSummary ? getChange(homeSummary.profit, previousDay?.profit) : null
  const expenseChange = homeSummary ? getChange(homeSummary.expenses, previousDay?.expenses) : null
  const orderChange = getChange(homeOrderCount, previousDay?.orderCount)
  const homeSectionTitle = selectedDay?.date === today ? "TODAY'S OVERVIEW" : `${(selectedDay?.label ?? 'Selected Day').toUpperCase()} OVERVIEW`
  const detailEntriesPerDate = (data?.transactions ?? []).reduce<Record<string, number>>((acc, txn) => {
    const date = txn.date.slice(0, 10)
    acc[date] = (acc[date] ?? 0) + 1
    return acc
  }, {})
  const detailDates = Array.from(new Set([selectedDetailsDate, ...Object.keys(detailEntriesPerDate)])).sort((a, b) => a.localeCompare(b))
  const detailTransactions = (data?.transactions ?? []).filter((txn) => txn.date.slice(0, 10) === selectedDetailsDate)
  const detailDateLabel = selectedDetailsDate === today
    ? 'Today'
    : new Intl.DateTimeFormat('en-RW', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(`${selectedDetailsDate}T12:00:00`))
  const ownerBranches = data?.branches ?? []

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="mx-auto flex min-h-screen w-full max-w-6xl flex-col">

        {/* â”€â”€ Header â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
        <>
          <header className="sticky top-0 z-20 bg-[#ff6a36] px-4 py-4 text-white shadow-[0_8px_18px_rgba(255,106,54,0.28)] sm:px-6">
            <div className="grid grid-cols-[40px_1fr_40px] items-center gap-2">
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10">
                <Menu className="h-5 w-5" />
              </span>
              <div className="text-center">
                <p className="text-xl font-bold tracking-[-0.03em]">Magnify</p>
              </div>
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10">
                <Bell className="h-5 w-5" />
              </span>
            </div>
          </header>

          <div className="border-b border-slate-200 bg-white px-4 py-3 shadow-sm sm:px-6">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="truncate text-xl font-semibold tracking-[-0.03em] text-slate-900">{data?.restaurantName ?? 'Owner workspace'}</h1>
                  {data && status.level !== 'stale' ? (
                    <span className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${getStatusClasses(status.level)}`}>
                      {status.label}
                    </span>
                  ) : null}
                  {status?.activeOrders ? (
                    <span className="rounded-full bg-orange-50 px-2.5 py-1 text-[11px] font-semibold text-orange-600">
                      {status.activeOrders} active
                    </span>
                  ) : null}
                </div>
                <p className="mt-1 text-xs text-slate-400">
                  {lastRefresh ? `Updated ${formatCompactDate(lastRefresh)}` : 'Loading...'}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => void load(filters, selectedBranchId, view)}
                  className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 text-slate-500 transition-colors hover:bg-slate-200"
                  aria-label="Refresh owner view"
                >
                  <RefreshCw className="h-4 w-4" />
                </button>
                <button
                  onClick={() => signOut({ callbackUrl: '/login' })}
                  className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 text-slate-500 transition-colors hover:bg-red-50 hover:text-red-600"
                  aria-label="Sign out"
                >
                  <LogOut className="h-4 w-4" />
                </button>
              </div>
            </div>
            {ownerBranches.length > 0 ? (
              <div className="mt-3 flex items-center gap-2 overflow-x-auto pb-1">
                <span className="whitespace-nowrap text-[10px] font-bold uppercase tracking-[0.22em] text-slate-400">Branches</span>
                {ownerBranches.map((branch) => {
                  const isActive = selectedBranchId === branch.id
                  const isSwitching = branchSwitchingId === branch.id
                  return (
                    <button
                      key={branch.id}
                      type="button"
                      onClick={() => void handleBranchSelect(branch.id)}
                      disabled={isActive || isSwitching}
                      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-70 ${isActive ? 'border-orange-500 bg-orange-50 text-orange-700' : 'border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100'}`}
                    >
                      <span>{branch.name}</span>
                      {branch.isMain ? <span className="rounded-full bg-white px-1.5 py-0.5 text-[10px]">Main</span> : <span className="text-[10px] uppercase text-slate-400">{branch.code}</span>}
                      {isSwitching ? <RefreshCw className="h-3 w-3 animate-spin" /> : null}
                    </button>
                  )
                })}
              </div>
            ) : null}

            {!isHomeView && view !== 'details' ? (
              <div className="mt-3 flex items-center gap-2 overflow-x-auto pb-1">
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
              </div>
            ) : null}
          </div>
        </>

        {/* â”€â”€ Main content â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
        <main className={`flex-1 ${isHomeView ? 'px-4 py-5 pb-28 sm:px-6' : 'px-4 py-4 pb-24 sm:px-6 sm:py-6'}`}>
          {error ? (
            <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
          ) : null}

          {loading && !data ? (
            <div className="flex items-center justify-center py-24 text-gray-400">
              <div className="mr-3 h-8 w-8 animate-spin rounded-full border-4 border-orange-200 border-t-orange-500" />
              Loadingâ€¦
            </div>
          ) : null}

          {data ? (
            <div className="space-y-5 sm:space-y-6">

              {isHomeView ? (
                <div className="mx-auto w-full max-w-2xl space-y-5">
                  <section className="rounded-[28px] border border-slate-200/80 bg-white px-4 py-4 shadow-[0_10px_30px_rgba(15,23,42,0.06)]">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-[11px] font-bold uppercase tracking-[0.24em] text-slate-400">Last 4 weeks</p>
                      </div>
                      <label className="relative inline-flex h-10 items-center gap-2 rounded-full bg-slate-100 px-3 text-xs font-semibold text-slate-500">
                        <CalendarDays className="h-4 w-4" />
                        Pick date
                        <input
                          type="date"
                          value={selectedHomeDate}
                          max={today}
                          onChange={(e) => setSelectedHomeDate(e.target.value)}
                          className="absolute inset-0 opacity-0"
                        />
                      </label>
                    </div>
                    <div className="mt-4 flex gap-2 overflow-x-auto pb-1">
                      {homeHistoryCards.length === 0 ? (
                        <p className="text-sm text-slate-400">No daily activity yet.</p>
                      ) : homeHistoryCards.map((day) => {
                        const selected = selectedDay?.date === day.date
                        const parts = formatDateCardParts(day.date)
                        return (
                          <button
                            key={day.date}
                            onClick={() => setSelectedHomeDate(day.date)}
                            className={`min-w-[66px] rounded-[18px] px-3 py-2 text-center transition-all ${selected ? 'bg-[#ff6a36] text-white shadow-[0_10px_24px_rgba(255,106,54,0.28)]' : 'bg-slate-50 text-slate-500 hover:bg-slate-100'}`}
                          >
                            <p className={`text-[11px] font-semibold uppercase ${selected ? 'text-white/80' : 'text-slate-400'}`}>{parts.month}</p>
                            <p className="mt-1 text-xl font-semibold leading-none tracking-[-0.05em]">{parts.day}</p>
                            <p className={`mt-1 text-[11px] font-medium ${selected ? 'text-white/80' : 'text-slate-400'}`}>{parts.weekday}</p>
                          </button>
                        )
                      })}
                    </div>
                  </section>

                  <section className="space-y-4">
                    <div className="px-1">
                      <p className="text-sm font-bold tracking-wide text-slate-500">{homeSectionTitle}</p>
                    </div>

                    <HomeOverviewCard
                      label="Revenue"
                      value={formatCurrency(homeSummary?.revenue ?? 0)}
                      icon={<DollarSign className="h-5 w-5" />}
                      chip={formatChange(revenueChange)}
                      chipTone={getChangeTone(revenueChange)}
                    />

                    <HomeOverviewCard
                      label="Profit / Loss"
                      value={formatCurrency(homeSummary?.profit ?? 0)}
                      icon={<TrendingUp className="h-5 w-5" />}
                      chip={formatChange(profitChange)}
                      chipTone={getChangeTone(profitChange)}
                      valueTone={homeSummary && homeSummary.profit < 0 ? 'text-red-600' : 'text-slate-900'}
                    />

                    <HomeOverviewCard
                      label="Expenses"
                      value={formatCurrency(homeSummary?.expenses ?? 0)}
                      icon={<Wallet className="h-5 w-5" />}
                      chip={formatChange(expenseChange)}
                      chipTone={getChangeTone(expenseChange, true)}
                    />

                    <HomeOverviewCard
                      label="Orders"
                      value={homeOrderCount.toLocaleString('en-RW')}
                      icon={<ReceiptText className="h-5 w-5" />}
                      chip={formatChange(orderChange)}
                      chipTone={getChangeTone(orderChange)}
                    />

                    {profitSignal && homeSummary ? (
                      <section className={`rounded-[26px] border p-5 shadow-[0_10px_28px_rgba(15,23,42,0.06)] ${profitSignal.hero}`}>
                        <div className="flex items-center justify-between gap-3">
                          <p className={`text-[11px] font-bold uppercase tracking-[0.22em] ${profitSignal.text}`}>
                            {selectedDay?.date === today ? 'Today' : selectedDay?.label ?? 'Selected day'}
                          </p>
                          <span className={`rounded-full px-3 py-1 text-xs font-semibold ${profitSignal.pill}`}>
                            {profitSignal.label}
                          </span>
                        </div>
                        <div className="mt-4 h-3 overflow-hidden rounded-full bg-white/80">
                          <div className="flex h-full">
                            <div className="bg-emerald-500 transition-all" style={{ width: `${revenueShare}%` }} />
                            <div className="bg-rose-400 transition-all" style={{ width: `${expenseShare}%` }} />
                          </div>
                        </div>
                        <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                          <div className="rounded-2xl bg-white/80 px-4 py-3">
                            <p className="font-medium text-slate-500">Cash in</p>
                            <p className="mt-1 text-lg font-semibold text-slate-900">{formatCurrency(homeSummary.revenue)}</p>
                          </div>
                          <div className="rounded-2xl bg-white/80 px-4 py-3">
                            <p className="font-medium text-slate-500">Cash out</p>
                            <p className="mt-1 text-lg font-semibold text-slate-900">{formatCurrency(homeSummary.expenses)}</p>
                          </div>
                        </div>
                      </section>
                    ) : null}
                  </section>
                </div>
              ) : view !== 'details' ? (
                <>
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
                </>
              ) : null}

              {/* â”€â”€ DETAILS view â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
              {view === 'details' ? (
                <>
                  <div className="space-y-5">
                    <section className="rounded-[28px] border border-slate-200/80 bg-white px-4 py-4 shadow-[0_10px_30px_rgba(15,23,42,0.06)]">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="text-[11px] font-bold uppercase tracking-[0.24em] text-slate-400">Transactions</p>
                        </div>
                        <label className="relative inline-flex h-10 items-center gap-2 rounded-full bg-slate-100 px-3 text-xs font-semibold text-slate-500">
                          <CalendarDays className="h-4 w-4" />
                          Pick date
                          <input
                            type="date"
                            value={selectedDetailsDate}
                            max={today}
                            onChange={(e) => setSelectedDetailsDate(e.target.value)}
                            className="absolute inset-0 opacity-0"
                          />
                        </label>
                      </div>
                      <div className="mt-4 flex gap-2 overflow-x-auto pb-1">
                        {detailDates.length === 0 ? (
                          <p className="text-sm text-slate-400">No transaction history yet.</p>
                        ) : detailDates.map((date) => {
                          const selected = selectedDetailsDate === date
                          const parts = formatDateCardParts(date)
                          return (
                            <button
                              key={date}
                              onClick={() => setSelectedDetailsDate(date)}
                              className={`min-w-[66px] rounded-[18px] px-3 py-2 text-center transition-all ${selected ? 'bg-[#ff6a36] text-white shadow-[0_10px_24px_rgba(255,106,54,0.28)]' : 'bg-slate-50 text-slate-500 hover:bg-slate-100'}`}
                            >
                              <p className={`text-[11px] font-semibold uppercase ${selected ? 'text-white/80' : 'text-slate-400'}`}>{parts.month}</p>
                              <p className="mt-1 text-xl font-semibold leading-none tracking-[-0.05em]">{parts.day}</p>
                              <p className={`mt-1 text-[11px] font-medium ${selected ? 'text-white/80' : 'text-slate-400'}`}>{parts.weekday}</p>
                            </button>
                          )
                        })}
                      </div>
                    </section>

                    <SectionCard title="Transaction journal" sub={`${detailDateLabel} transactions only.`}>
                      {detailTransactions.length === 0 ? (
                        <div className="rounded-[24px] border border-dashed border-slate-200 bg-slate-50 px-4 py-10 text-center">
                          <p className="text-sm font-semibold text-slate-500">No transactions found</p>
                          <p className="mt-1 text-xs text-slate-400">No entries were recorded for the selected day.</p>
                        </div>
                      ) : (
                        <div className="space-y-3">
                          {detailTransactions.map((txn) => {
                            const isInventoryLoss = isWasteLikeTransaction(txn)
                            const isRevenue = txn.categoryType === 'income'
                            const isExpense = txn.categoryType === 'expense' && !isInventoryLoss
                            const amountClass = isInventoryLoss
                              ? 'text-amber-600'
                              : isExpense
                                ? 'text-red-600'
                                : isRevenue
                                  ? 'text-emerald-600'
                                  : 'text-slate-600'
                            const amountPrefix = isRevenue ? '+' : isExpense ? '-' : ''
                            const originLabel = isInventoryLoss ? 'Excluded from profit' : txn.isManual ? 'Manual' : 'Recorded'
                            return (
                              <article key={txn.id} className="rounded-[24px] border border-slate-200 bg-slate-50/80 px-4 py-4 shadow-[0_8px_24px_rgba(15,23,42,0.04)]">
                                <div className="flex items-start justify-between gap-3">
                                  <div className="min-w-0">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                                        isInventoryLoss
                                          ? 'bg-amber-100 text-amber-700'
                                          : isExpense
                                            ? 'bg-red-100 text-red-700'
                                            : isRevenue
                                              ? 'bg-emerald-100 text-emerald-700'
                                              : 'bg-slate-200 text-slate-700'
                                      }`}>
                                        {isInventoryLoss ? 'Inventory Loss' : isExpense ? 'Expense' : isRevenue ? 'Revenue' : 'Entry'}
                                      </span>
                                      <span className="rounded-full bg-white px-2.5 py-1 text-[11px] font-medium text-slate-500">{txn.paymentMethod}</span>
                                    </div>
                                    <p className="mt-3 text-base font-semibold text-slate-900">{txn.description}</p>
                                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                                      <span>{new Date(txn.date).toLocaleString('en-RW', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                                      <span className="rounded-full bg-white px-2 py-0.5">{txn.accountName}</span>
                                      <span className="rounded-full bg-white px-2 py-0.5 capitalize">{txn.categoryName}</span>
                                    </div>
                                  </div>
                                  <div className="text-right">
                                    <p className={`text-lg font-semibold ${amountClass}`}>
                                      {amountPrefix}{formatCurrency(txn.amount)}
                                    </p>
                                    <p className="mt-1 text-[11px] font-medium text-slate-400">{originLabel}</p>
                                  </div>
                                </div>
                              </article>
                            )
                          })}
                        </div>
                      )}
                    </SectionCard>
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
