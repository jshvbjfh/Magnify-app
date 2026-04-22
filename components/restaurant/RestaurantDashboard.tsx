'use client'

import { useState, useEffect, useCallback } from 'react'
import { useSession } from 'next-auth/react'
import { TrendingUp, Users, ShoppingBag, DollarSign, AlertTriangle, CheckCircle2, RefreshCw, Flame, Sparkles, CalendarRange } from 'lucide-react'
import { useRestaurantBranch } from '@/contexts/RestaurantBranchContext'
import { buildRestaurantSnapshotScope, loadRestaurantDeviceSnapshot, mergeRestaurantDeviceSnapshot } from '@/lib/restaurantDeviceSnapshot'

type DashboardData = {
  period: string; revenue: number; cogs: number; foodCostPct: number
  laborCost: number; laborPct: number; wasteCost: number; wastePct: number
  primeCost: number; primeCostPct: number; salesCount: number
  topDishes: { name: string; revenue: number; orders: number }[]
  lowStockCount: number; alerts: { type: 'warning' | 'danger'; message: string }[]
  from?: string
  to?: string
  rangeLabel?: string
  dailyHistory?: {
    date: string
    revenue: number
    salesCount: number
    cogs: number
    foodCostPct: number
    laborCost: number
    laborPct: number
    wasteCost: number
    wastePct: number
    primeCost: number
    primeCostPct: number
  }[]
}

type RestaurantDashboardSnapshot = {
  updatedAt: string
  data: DashboardData | null
}

function fmt(n: number) { return n.toLocaleString('en-RW', { maximumFractionDigits: 0 }) }

function todayStr() {
  return new Date().toISOString().slice(0, 10)
}

function formatDayChip(date: string) {
  const value = new Date(`${date}T00:00:00`)
  return {
    weekday: value.toLocaleDateString('en-RW', { weekday: 'short' }),
    display: value.toLocaleDateString('en-RW', { month: 'numeric', day: 'numeric', year: 'numeric' }),
  }
}

function PctBadge({ pct, good, warn }: { pct: number; good: number; warn: number }) {
  const c = pct === 0 ? 'text-gray-500' : pct <= good ? 'text-green-600' : pct <= warn ? 'text-amber-600' : 'text-red-600'
  return <span className={`text-lg font-bold ${c}`}>{pct}%</span>
}

export default function RestaurantDashboard({ onAskJesse }: { onAskJesse?: () => void }) {
  const { data: session } = useSession()
  const restaurantBranch = useRestaurantBranch()
  const today = todayStr()
  const [period, setPeriod] = useState<'today' | 'week' | 'month'>('month')
  const [rangeMode, setRangeMode] = useState<'preset' | 'custom'>('preset')
  const [draftFrom, setDraftFrom] = useState(today)
  const [draftTo, setDraftTo] = useState(today)
  const [selectedHistoryDate, setSelectedHistoryDate] = useState<string | null>(null)
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [snapshotUpdatedAt, setSnapshotUpdatedAt] = useState<string | null>(null)
  const [showingCachedSnapshot, setShowingCachedSnapshot] = useState(false)
  const snapshotScopeId = buildRestaurantSnapshotScope({
    restaurantId: restaurantBranch?.restaurantId ?? (session?.user as any)?.restaurantId ?? null,
    branchId: restaurantBranch?.branchId ?? (session?.user as any)?.branchId ?? null,
    fallbackUserId: session?.user?.id ?? null,
  })
  const snapshotStorageScope = snapshotScopeId ? `restaurant-dashboard:${snapshotScopeId}` : null

  const persistSnapshot = useCallback((nextData: DashboardData | null) => {
    if (!snapshotStorageScope) return
    const snapshot = mergeRestaurantDeviceSnapshot<RestaurantDashboardSnapshot>(snapshotStorageScope, { data: nextData })
    if (!snapshot) return
    setSnapshotUpdatedAt(snapshot.updatedAt)
    setShowingCachedSnapshot(false)
  }, [snapshotStorageScope])

  const load = useCallback(async () => {
    setLoading(data === null)
    try {
      const params = new URLSearchParams()
      if (rangeMode === 'custom') {
        params.set('from', draftFrom)
        params.set('to', draftTo)
      } else {
        params.set('period', period)
      }
      const res = await fetch(`/api/restaurant/dashboard?${params.toString()}`)
      if (res.ok) {
        const payload = await res.json()
        setData(payload)
        persistSnapshot(payload)
        const historyDates = Array.isArray(payload.dailyHistory) ? payload.dailyHistory.map((row: { date: string }) => row.date) : []
        setSelectedHistoryDate((current) => {
          if (current && historyDates.includes(current)) {
            return current
          }

          if (payload.from === payload.to) {
            return historyDates[historyDates.length - 1] ?? today
          }

          return null
        })
      }
    } finally { setLoading(false) }
  }, [data, draftFrom, draftTo, period, persistSnapshot, rangeMode, today])

  useEffect(() => {
    if (!snapshotStorageScope) return

    const snapshot = loadRestaurantDeviceSnapshot<RestaurantDashboardSnapshot>(snapshotStorageScope)
    if (!snapshot?.data) return

    setData(snapshot.data)
    setSnapshotUpdatedAt(snapshot.updatedAt ?? null)
    setShowingCachedSnapshot(true)

    const historyDates = Array.isArray(snapshot.data.dailyHistory) ? snapshot.data.dailyHistory.map((row) => row.date) : []
    setSelectedHistoryDate((current) => {
      if (current && historyDates.includes(current)) return current
      if (snapshot.data?.from === snapshot.data?.to) {
        return historyDates[historyDates.length - 1] ?? today
      }
      return null
    })
    setLoading(false)
  }, [snapshotStorageScope, today])

  useEffect(() => { load() }, [load])

  const snapshotUpdatedLabel = snapshotUpdatedAt
    ? new Date(snapshotUpdatedAt).toLocaleString('en-RW', { dateStyle: 'medium', timeStyle: 'short' })
    : null

  const applyPreset = (nextPeriod: 'today' | 'week' | 'month') => {
    setSelectedHistoryDate(nextPeriod === 'today' ? today : null)
    setRangeMode('preset')
    setPeriod(nextPeriod)
  }

  const applyCustomRange = () => {
    if (!draftFrom || !draftTo) return
    if (draftFrom > draftTo) return
    setSelectedHistoryDate(draftFrom === draftTo ? draftTo : null)
    setRangeMode('custom')
  }

  const historyRows = data?.dailyHistory ?? []
  const selectedHistoryRow = selectedHistoryDate
    ? historyRows.find(day => day.date === selectedHistoryDate) ?? null
    : null
  const activeMetrics = selectedHistoryRow ?? {
    revenue: data?.revenue ?? 0,
    salesCount: data?.salesCount ?? 0,
    cogs: data?.cogs ?? 0,
    foodCostPct: data?.foodCostPct ?? 0,
    laborCost: data?.laborCost ?? 0,
    laborPct: data?.laborPct ?? 0,
    wasteCost: data?.wasteCost ?? 0,
    wastePct: data?.wastePct ?? 0,
    primeCost: data?.primeCost ?? 0,
    primeCostPct: data?.primeCostPct ?? 0,
  }

  return (
    <div className="space-y-6">
      {showingCachedSnapshot && snapshotUpdatedLabel ? (
        <div className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
          <p className="font-semibold">Showing last synced dashboard snapshot from this device</p>
          <p className="mt-1 text-xs opacity-90">Last synced snapshot: {snapshotUpdatedLabel}</p>
        </div>
      ) : null}

      {/* Period selector */}
      <div className="space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-lg font-bold text-gray-800">Dashboard</h2>
        <div className="flex items-center gap-2">
          <button onClick={onAskJesse} className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg border border-orange-300 text-orange-600 bg-white hover:bg-orange-50 transition-colors">
            <Sparkles className="h-3.5 w-3.5"/> Ask Jesse AI
          </button>
          {(['today','week','month'] as const).map(p => (
            <button key={p} onClick={() => applyPreset(p)}
              className={`text-xs px-3 py-1.5 rounded-lg font-medium transition-all ${rangeMode === 'preset' && period === p ? 'bg-orange-500 text-white shadow' : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
              {p === 'today' ? 'Today' : p === 'week' ? '7 Days' : 'Month'}
            </button>
          ))}
          <div className={`flex items-center gap-1.5 rounded-lg border px-2 py-1 ${rangeMode === 'custom' ? 'border-orange-300 bg-orange-50' : 'border-gray-200 bg-white'}`}>
            <input
              type="date"
              value={draftFrom}
              onChange={(e) => setDraftFrom(e.target.value)}
              className="text-xs bg-transparent outline-none text-gray-600"
            />
            <span className="text-xs text-gray-400">to</span>
            <input
              type="date"
              value={draftTo}
              onChange={(e) => setDraftTo(e.target.value)}
              className="text-xs bg-transparent outline-none text-gray-600"
            />
            <button
              onClick={applyCustomRange}
              className="inline-flex items-center gap-1 rounded-md bg-gray-900 px-2 py-1 text-[11px] font-semibold text-white hover:bg-black"
            >
              <CalendarRange className="h-3 w-3" />
              Apply
            </button>
          </div>
          <button onClick={load} className="p-1.5 rounded-lg hover:bg-gray-100 transition-colors" title="Refresh">
            <RefreshCw className={`h-4 w-4 text-gray-500 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>
      {historyRows.length > 0 ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <p className="text-xs font-medium text-gray-500">
              {rangeMode === 'custom'
                ? `Custom range: ${data?.rangeLabel ?? `${draftFrom} - ${draftTo}`}`
                : `Showing ${data?.rangeLabel ?? (period === 'today' ? 'Today' : period === 'week' ? 'Last 7 Days' : 'This Month')}`}
            </p>
            {selectedHistoryRow ? (
              <p className="text-xs text-gray-400">
                Selected day: <span className="font-semibold text-gray-600">{selectedHistoryRow.date}</span>
              </p>
            ) : historyRows.length > 1 ? (
              <p className="text-xs text-gray-400">
                Showing totals for the selected range
              </p>
            ) : null}
          </div>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {historyRows.map((day) => {
              const chip = formatDayChip(day.date)
              const isSelected = day.date === selectedHistoryDate
              return (
                <button
                  key={day.date}
                  onClick={() => setSelectedHistoryDate(day.date)}
                  className={`min-w-[122px] rounded-xl border px-4 py-3 text-left transition-all ${
                    isSelected
                      ? 'border-orange-300 bg-orange-50 shadow-sm'
                      : 'border-gray-200 bg-gray-50 hover:bg-gray-100'
                  }`}
                >
                  <p className={`text-xs font-semibold ${isSelected ? 'text-orange-600' : 'text-gray-500'}`}>{chip.weekday}</p>
                  <p className="mt-1 text-base font-semibold text-gray-900">{chip.display}</p>
                  <p className={`mt-1 text-xs ${isSelected ? 'text-orange-600' : 'text-gray-500'}`}>
                    {day.salesCount} {day.salesCount === 1 ? 'sale' : 'sales'}
                  </p>
                </button>
              )
            })}
          </div>
        </div>
      ) : null}
      </div>

      {/* Alerts */}
      {(data?.alerts ?? []).length > 0 && (
        <div className="space-y-2">
          {data!.alerts.map((a,i) => (
            <div key={i} className={`flex items-center gap-2 text-sm px-4 py-2.5 rounded-xl border font-medium ${a.type==='danger' ? 'bg-red-50 border-red-200 text-red-700' : 'bg-amber-50 border-amber-200 text-amber-700'}`}>
              <AlertTriangle className="h-4 w-4 flex-shrink-0" />{a.message}
            </div>
          ))}
        </div>
      )}

      {/* KPI cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: 'Revenue', value: `${fmt(activeMetrics.revenue)} RWF`, sub: `${activeMetrics.salesCount} sales`, Icon: DollarSign, c:'text-green-600', bg:'bg-green-50', b:'border-green-200' },
          { label: 'Food Cost (COGS)', value: `${fmt(activeMetrics.cogs)} RWF`, sub: `${activeMetrics.foodCostPct}% of revenue`, Icon: ShoppingBag, c:'text-orange-600', bg:'bg-orange-50', b:'border-orange-200' },
          { label: 'Labor Cost', value: `${fmt(activeMetrics.laborCost)} RWF`, sub: `${activeMetrics.laborPct}% of revenue`, Icon: Users, c:'text-red-600', bg:'bg-red-50', b:'border-red-200' },
          { label: 'Waste Cost', value: `${fmt(activeMetrics.wasteCost)} RWF`, sub: `${activeMetrics.wastePct}% of revenue`, Icon: TrendingUp, c:'text-amber-600', bg:'bg-amber-50', b:'border-amber-200' },
        ].map(({ label, value, sub, Icon, c, bg, b }) => (
          <div key={label} className={`bg-white rounded-xl border ${b} p-4 shadow-sm`}>
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs text-gray-500 font-medium">{label}</p>
                <p className="text-xl font-bold text-gray-900 mt-1">{value}</p>
                <p className={`text-xs font-medium mt-1 ${c}`}>{sub}</p>
              </div>
              <div className={`${bg} ${c} p-2 rounded-lg`}><Icon className="h-5 w-5" /></div>
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

        {/* Prime Cost */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
          <div className="flex items-center gap-2 mb-3">
            <Flame className="h-5 w-5 text-orange-500" />
            <h3 className="font-semibold text-gray-800">Prime Cost</h3>
            <span className="text-xs text-gray-400 ml-auto">COGS + Labor</span>
          </div>
          <div className="text-center py-3">
            <p className="text-4xl font-bold text-gray-900">{activeMetrics.primeCostPct}%</p>
            <p className="text-sm text-gray-500 mt-1">{fmt(activeMetrics.primeCost)} RWF</p>
            <div className="mt-4 h-2.5 rounded-full bg-gray-100 overflow-hidden">
              <div className={`h-full rounded-full transition-all duration-500 ${activeMetrics.primeCostPct<=60?'bg-green-500':activeMetrics.primeCostPct<=65?'bg-amber-500':'bg-red-500'}`}
                style={{ width: `${Math.min(activeMetrics.primeCostPct,100)}%` }} />
            </div>
            <div className="flex justify-between text-xs text-gray-400 mt-1">
              <span>0%</span><span className="text-green-600 font-medium">Industry target &lt;60%</span><span>100%</span>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 mt-3 pt-4 border-t border-gray-100">
            <div className="text-center">
              <p className="text-xs text-gray-500 mb-0.5">Food Cost</p>
              <PctBadge pct={activeMetrics.foodCostPct} good={30} warn={35} />
              <p className="text-xs text-gray-400">Industry target 25-35%</p>
            </div>
            <div className="text-center">
              <p className="text-xs text-gray-500 mb-0.5">Labor</p>
              <PctBadge pct={activeMetrics.laborPct} good={30} warn={35} />
              <p className="text-xs text-gray-400">Industry target 25-35%</p>
            </div>
          </div>
        </div>

        {/* Top dishes */}
        <div className="lg:col-span-2 bg-white rounded-xl border border-gray-200 shadow-sm">
          <div className="p-4 border-b border-gray-100 flex items-center justify-between">
            <h2 className="font-semibold text-gray-800">Top Dishes</h2>
            {(data?.lowStockCount??0) > 0 && (
              <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full font-medium">
                {data!.lowStockCount} low stock
              </span>
            )}
          </div>
          {!data || data.topDishes.length === 0 ? (
            <div className="p-10 text-center text-gray-400 text-sm">
              No sales yet. Record sales in <strong>Orders</strong> to see top performers.
            </div>
          ) : (
            <div className="divide-y divide-gray-50">
              {data.topDishes.map((d,i) => (
                <div key={d.name} className="px-4 py-3 flex items-center gap-3">
                  <span className="text-lg font-bold text-gray-300 w-6">{i+1}</span>
                  <div className="flex-1">
                    <p className="text-sm font-medium text-gray-800">{d.name}</p>
                    <p className="text-xs text-gray-500">{d.orders} portions</p>
                  </div>
                  <p className="text-sm font-semibold text-gray-900">{fmt(d.revenue)} RWF</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {data && data.revenue === 0 && (
        <div className="bg-orange-50 border border-orange-200 rounded-xl p-4 text-sm text-orange-700 flex items-start gap-3">
          <CheckCircle2 className="h-5 w-5 flex-shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold">No sales for this period</p>
            <p className="text-orange-600 mt-0.5">Go to <strong>Orders</strong> to record a dish sale. Inventory deducts automatically and all KPIs update here.</p>
          </div>
        </div>
      )}
    </div>
  )
}
