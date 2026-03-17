'use client'

import { useState, useEffect, useCallback } from 'react'
import { TrendingUp, Users, ShoppingBag, DollarSign, AlertTriangle, CheckCircle2, RefreshCw, Flame, Sparkles, ChefHat, Clock, Utensils } from 'lucide-react'

type DashboardData = {
  period: string; revenue: number; cogs: number; foodCostPct: number
  laborCost: number; laborPct: number; wasteCost: number; wastePct: number
  primeCost: number; primeCostPct: number; salesCount: number
  topDishes: { name: string; revenue: number; orders: number }[]
  lowStockCount: number; alerts: { type: 'warning' | 'danger'; message: string }[]
}

type LiveOrder = {
  id: string; tableName: string; dishName: string; qty: number
  status: string; addedAt: string; readyAt?: string | null
}

type LiveTicket = {
  tableName: string
  items: LiveOrder[]
  oldestAddedAt: string
  status: 'new' | 'in_kitchen' | 'ready' | 'mixed'
  cookMins?: number // readyAt - addedAt for ready tickets
}

function fmt(n: number) { return n.toLocaleString('en-RW', { maximumFractionDigits: 0 }) }

function PctBadge({ pct, good, warn }: { pct: number; good: number; warn: number }) {
  const c = pct === 0 ? 'text-gray-500' : pct <= good ? 'text-green-600' : pct <= warn ? 'text-amber-600' : 'text-red-600'
  return <span className={`text-lg font-bold ${c}`}>{pct}%</span>
}

export default function RestaurantDashboard({ onAskJesse }: { onAskJesse?: () => void }) {
  const [period, setPeriod] = useState<'today' | 'week' | 'month'>('today')
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [liveOrders, setLiveOrders] = useState<LiveOrder[]>([])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/restaurant/dashboard?period=${period}`)
      if (res.ok) setData(await res.json())
    } finally { setLoading(false) }
  }, [period])

  const loadLive = useCallback(async () => {
    try {
      const res = await fetch('/api/restaurant/pending', { credentials: 'include' })
      if (res.ok) {
        const data = await res.json()
        setLiveOrders(Array.isArray(data) ? data : [])
      }
    } catch {}
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    loadLive()
    const t = setInterval(loadLive, 5000)
    return () => clearInterval(t)
  }, [loadLive])

  // Group live orders into tickets by table
  const liveTickets: LiveTicket[] = (() => {
    const map = new Map<string, LiveOrder[]>()
    for (const o of liveOrders) {
      if (!map.has(o.tableName)) map.set(o.tableName, [])
      map.get(o.tableName)!.push(o)
    }
    return Array.from(map.entries()).map(([tableName, items]) => {
      const statuses = new Set(items.map(i => i.status))
      const dominant = statuses.has('ready') && statuses.size === 1 ? 'ready'
        : statuses.has('in_kitchen') ? 'in_kitchen'
        : statuses.has('new') && statuses.size === 1 ? 'new'
        : 'mixed'
      const readyItem = items.find(i => i.readyAt)
      const cookMins = readyItem
        ? Math.round((new Date(readyItem.readyAt!).getTime() - new Date(readyItem.addedAt).getTime()) / 60000)
        : undefined
      return {
        tableName,
        items,
        oldestAddedAt: items.reduce((a, i) => i.addedAt < a ? i.addedAt : a, items[0].addedAt),
        status: dominant as LiveTicket['status'],
        cookMins,
      }
    }).sort((a, b) => a.oldestAddedAt.localeCompare(b.oldestAddedAt))
  })()

  useEffect(() => { load() }, [load])

  return (
    <div className="space-y-6">

      {/* Period selector */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-lg font-bold text-gray-800">Dashboard</h2>
        <div className="flex items-center gap-2">
          <button onClick={onAskJesse} className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg border border-orange-300 text-orange-600 bg-white hover:bg-orange-50 transition-colors">
            <Sparkles className="h-3.5 w-3.5"/> Ask Jesse
          </button>
          {(['today','week','month'] as const).map(p => (
            <button key={p} onClick={() => setPeriod(p)}
              className={`text-xs px-3 py-1.5 rounded-lg font-medium transition-all ${period === p ? 'bg-orange-500 text-white shadow' : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
              {p === 'today' ? 'Today' : p === 'week' ? '7 Days' : 'Month'}
            </button>
          ))}
          <button onClick={load} className="p-1.5 rounded-lg hover:bg-gray-100 transition-colors" title="Refresh">
            <RefreshCw className={`h-4 w-4 text-gray-500 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
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
          { label: 'Revenue', value: `${fmt(data?.revenue??0)} RWF`, sub: `${data?.salesCount??0} sales`, Icon: DollarSign, c:'text-green-600', bg:'bg-green-50', b:'border-green-200' },
          { label: 'Food Cost (COGS)', value: `${fmt(data?.cogs??0)} RWF`, sub: `${data?.foodCostPct??0}% of revenue`, Icon: ShoppingBag, c:'text-orange-600', bg:'bg-orange-50', b:'border-orange-200' },
          { label: 'Labor Cost', value: `${fmt(data?.laborCost??0)} RWF`, sub: `${data?.laborPct??0}% of revenue`, Icon: Users, c:'text-red-600', bg:'bg-red-50', b:'border-red-200' },
          { label: 'Waste Cost', value: `${fmt(data?.wasteCost??0)} RWF`, sub: `${data?.wastePct??0}% of revenue`, Icon: TrendingUp, c:'text-amber-600', bg:'bg-amber-50', b:'border-amber-200' },
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
            <p className="text-4xl font-bold text-gray-900">{data?.primeCostPct??0}%</p>
            <p className="text-sm text-gray-500 mt-1">{fmt(data?.primeCost??0)} RWF</p>
            <div className="mt-4 h-2.5 rounded-full bg-gray-100 overflow-hidden">
              <div className={`h-full rounded-full transition-all duration-500 ${(data?.primeCostPct??0)<=60?'bg-green-500':(data?.primeCostPct??0)<=65?'bg-amber-500':'bg-red-500'}`}
                style={{ width: `${Math.min(data?.primeCostPct??0,100)}%` }} />
            </div>
            <div className="flex justify-between text-xs text-gray-400 mt-1">
              <span>0%</span><span className="text-green-600 font-medium">Target &lt;60%</span><span>100%</span>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 mt-3 pt-4 border-t border-gray-100">
            <div className="text-center">
              <p className="text-xs text-gray-500 mb-0.5">Food Cost</p>
              <PctBadge pct={data?.foodCostPct??0} good={30} warn={35} />
              <p className="text-xs text-gray-400">target 2535%</p>
            </div>
            <div className="text-center">
              <p className="text-xs text-gray-500 mb-0.5">Labor</p>
              <PctBadge pct={data?.laborPct??0} good={30} warn={35} />
              <p className="text-xs text-gray-400">target 2535%</p>
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

      {/* ── Live Kitchen Status ────────────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ChefHat className="h-5 w-5 text-orange-500" />
            <h3 className="font-semibold text-gray-800">Live Kitchen</h3>
            <span className="text-xs text-gray-400">auto-refreshes every 5 s</span>
          </div>
          <div className="flex items-center gap-3">
            {liveOrders.length > 0 && (
              <span className="text-xs font-semibold bg-orange-100 text-orange-700 px-2 py-0.5 rounded-full">
                {liveOrders.length} active item{liveOrders.length !== 1 ? 's' : ''}
              </span>
            )}
            <button onClick={loadLive} title="Refresh">
              <RefreshCw className="h-4 w-4 text-gray-400 hover:text-gray-600" />
            </button>
          </div>
        </div>

        {liveOrders.length === 0 ? (
          <div className="px-5 py-10 text-center text-gray-400 text-sm">
            <Utensils className="h-8 w-8 mx-auto mb-2 opacity-20" />
            No active orders right now
          </div>
        ) : (
          <div className="p-5 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {liveTickets.map(ticket => {
              const ageMs   = Date.now() - new Date(ticket.oldestAddedAt).getTime()
              const ageMins = Math.floor(ageMs / 60000)
              const isReady    = ticket.status === 'ready'
              const isCooking  = ticket.status === 'in_kitchen' || ticket.status === 'mixed'
              const ageColor   = ageMins < 10 ? 'text-green-600' : ageMins < 20 ? 'text-amber-600' : 'text-red-600'
              return (
                <div key={ticket.tableName}
                  className={`rounded-xl border-2 p-4 space-y-2 ${
                    isReady   ? 'border-green-300 bg-green-50'
                    : isCooking ? 'border-orange-200 bg-orange-50'
                    : 'border-gray-200 bg-gray-50'
                  }`}>
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-gray-900 text-sm">{ticket.tableName}</span>
                    <div className="flex items-center gap-1.5">
                      {isReady ? (
                        <>
                          <CheckCircle2 className="h-4 w-4 text-green-500" />
                          <span className="text-xs font-semibold text-green-600">Ready</span>
                          {ticket.cookMins !== undefined && (
                            <span className="text-xs text-gray-400 ml-1">· Done in {ticket.cookMins} mins</span>
                          )}
                        </>
                      ) : isCooking ? (
                        <>
                          <Flame className="h-4 w-4 text-orange-500" />
                          <span className="text-xs font-semibold text-orange-600">Cooking</span>
                        </>
                      ) : (
                        <>
                          <Clock className="h-4 w-4 text-gray-400" />
                          <span className="text-xs font-semibold text-gray-500">Waiting</span>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="space-y-1">
                    {ticket.items.map(item => (
                      <div key={item.id} className="flex items-center justify-between text-xs">
                        <span className="text-gray-700">{item.qty > 1 ? `×${item.qty} ` : ''}{item.dishName}</span>
                        <span className={`font-medium capitalize px-1.5 py-0.5 rounded-full text-[10px] ${
                          item.status === 'ready'      ? 'bg-green-100 text-green-700'
                          : item.status === 'in_kitchen' ? 'bg-orange-100 text-orange-700'
                          : 'bg-gray-100 text-gray-500'
                        }`}>{item.status === 'in_kitchen' ? 'cooking' : item.status}</span>
                      </div>
                    ))}
                  </div>
                  <div className={`flex items-center gap-1 text-xs font-medium pt-1 border-t border-black/5 ${ageColor}`}>
                    <Clock className="h-3 w-3" />
                    {ageMins === 0 ? 'Just placed'
                      : ageMins < 60 ? `${ageMins}m ago`
                      : ageMins < 1440 ? `${Math.floor(ageMins / 60)}h ${ageMins % 60}m ago`
                      : `${Math.floor(ageMins / 1440)}d ago`}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
