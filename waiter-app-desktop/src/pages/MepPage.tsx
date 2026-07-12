import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { Search, Plus, X, ChefHat, Undo2, AlertTriangle } from 'lucide-react'
import {
  getMepItems, getMepCatalog, getDishes, getTodayMepLogs, getConfig,
  insertMepLog, adjustMepRemaining, markMepLogReversed, setMepLogPendingUndo,
  type MepItem, type MepLog,
} from '../services/db'
import { mepAddItemOnServer, mepRemoveItemOnServer } from '../services/sync'
import { logError } from '../services/logger'

interface MepPageProps {
  waiterName: string
  activeBranchId: string | null
  syncVersion: number
  isOnline: boolean
  requestSync: () => void
}

type SearchEntry = {
  targetType: 'prep' | 'dish'
  targetId: string
  name: string
  unit: string | null
}

function formatQty(value: number) {
  const rounded = Math.round(Number(value || 0) * 1000) / 1000
  return String(rounded)
}

function formatTime(iso: string) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export default function MepPage({ waiterName, activeBranchId, syncVersion, isOnline, requestSync }: MepPageProps) {
  const [items, setItems] = useState<MepItem[]>([])
  const [todayLogs, setTodayLogs] = useState<MepLog[]>([])
  const [searchEntries, setSearchEntries] = useState<SearchEntry[]>([])
  const [searchText, setSearchText] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [addingTargetId, setAddingTargetId] = useState<string | null>(null)
  const [qtyTarget, setQtyTarget] = useState<MepItem | null>(null)
  const [qtyValue, setQtyValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const qtyInputRef = useRef<HTMLInputElement>(null)

  const showNotice = useCallback((message: string) => {
    setNotice(message)
    window.setTimeout(() => setNotice((current) => (current === message ? null : current)), 4000)
  }, [])

  const reload = useCallback(async () => {
    try {
      // Dishes are stored restaurant-wide locally, but MEP is per-station:
      // only offer this branch's own dishes in the search.
      const [mepItems, catalog, dishes, logs] = await Promise.all([
        getMepItems(activeBranchId),
        getMepCatalog(activeBranchId),
        getDishes(activeBranchId),
        getTodayMepLogs(activeBranchId),
      ])

      // "Out" rows first — they're the ones asking for action.
      setItems([...mepItems].sort((a, b) => {
        const aOut = a.remaining <= 0 ? 0 : 1
        const bOut = b.remaining <= 0 ? 0 : 1
        return aOut - bOut || a.name.localeCompare(b.name)
      }))
      setTodayLogs(logs)

      const restaurantId = (await getConfig('restaurantId'))?.trim() || null
      const scopedDishes = restaurantId ? dishes.filter((d) => d.restaurant_id === restaurantId) : dishes
      setSearchEntries([
        ...catalog.map<SearchEntry>((prep) => ({ targetType: 'prep', targetId: prep.target_id, name: prep.name, unit: prep.unit })),
        ...scopedDishes.map<SearchEntry>((dish) => ({ targetType: 'dish', targetId: dish.id, name: dish.name, unit: 'portion' })),
      ])
    } catch (err) {
      void logError('mep', 'Failed to load MEP data', { error: (err as Error).message })
    }
  }, [activeBranchId])

  useEffect(() => { void reload() }, [reload, syncVersion])

  useEffect(() => {
    if (qtyTarget) qtyInputRef.current?.focus()
  }, [qtyTarget])

  const onList = useMemo(() => new Set(items.map((item) => `${item.target_type}:${item.target_id}`)), [items])

  const searchResults = useMemo(() => {
    const query = searchText.trim().toLowerCase()
    return searchEntries
      .filter((entry) => !onList.has(`${entry.targetType}:${entry.targetId}`))
      .filter((entry) => !query || entry.name.toLowerCase().includes(query))
      .slice(0, 12)
  }, [searchEntries, searchText, onList])

  const handleAdd = async (entry: SearchEntry) => {
    if (!isOnline) {
      showNotice('Connect to the internet to add MEP items.')
      return
    }
    setAddingTargetId(entry.targetId)
    try {
      await mepAddItemOnServer({
        branchId: activeBranchId,
        targetType: entry.targetType,
        targetId: entry.targetId,
        addedBy: waiterName || null,
      })
      setSearchText('')
      setSearchOpen(false)
      await reload()
    } catch (err) {
      showNotice((err as Error).message)
    } finally {
      setAddingTargetId(null)
    }
  }

  const handleRemove = async (item: MepItem) => {
    if (!isOnline) {
      showNotice('Connect to the internet to remove MEP items.')
      return
    }
    try {
      await mepRemoveItemOnServer({
        branchId: activeBranchId,
        targetType: item.target_type,
        targetId: item.target_id,
        itemId: item.id,
      })
      await reload()
    } catch (err) {
      showNotice((err as Error).message)
    }
  }

  const handleLogQty = async () => {
    if (!qtyTarget || busy) return
    const quantity = Number(qtyValue)
    if (!Number.isFinite(quantity) || quantity <= 0) {
      showNotice('Enter a quantity greater than 0.')
      return
    }

    setBusy(true)
    try {
      const restaurantId = (await getConfig('restaurantId'))?.trim() || null
      const now = new Date().toISOString()
      await insertMepLog({
        id: crypto.randomUUID(),
        restaurant_id: restaurantId,
        branch_id: qtyTarget.branch_id ?? activeBranchId,
        target_type: qtyTarget.target_type,
        target_id: qtyTarget.target_id,
        name: qtyTarget.name,
        quantity,
        made_by: waiterName || null,
        made_at: now,
        reversed: 0,
        pending_undo: 0,
        synced: 0,
        sync_error: null,
      })
      await adjustMepRemaining(qtyTarget.target_type, qtyTarget.target_id, quantity)
      setQtyTarget(null)
      setQtyValue('')
      await reload()
      requestSync()
    } catch (err) {
      showNotice((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const handleUndo = async (log: MepLog) => {
    if (log.reversed || log.pending_undo) return
    try {
      if (log.synced === 0) {
        // Never left this device — reverse locally, it will never be pushed.
        await markMepLogReversed(log.id)
      } else {
        // Already on the server — queue the undo, next sync sends it.
        await setMepLogPendingUndo(log.id)
      }
      await adjustMepRemaining(log.target_type, log.target_id, -log.quantity)
      await reload()
      requestSync()
    } catch (err) {
      showNotice((err as Error).message)
    }
  }

  return (
    <div className="space-y-4">
      {/* Header + search */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <ChefHat className="h-5 w-5 text-orange-500" />
          <h1 className="text-lg font-bold text-gray-900">MEP — Mise en place</h1>
        </div>
      </div>

      {notice && (
        <div className="flex items-center gap-2 rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-xs font-medium px-3 py-2">
          <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
          <span>{notice}</span>
        </div>
      )}

      {/* Search / add */}
      <div className="relative">
        <div className="flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-3 py-2.5 shadow-sm">
          <Search className="h-4 w-4 text-gray-400 flex-shrink-0" />
          <input
            value={searchText}
            onChange={(e) => { setSearchText(e.target.value); setSearchOpen(true) }}
            onFocus={() => setSearchOpen(true)}
            placeholder="Search preps & dishes…"
            className="w-full bg-transparent text-sm outline-none placeholder:text-gray-400"
          />
          {searchOpen && (
            <button onClick={() => { setSearchOpen(false); setSearchText('') }} className="text-gray-400 hover:text-gray-600">
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        {searchOpen && searchResults.length > 0 && (
          <div className="absolute z-20 mt-1 w-full rounded-xl border border-gray-200 bg-white shadow-lg max-h-72 overflow-y-auto">
            {searchResults.map((entry) => (
              <button
                key={`${entry.targetType}:${entry.targetId}`}
                onClick={() => { void handleAdd(entry) }}
                disabled={addingTargetId === entry.targetId}
                className="w-full flex items-center justify-between px-3 py-2.5 text-left hover:bg-orange-50 transition-colors disabled:opacity-50"
              >
                <span className="text-sm font-medium text-gray-800">{entry.name}</span>
                <span className="flex items-center gap-2 text-xs text-gray-400">
                  {entry.targetType === 'prep' ? (entry.unit ?? 'prep') : 'dish'}
                  <Plus className="h-3.5 w-3.5 text-orange-500" />
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* MEP list */}
      {items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-300 bg-white px-4 py-10 text-center">
          <ChefHat className="h-8 w-8 text-gray-300 mx-auto mb-2" />
          <p className="text-sm font-medium text-gray-500">No MEP items yet.</p>
          <p className="text-xs text-gray-400 mt-1">Search a prep or dish above to add it to this station's mise en place.</p>
        </div>
      ) : (
        <div className="rounded-xl border border-gray-200 bg-white shadow-sm divide-y divide-gray-100">
          {items.map((item) => {
            const isOut = item.remaining <= 0
            return (
              <div key={item.id} className="flex items-center gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-gray-900 truncate">{item.name}</p>
                  <p className="text-[11px] text-gray-400">{item.target_type === 'prep' ? 'Prep' : 'Dish'}</p>
                </div>
                {isOut ? (
                  <span className="flex-shrink-0 rounded-full bg-red-100 text-red-700 text-xs font-bold px-2.5 py-1">Out</span>
                ) : (
                  <span className="flex-shrink-0 rounded-full bg-emerald-50 text-emerald-700 text-xs font-semibold px-2.5 py-1">
                    {formatQty(item.remaining)} {item.target_type === 'dish' ? (item.remaining === 1 ? 'portion' : 'portions') : (item.unit ?? '')} left
                  </span>
                )}
                <button
                  onClick={() => { setQtyTarget(item); setQtyValue('') }}
                  className="flex-shrink-0 flex items-center gap-1 rounded-lg bg-orange-500 hover:bg-orange-600 text-white text-xs font-bold px-3 py-2 transition-colors"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Prepared
                </button>
                <button
                  onClick={() => { void handleRemove(item) }}
                  title="Remove from MEP"
                  className="flex-shrink-0 text-gray-300 hover:text-red-500 transition-colors p-1"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            )
          })}
        </div>
      )}

      {/* Today's logs */}
      {todayLogs.length > 0 && (
        <div>
          <h2 className="text-xs font-bold uppercase tracking-wide text-gray-400 mb-2">Today</h2>
          <div className="rounded-xl border border-gray-200 bg-white shadow-sm divide-y divide-gray-100">
            {todayLogs.map((log) => (
              <div key={log.id} className={`flex items-center gap-3 px-3 py-2 ${log.reversed ? 'opacity-50' : ''}`}>
                <span className="text-[11px] font-mono text-gray-400 flex-shrink-0">{formatTime(log.made_at)}</span>
                <span className="text-sm text-gray-800 truncate flex-1">
                  {log.name ?? log.target_id} <span className="font-semibold text-emerald-700">+{formatQty(log.quantity)}</span>
                  {log.made_by ? <span className="text-gray-400"> — {log.made_by}</span> : null}
                </span>
                {log.sync_error && (
                  <span className="text-[11px] text-red-500 truncate max-w-[180px]" title={log.sync_error}>{log.sync_error}</span>
                )}
                {log.reversed ? (
                  <span className="text-[11px] font-semibold text-gray-400 flex-shrink-0">Undone</span>
                ) : log.pending_undo ? (
                  <span className="text-[11px] font-semibold text-amber-500 flex-shrink-0">Undoing…</span>
                ) : (
                  <button
                    onClick={() => { void handleUndo(log) }}
                    className="flex-shrink-0 flex items-center gap-1 text-[11px] font-semibold text-gray-400 hover:text-red-500 transition-colors"
                  >
                    <Undo2 className="h-3 w-3" />
                    Undo
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Qty prepared dialog */}
      {qtyTarget && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 px-4" onClick={() => { if (!busy) setQtyTarget(null) }}>
          <div className="w-full max-w-xs rounded-2xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-bold text-gray-900 mb-1">{qtyTarget.name}</h3>
            <p className="text-xs text-gray-400 mb-3">
              Qty prepared{qtyTarget.target_type === 'dish' ? ' (portions)' : qtyTarget.unit ? ` (${qtyTarget.unit})` : ''}:
            </p>
            <input
              ref={qtyInputRef}
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              value={qtyValue}
              onChange={(e) => setQtyValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleLogQty() }}
              className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-lg font-bold text-gray-900 outline-none focus:border-orange-500"
              placeholder="0"
            />
            <div className="flex gap-2 mt-4">
              <button
                onClick={() => setQtyTarget(null)}
                disabled={busy}
                className="flex-1 rounded-lg border border-gray-200 py-2.5 text-sm font-semibold text-gray-600 hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => { void handleLogQty() }}
                disabled={busy || !qtyValue}
                className="flex-1 rounded-lg bg-orange-500 hover:bg-orange-600 py-2.5 text-sm font-bold text-white transition-colors disabled:opacity-50"
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
