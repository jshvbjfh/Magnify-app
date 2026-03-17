'use client'
import { useState, useEffect, useCallback } from 'react'
import { TrendingUp, AlertTriangle, LogOut, RefreshCw, ChefHat, Package, BarChart3, Crown } from 'lucide-react'
import { signOut } from 'next-auth/react'

type DashData = {
  restaurantName: string
  period: string
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
  activeOrders: number
  topDishes: { name: string; revenue: number; qty: number }[]
  lowStock: { name: string; quantity: number; reorderLevel: number; unit: string }[]
}

function KpiCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color: string }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
      <p className="text-xs text-gray-500 font-medium uppercase tracking-wide">{label}</p>
      <p className={`text-2xl font-bold mt-1 ${color}`}>{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
    </div>
  )
}

function pctColor(pct: number, warn: number, danger: number) {
  return pct >= danger ? 'text-red-600' : pct >= warn ? 'text-amber-500' : 'text-green-600'
}

export default function OwnerShell() {
  const [period, setPeriod] = useState<'today' | 'week' | 'month'>('today')
  const [data, setData] = useState<DashData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastRefresh, setLastRefresh] = useState(new Date())

  const load = useCallback(async (p: string) => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/owner/dashboard?period=${p}`, { credentials: 'include' })
      if (!res.ok) { setError('Failed to load data'); return }
      setData(await res.json())
      setLastRefresh(new Date())
    } catch {
      setError('Network error — check your connection')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load(period) }, [period, load])
  useEffect(() => {
    const t = setInterval(() => load(period), 30000)
    return () => clearInterval(t)
  }, [period, load])

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">

      {/* ── Header ── */}
      <div className="bg-white border-b border-gray-200 px-4 sm:px-6 py-3 sm:py-4 flex items-center justify-between flex-wrap gap-2 flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="bg-gradient-to-br from-purple-500 to-indigo-600 rounded-xl p-2.5 shadow-sm">
            <Crown className="h-5 w-5 text-white" />
          </div>
          <div>
            <h1 className="font-bold text-gray-900 text-base sm:text-lg leading-tight">
              {data?.restaurantName ?? 'Owner Dashboard'}
            </h1>
            <p className="text-xs text-gray-400">
              Read-only · last updated {lastRefresh.toLocaleTimeString('en-RW', { hour: '2-digit', minute: '2-digit' })}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Period selector */}
          <div className="flex bg-gray-100 rounded-lg p-1 text-xs font-medium">
            {(['today', 'week', 'month'] as const).map(p => (
              <button key={p} onClick={() => setPeriod(p)}
                className={`px-2.5 sm:px-3 py-1.5 rounded-md capitalize transition-colors ${period === p ? 'bg-white shadow text-gray-900' : 'text-gray-500 hover:text-gray-700'}`}>
                {p === 'today' ? 'Today' : p === 'week' ? 'Week' : 'Month'}
              </button>
            ))}
          </div>
          <button onClick={() => load(period)}
            className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800 bg-gray-100 hover:bg-gray-200 px-3 py-1.5 rounded-lg transition-colors">
            <RefreshCw className="h-4 w-4" /> <span className="hidden sm:inline">Refresh</span>
          </button>
          <button onClick={() => signOut({ callbackUrl: '/login' })}
            className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-red-600 bg-gray-100 hover:bg-red-50 px-3 py-1.5 rounded-lg transition-colors">
            <LogOut className="h-4 w-4" /> <span className="hidden sm:inline">Sign Out</span>
          </button>
        </div>
      </div>

      {/* ── Content ── */}
      <div className="flex-1 p-3 sm:p-6 space-y-4 sm:space-y-6 max-w-5xl mx-auto w-full">
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-xl">{error}</div>
        )}

        {loading && !data ? (
          <div className="flex items-center justify-center py-20 text-gray-400">
            <div className="h-8 w-8 rounded-full border-4 border-purple-200 border-t-purple-500 animate-spin mr-3" />
            Loading…
          </div>
        ) : data && (
          <>
            {/* Active orders live badge */}
            {data.activeOrders > 0 && (
              <div className="flex items-center gap-2 bg-orange-50 border border-orange-200 text-orange-700 text-sm font-medium px-4 py-3 rounded-xl">
                <span className="h-2 w-2 bg-orange-500 rounded-full animate-pulse inline-block" />
                {data.activeOrders} active order{data.activeOrders !== 1 ? 's' : ''} in the kitchen right now
              </div>
            )}

            {/* KPI row */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
              <KpiCard
                label="Revenue"
                value={`${data.revenue.toLocaleString()} RWF`}
                sub={`${data.salesCount} sale${data.salesCount !== 1 ? 's' : ''}`}
                color="text-gray-900"
              />
              <KpiCard
                label="Food Cost"
                value={`${data.foodCostPct}%`}
                sub={`${data.cogs.toLocaleString()} RWF`}
                color={pctColor(data.foodCostPct, 30, 40)}
              />
              <KpiCard
                label="Waste"
                value={`${data.wastePct}%`}
                sub={`${data.wasteCost.toLocaleString()} RWF`}
                color={pctColor(data.wastePct, 3, 7)}
              />
              <KpiCard
                label="Prime Cost"
                value={`${data.primeCostPct}%`}
                sub="food + labor"
                color={pctColor(data.primeCostPct, 55, 65)}
              />
            </div>

            {/* Top dishes + Low stock */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

              {/* Top dishes */}
              <div className="bg-white rounded-xl border border-gray-200 shadow-sm">
                <div className="px-5 py-4 border-b border-gray-100 flex items-center gap-2">
                  <BarChart3 className="h-4 w-4 text-purple-500" />
                  <h3 className="font-semibold text-gray-800">Top Dishes</h3>
                  <span className="text-xs text-gray-400 ml-auto">
                    {period === 'today' ? 'Today' : period === 'week' ? 'This Week' : 'This Month'}
                  </span>
                </div>
                {data.topDishes.length === 0 ? (
                  <p className="px-5 py-8 text-center text-gray-400 text-sm">No sales recorded yet</p>
                ) : (
                  <div className="divide-y divide-gray-50">
                    {data.topDishes.map((d, i) => (
                      <div key={d.name} className="flex items-center gap-3 px-5 py-3">
                        <span className={`text-xs font-bold w-5 ${i === 0 ? 'text-yellow-500' : 'text-gray-400'}`}>
                          #{i + 1}
                        </span>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-gray-800 truncate">{d.name}</p>
                          <p className="text-xs text-gray-400">{d.qty} sold</p>
                        </div>
                        <span className="text-sm font-semibold text-gray-700">{d.revenue.toLocaleString()} RWF</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Low stock */}
              <div className="bg-white rounded-xl border border-gray-200 shadow-sm">
                <div className="px-5 py-4 border-b border-gray-100 flex items-center gap-2">
                  <Package className="h-4 w-4 text-red-500" />
                  <h3 className="font-semibold text-gray-800">Low Stock Alerts</h3>
                  {data.lowStock.length > 0 && (
                    <span className="ml-auto text-xs bg-red-100 text-red-700 font-semibold px-2 py-0.5 rounded-full">
                      {data.lowStock.length}
                    </span>
                  )}
                </div>
                {data.lowStock.length === 0 ? (
                  <div className="px-5 py-8 text-center">
                    <p className="text-green-600 font-semibold text-sm">✓ All stock levels OK</p>
                  </div>
                ) : (
                  <div className="divide-y divide-gray-50 max-h-64 overflow-y-auto">
                    {data.lowStock.map(i => (
                      <div key={i.name} className="flex items-center gap-3 px-5 py-3">
                        <AlertTriangle className="h-4 w-4 text-red-400 flex-shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-gray-800 truncate">{i.name}</p>
                          <p className="text-xs text-red-500">
                            {i.quantity} {i.unit} left · reorder at {i.reorderLevel}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Labor & prime cost detail */}
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
              <div className="flex items-center gap-2 mb-4">
                <ChefHat className="h-4 w-4 text-blue-500" />
                <h3 className="font-semibold text-gray-800">Labor & Prime Cost</h3>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
                <div>
                  <p className="text-xs text-gray-500 mb-1">Labor Cost</p>
                  <p className="text-xl font-bold text-gray-900">{data.laborCost.toLocaleString()} RWF</p>
                  <p className={`text-sm font-semibold mt-0.5 ${pctColor(data.laborPct, 25, 35)}`}>
                    {data.laborPct}% of revenue
                  </p>
                </div>
                <div>
                  <p className="text-xs text-gray-500 mb-1">Food Cost</p>
                  <p className="text-xl font-bold text-gray-900">{data.cogs.toLocaleString()} RWF</p>
                  <p className={`text-sm font-semibold mt-0.5 ${pctColor(data.foodCostPct, 30, 40)}`}>
                    {data.foodCostPct}% of revenue
                  </p>
                </div>
                <div>
                  <p className="text-xs text-gray-500 mb-1">Prime Cost (Food + Labor)</p>
                  <p className="text-xl font-bold text-gray-900">{data.primeCost.toLocaleString()} RWF</p>
                  <p className={`text-sm font-semibold mt-0.5 ${pctColor(data.primeCostPct, 55, 65)}`}>
                    {data.primeCostPct}% <span className="text-gray-400 font-normal">(target &lt;60%)</span>
                  </p>
                </div>
              </div>
            </div>

            {/* Revenue trend note */}
            <div className="flex items-start gap-3 bg-purple-50 border border-purple-100 rounded-xl px-4 py-3">
              <TrendingUp className="h-4 w-4 text-purple-500 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-purple-700">
                <span className="font-semibold">Tip:</span> Switch between Today / This Week / This Month using the selector above to compare performance periods. Data refreshes automatically every 30 seconds.
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
