import { useState, useEffect, useCallback } from 'react'
import { CheckCircle2, Users, Clock, XCircle, RefreshCw } from 'lucide-react'
import { getTables, getOrders, type RestaurantTable, type Order } from '../services/db'

// ─── Types ───────────────────────────────────────────────────────────────────

type TableStatus = 'available' | 'occupied' | 'reserved' | 'cleaning'

// ─── Constants ───────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<TableStatus, {
  label: string
  dot:   string
  text:  string
  bg:    string
  Icon:  typeof CheckCircle2
}> = {
  available: { label: 'Available', dot: 'bg-green-500',  text: 'text-green-700',  bg: 'bg-green-50  border-green-200',  Icon: CheckCircle2 },
  occupied:  { label: 'Occupied',  dot: 'bg-orange-500', text: 'text-orange-700', bg: 'bg-orange-50 border-orange-200', Icon: Users        },
  reserved:  { label: 'Reserved',  dot: 'bg-amber-500',  text: 'text-amber-700',  bg: 'bg-amber-50  border-amber-200',  Icon: Clock        },
  cleaning:  { label: 'Cleaning',  dot: 'bg-gray-400',   text: 'text-gray-600',   bg: 'bg-gray-50   border-gray-200',   Icon: XCircle      },
}

const VALID_STATUSES = new Set<string>(['available', 'occupied', 'reserved', 'cleaning'])

function safeStatus(s: string): TableStatus {
  return VALID_STATUSES.has(s) ? (s as TableStatus) : 'available'
}

function fmtRWF(n: number) {
  return n.toLocaleString('en-RW', { maximumFractionDigits: 0 })
}

// ─── Component ───────────────────────────────────────────────────────────────

interface Props {
  waiterName: string
  activeBranchId?: string | null
}

export default function RestaurantTables({ waiterName: _waiterName, activeBranchId = null }: Props) {
  const [tables,        setTables]        = useState<RestaurantTable[]>([])
  const [pendingOrders, setPendingOrders] = useState<Order[]>([])
  const [loading,       setLoading]       = useState(true)
  const [filter,        setFilter]        = useState<TableStatus | 'all'>('all')

  const load = useCallback(async () => {
    try {
      const [t, o] = await Promise.all([
        getTables(activeBranchId),
        getOrders({ status: 'PENDING', branchId: activeBranchId }),
      ])
      setTables(t)
      setPendingOrders(o)
    } catch {}
    setLoading(false)
  }, [activeBranchId])

  useEffect(() => { load() }, [load])

  // ── Derived values ──

  // Pending order totals per table (for the order amount badge)
  const pendingByTable: Record<string, { count: number; total: number }> = {}
  for (const o of pendingOrders) {
    if (!o.table_id) continue
    const entry = pendingByTable[o.table_id] ?? { count: 0, total: 0 }
    entry.count += 1
    entry.total += o.total_amount
    pendingByTable[o.table_id] = entry
  }

  const counts = {
    available: tables.filter(t => safeStatus(t.status) === 'available').length,
    occupied:  tables.filter(t => safeStatus(t.status) === 'occupied').length,
    reserved:  tables.filter(t => safeStatus(t.status) === 'reserved').length,
    cleaning:  tables.filter(t => safeStatus(t.status) === 'cleaning').length,
  }

  const filtered = filter === 'all' ? tables : tables.filter(t => safeStatus(t.status) === filter)

  // ── Render ──

  return (
    <div className="space-y-5">

      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-bold text-gray-800">Floor Plan</h2>
          <p className="text-sm text-gray-500">
            {counts.occupied} occupied · {tables.length} total
          </p>
        </div>
        <button onClick={load} className="p-2 rounded-lg border border-gray-200 hover:bg-gray-50" title="Refresh">
          <RefreshCw className="h-4 w-4 text-gray-500" />
        </button>
      </div>

      {/* Status filter pills */}
      <div className="flex flex-wrap gap-2">
        {(['all', 'available', 'occupied', 'reserved', 'cleaning'] as const).map(s => {
          const isActive = filter === s
          const count    = s === 'all' ? tables.length : counts[s]
          return (
            <button key={s} onClick={() => setFilter(s)}
              className={`flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-full border transition-all ${
                isActive
                  ? 'bg-gray-900 text-white border-gray-900'
                  : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
              }`}>
              {s !== 'all' && (
                <span className={`h-2 w-2 rounded-full ${STATUS_CONFIG[s].dot}`} />
              )}
              {s === 'all' ? 'All' : STATUS_CONFIG[s].label} ({count})
            </button>
          )
        })}
      </div>

      {/* Summary row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {(['available', 'occupied', 'reserved', 'cleaning'] as const).map(s => {
          const cfg = STATUS_CONFIG[s]
          return (
            <div key={s} className={`rounded-xl border-2 p-3 ${cfg.bg}`}>
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium text-gray-500">{cfg.label}</p>
                <cfg.Icon className={`h-4 w-4 ${cfg.text}`} />
              </div>
              <p className={`mt-2 text-2xl font-bold ${cfg.text}`}>{counts[s]}</p>
            </div>
          )
        })}
      </div>

      {/* Table grid */}
      {loading ? (
        <div className="bg-white rounded-xl border border-gray-200 p-8 text-center text-gray-400 text-sm">
          Loading…
        </div>
      ) : filtered.length === 0 ? (
        <div className="bg-white rounded-xl border-2 border-dashed border-gray-200 p-12 text-center">
          <Users className="h-8 w-8 text-gray-300 mx-auto mb-2" />
          <p className="text-sm text-gray-500">No tables found</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
          {filtered.map(table => {
            const status  = safeStatus(table.status)
            const cfg     = STATUS_CONFIG[status]
            const pending = pendingByTable[table.id]
            return (
              <div key={table.id} className={`rounded-2xl border-2 p-4 transition-all ${cfg.bg}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-base font-bold text-gray-900 truncate">{table.name}</p>
                    {table.seats != null && (
                      <p className="text-xs text-gray-500 mt-0.5">{table.seats} seats</p>
                    )}
                  </div>
                  <div className={`h-2.5 w-2.5 rounded-full mt-1.5 flex-shrink-0 ${cfg.dot}`} />
                </div>

                <div className="mt-3 flex items-end justify-between gap-1">
                  <span className={`text-xs font-semibold ${cfg.text}`}>{cfg.label}</span>
                  {pending && pending.count > 0 && (
                    <div className="text-right">
                      <span className="text-xs font-bold bg-orange-500 text-white rounded-full px-2 py-0.5">
                        {pending.count} order{pending.count > 1 ? 's' : ''}
                      </span>
                      <p className="text-[11px] text-orange-600 font-semibold mt-0.5">
                        {fmtRWF(pending.total)} RWF
                      </p>
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Takeaway summary — orders with no table */}
      {(() => {
        const takeaway = pendingOrders.filter(o => !o.table_id)
        if (!takeaway.length) return null
        const total = takeaway.reduce((s, o) => s + o.total_amount, 0)
        return (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold text-amber-800">Takeaway orders</p>
              <p className="text-xs text-amber-600 mt-0.5">{takeaway.length} active</p>
            </div>
            <p className="text-sm font-bold text-amber-800">{fmtRWF(total)} RWF</p>
          </div>
        )
      })()}
    </div>
  )
}
