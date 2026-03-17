'use client'
import { useState, useEffect, useCallback } from 'react'
import { ChefHat, CheckCircle2, Clock, Flame, RefreshCw, Utensils, Receipt } from 'lucide-react'

type LiveOrder = {
  id: string; tableName: string; dishName: string; qty: number
  status: string; addedAt: string; readyAt?: string | null
  waiter?: { name: string }
  cookMins?: number // computed client-side
}
type Ticket = {
  tableName: string; items: LiveOrder[]
  oldestAddedAt: string; status: 'new' | 'in_kitchen' | 'ready' | 'mixed'
  cookMins?: number
}
type Sale = {
  id: string; dish: { name: string }; quantitySold: number
  totalSaleAmount: number; saleDate: string; paymentMethod: string
}

function fmt(n: number) { return n.toLocaleString('en-RW', { maximumFractionDigits: 0 }) }
function fmtTime(d: string) {
  return new Date(d).toLocaleTimeString('en-RW', { hour: '2-digit', minute: '2-digit' })
}
function ageFmt(addedAt: string) {
  const m = Math.floor((Date.now() - new Date(addedAt).getTime()) / 60000)
  if (m === 0) return 'Just placed'
  if (m < 60) return `${m}m ago`
  if (m < 1440) return `${Math.floor(m / 60)}h ${m % 60}m ago`
  return `${Math.floor(m / 1440)}d ago`
}
function ageColor(addedAt: string) {
  const m = Math.floor((Date.now() - new Date(addedAt).getTime()) / 60000)
  return m < 10 ? 'text-green-600' : m < 20 ? 'text-amber-600' : 'text-red-600'
}

function groupToTickets(orders: LiveOrder[]): Ticket[] {
  const map = new Map<string, LiveOrder[]>()
  for (const o of orders) {
    if (!map.has(o.tableName)) map.set(o.tableName, [])
    map.get(o.tableName)!.push(o)
  }
  return Array.from(map.entries()).map(([tableName, items]) => {
    // Annotate each item with its individual cook time
    const annotated = items.map(i => ({
      ...i,
      cookMins: i.readyAt
        ? Math.round((new Date(i.readyAt).getTime() - new Date(i.addedAt).getTime()) / 60000)
        : undefined,
    }))
    const statuses = new Set(annotated.map(i => i.status))
    const dominant =
      statuses.has('ready') && statuses.size === 1 ? 'ready'
      : statuses.has('in_kitchen') ? 'in_kitchen'
      : statuses.has('new') && statuses.size === 1 ? 'new'
      : 'mixed'
    // Ticket-level cook time: average of all ready items
    const readyItems = annotated.filter(i => i.cookMins !== undefined)
    const cookMins = readyItems.length > 0
      ? Math.round(readyItems.reduce((s, i) => s + i.cookMins!, 0) / readyItems.length)
      : undefined
    return {
      tableName, items: annotated, cookMins,
      oldestAddedAt: annotated.reduce((a, i) => i.addedAt < a ? i.addedAt : a, annotated[0].addedAt),
      status: dominant as Ticket['status'],
    }
  }).sort((a, b) => a.oldestAddedAt.localeCompare(b.oldestAddedAt))
}

export default function RestaurantLive() {
  const [orders, setOrders] = useState<LiveOrder[]>([])
  const [sales, setSales] = useState<Sale[]>([])
  const [lastRefresh, setLastRefresh] = useState(new Date())

  const loadOrders = useCallback(async () => {
    try {
      const res = await fetch('/api/restaurant/pending', { credentials: 'include' })
      if (res.ok) {
        const data = await res.json()
        setOrders(Array.isArray(data) ? data : [])
        setLastRefresh(new Date())
      }
    } catch {}
  }, [])

  const loadSales = useCallback(async () => {
    try {
      const res = await fetch('/api/restaurant/dish-sales', { credentials: 'include' })
      if (res.ok) {
        const data = await res.json()
        setSales(Array.isArray(data) ? data : [])
      }
    } catch {}
  }, [])

  useEffect(() => {
    loadOrders(); loadSales()
    const t = setInterval(() => { loadOrders(); loadSales() }, 5000)
    return () => clearInterval(t)
  }, [loadOrders, loadSales])

  const tickets = groupToTickets(orders)
  const newTickets     = tickets.filter(t => t.status === 'new')
  const cookingTickets = tickets.filter(t => t.status === 'in_kitchen' || t.status === 'mixed')
  const readyTickets   = tickets.filter(t => t.status === 'ready')

  const todaySales = sales.filter(s => new Date(s.saleDate).toDateString() === new Date().toDateString())
  const todayRevenue = todaySales.reduce((s, x) => s + x.totalSaleAmount, 0)

  const now = new Date()
  const showCompletedToday = !(now.getHours() === 23 && now.getMinutes() >= 59)

  return (
    <div className="space-y-6">

      {/* Live header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-green-500 animate-pulse" />
          <span className="text-xs text-gray-400">
            Last updated {lastRefresh.toLocaleTimeString('en-RW', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            &nbsp;&middot; auto-refreshes every 5 s
          </span>
        </div>
        <button onClick={() => { loadOrders(); loadSales() }}
          className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-800 bg-gray-100 hover:bg-gray-200 px-3 py-1.5 rounded-lg transition-colors">
          <RefreshCw className="h-3.5 w-3.5" /> Refresh
        </button>
      </div>

      {/* Summary chips */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: 'Waiting', count: newTickets.length,     color: 'bg-gray-100 text-gray-700 border-gray-200',   dot: 'bg-gray-400' },
          { label: 'Cooking', count: cookingTickets.length, color: 'bg-orange-50 text-orange-700 border-orange-200', dot: 'bg-orange-500' },
          { label: 'Ready',   count: readyTickets.length,   color: 'bg-green-50 text-green-700 border-green-200',  dot: 'bg-green-500' },
        ].map(({ label, count, color, dot }) => (
          <div key={label} className={`rounded-xl border p-4 flex items-center gap-3 ${color}`}>
            <span className={`h-3 w-3 rounded-full flex-shrink-0 ${dot}`} />
            <div>
              <p className="text-2xl font-bold">{count}</p>
              <p className="text-xs font-medium opacity-70">{label} table{count !== 1 ? 's' : ''}</p>
            </div>
          </div>
        ))}
      </div>

      {/* ── Active Orders ───────────────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center gap-2">
          <ChefHat className="h-5 w-5 text-orange-500" />
          <h3 className="font-semibold text-gray-800">Active Orders</h3>
          {orders.length > 0 && (
            <span className="ml-auto text-xs font-semibold bg-orange-100 text-orange-700 px-2 py-0.5 rounded-full">
              {orders.length} item{orders.length !== 1 ? 's' : ''}
            </span>
          )}
        </div>

        {tickets.length === 0 ? (
          <div className="px-5 py-12 text-center text-gray-400 text-sm">
            <Utensils className="h-8 w-8 mx-auto mb-2 opacity-20" />
            No active orders right now
          </div>
        ) : (
          <div className="p-5 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {tickets.map(ticket => {
              const isReady   = ticket.status === 'ready'
              const isCooking = ticket.status === 'in_kitchen' || ticket.status === 'mixed'
              return (
                <div key={ticket.tableName}
                  className={`rounded-xl border-2 p-4 space-y-2.5 ${
                    isReady   ? 'border-green-300 bg-green-50'
                    : isCooking ? 'border-orange-200 bg-orange-50'
                    : 'border-gray-200 bg-gray-50'
                  }`}>

                  {/* Ticket header */}
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-gray-900">{ticket.tableName}</span>
                    <div className="flex items-center gap-1.5">
                      {isReady ? (
                        <>
                          <CheckCircle2 className="h-4 w-4 text-green-500" />
                          <span className="text-xs font-semibold text-green-600">Ready</span>
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

                  {/* Done-in badge for fully ready tickets */}
                  {isReady && ticket.cookMins !== undefined && (
                    <div className="flex items-center gap-1.5 bg-green-100 text-green-700 text-xs font-semibold px-3 py-1.5 rounded-lg">
                      <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0" />
                      Done in {ticket.cookMins} min{ticket.cookMins !== 1 ? 's' : ''}
                    </div>
                  )}

                  {/* Items */}
                  <div className="space-y-1.5">
                    {ticket.items.map(item => (
                      <div key={item.id} className="flex items-center justify-between text-xs gap-2">
                        <span className="text-gray-700 flex-1">{item.qty > 1 ? `×${item.qty} ` : ''}{item.dishName}</span>
                        <div className="flex items-center gap-1.5 flex-shrink-0">
                          {item.status === 'ready' && item.cookMins !== undefined && (
                            <span className="text-[10px] font-semibold text-green-600">{item.cookMins} min{item.cookMins !== 1 ? 's' : ''}</span>
                          )}
                          <span className={`font-medium px-1.5 py-0.5 rounded-full text-[10px] ${
                            item.status === 'ready'        ? 'bg-green-100 text-green-700'
                            : item.status === 'in_kitchen' ? 'bg-orange-100 text-orange-700'
                            : 'bg-gray-100 text-gray-500'
                          }`}>
                            {item.status === 'in_kitchen' ? 'cooking' : item.status}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Waiter + age */}
                  <div className="flex items-center justify-between pt-1 border-t border-black/5">
                    {ticket.items[0]?.waiter?.name ? (
                      <span className="text-[11px] text-gray-400">by {ticket.items[0].waiter.name}</span>
                    ) : <span />}
                    <span className={`flex items-center gap-1 text-[11px] font-medium ${ageColor(ticket.oldestAddedAt)}`}>
                      <Clock className="h-3 w-3" />
                      {ageFmt(ticket.oldestAddedAt)}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* ── Completed Today ─────────────────────────────────────────────── */}
      {showCompletedToday && (
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center gap-2">
          <Receipt className="h-5 w-5 text-green-500" />
          <h3 className="font-semibold text-gray-800">Completed Today</h3>
          <span className="ml-auto text-xs font-semibold text-green-700 bg-green-50 border border-green-200 px-2 py-0.5 rounded-full">
            {fmt(todayRevenue)} RWF
          </span>
        </div>

        {todaySales.length === 0 ? (
          <div className="px-5 py-12 text-center text-gray-400 text-sm">
            <Receipt className="h-8 w-8 mx-auto mb-2 opacity-20" />
            No completed sales yet today
          </div>
        ) : (
          <div className="divide-y divide-gray-50">
            {todaySales.slice().reverse().map(sale => (
              <div key={sale.id} className="px-5 py-3 flex items-center gap-3">
                <div className="h-8 w-8 rounded-lg bg-green-50 border border-green-200 flex items-center justify-center flex-shrink-0">
                  <CheckCircle2 className="h-4 w-4 text-green-500" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-800 truncate">
                    {sale.dish.name}{sale.quantitySold > 1 ? ` ×${sale.quantitySold}` : ''}
                  </p>
                  <p className="text-xs text-gray-400">{fmtTime(sale.saleDate)} · {sale.paymentMethod}</p>
                </div>
                <p className="text-sm font-semibold text-gray-900 flex-shrink-0">{fmt(sale.totalSaleAmount)} RWF</p>
              </div>
            ))}
          </div>
        )}
      </div>
      )}
    </div>
  )
}
