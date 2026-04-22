'use client'
import { useState, useEffect, useCallback } from 'react'
import { ChefHat, RefreshCw, Clock, CheckCircle2, LogOut, Flame, Trash2, Plus, X } from 'lucide-react'
import { signOut, useSession } from 'next-auth/react'
import RestaurantCloudSync from '@/components/restaurant/RestaurantCloudSync'
import { buildRestaurantSnapshotScope, loadRestaurantDeviceSnapshot, mergeRestaurantDeviceSnapshot } from '@/lib/restaurantDeviceSnapshot'

type PendingOrder = {
  id: string
  tableName: string
  dishName: string
  dishPrice: number
  qty: number
  status: string
  notes?: string | null
  addedAt: string
  waiter?: { id: string; name: string }
}

type Ticket = {
  tableKey: string
  tableName: string
  items: PendingOrder[]
  oldestAddedAt: string
}

type KitchenShellSnapshot = {
  updatedAt: string
  orders: PendingOrder[]
  wasteIngredients: { id: string; name: string; unit: string }[]
}

function getAgeMinutes(addedAt: string): number {
  return Math.floor((Date.now() - new Date(addedAt).getTime()) / 60000)
}

function AgeTag({ addedAt }: { addedAt: string }) {
  const [mins, setMins] = useState(getAgeMinutes(addedAt))
  useEffect(() => {
    const t = setInterval(() => setMins(getAgeMinutes(addedAt)), 30000)
    return () => clearInterval(t)
  }, [addedAt])
  const color =
    mins < 5 ? 'bg-green-100 text-green-700' :
    mins < 10 ? 'bg-amber-100 text-amber-700' :
    'bg-red-100 text-red-700'
  return (
    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${color}`}>
      {mins}m
    </span>
  )
}

function groupToTickets(items: PendingOrder[]): Ticket[] {
  const map = new Map<string, PendingOrder[]>()
  for (const o of items) {
    if (!map.has(o.tableName)) map.set(o.tableName, [])
    map.get(o.tableName)!.push(o)
  }
  return Array.from(map.entries()).map(([tableName, ticketItems]) => ({
    tableKey: tableName,
    tableName,
    items: ticketItems,
    oldestAddedAt: ticketItems.reduce(
      (oldest, i) => (i.addedAt < oldest ? i.addedAt : oldest),
      ticketItems[0].addedAt
    ),
  }))
}

export default function KitchenShell() {
  const { data: session } = useSession()
  const [orders, setOrders] = useState<PendingOrder[]>([])
  const [updating, setUpdating] = useState<Set<string>>(new Set())
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date())
  const [fetchError, setFetchError] = useState<string | null>(null)

  // Waste modal
  const [showWaste, setShowWaste] = useState(false)
  const [wasteIngredients, setWasteIngredients] = useState<{ id: string; name: string; unit: string }[]>([])
  const [wasteForm, setWasteForm] = useState({ ingredientId: '', quantityWasted: '', reason: 'Spoilage', notes: '' })
  const [wasteSaving, setWasteSaving] = useState(false)
  const [wasteError, setWasteError] = useState<string | null>(null)
  const [wasteSuccess, setWasteSuccess] = useState(false)
  const [snapshotUpdatedAt, setSnapshotUpdatedAt] = useState<string | null>(null)
  const [showingCachedSnapshot, setShowingCachedSnapshot] = useState(false)
  const snapshotScopeId = buildRestaurantSnapshotScope({
    restaurantId: (session?.user as any)?.restaurantId ?? null,
    branchId: (session?.user as any)?.branchId ?? null,
    fallbackUserId: session?.user?.id ?? null,
  })
  const snapshotStorageScope = snapshotScopeId ? `kitchen-shell:${snapshotScopeId}` : null

  const persistSnapshot = useCallback((nextOrders: PendingOrder[], nextWasteIngredients: { id: string; name: string; unit: string }[]) => {
    if (!snapshotStorageScope) return
    const snapshot = mergeRestaurantDeviceSnapshot<KitchenShellSnapshot>(snapshotStorageScope, {
      orders: nextOrders,
      wasteIngredients: nextWasteIngredients,
    })
    if (!snapshot) return
    setSnapshotUpdatedAt(snapshot.updatedAt)
    setShowingCachedSnapshot(false)
  }, [snapshotStorageScope])

  async function openWasteModal() {
    setShowWaste(true)
    setWasteError(null)
    setWasteSuccess(false)
    setWasteForm({ ingredientId: '', quantityWasted: '', reason: 'Spoilage', notes: '' })
    if (wasteIngredients.length === 0) {
      const res = await fetch('/api/restaurant/ingredients', { credentials: 'include' })
      const data = await res.json()
      const nextWasteIngredients = Array.isArray(data) ? data : []
      setWasteIngredients(nextWasteIngredients)
      persistSnapshot(orders, nextWasteIngredients)
    }
  }

  async function submitWaste(e: React.FormEvent) {
    e.preventDefault()
    setWasteSaving(true)
    setWasteError(null)
    try {
      const res = await fetch('/api/restaurant/waste', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          ingredientId: wasteForm.ingredientId,
          quantityWasted: Number(wasteForm.quantityWasted),
          reason: wasteForm.reason,
          notes: wasteForm.notes || undefined,
        }),
      })
      if (!res.ok) {
        const err = await res.json()
        setWasteError(err.error ?? 'Failed to save')
      } else {
        setWasteSuccess(true)
        setTimeout(() => setShowWaste(false), 1200)
      }
    } catch {
      setWasteError('Network error')
    } finally {
      setWasteSaving(false)
    }
  }

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/restaurant/pending', { credentials: 'include' })
      if (!res.ok) { setFetchError(`Server error ${res.status}`); return }
      const data = await res.json()
      const nextOrders = Array.isArray(data) ? data : []
      setOrders(nextOrders)
      persistSnapshot(nextOrders, wasteIngredients)
      setLastRefresh(new Date())
      setFetchError(null)
    } catch (e: any) {
      setFetchError(e?.message ?? 'Network error')
    }
  }, [persistSnapshot, wasteIngredients])

  useEffect(() => {
    if (!snapshotStorageScope) return

    const snapshot = loadRestaurantDeviceSnapshot<KitchenShellSnapshot>(snapshotStorageScope)
    if (!snapshot) return

    setOrders(Array.isArray(snapshot.orders) ? snapshot.orders : [])
    setWasteIngredients(Array.isArray(snapshot.wasteIngredients) ? snapshot.wasteIngredients : [])
    setSnapshotUpdatedAt(snapshot.updatedAt ?? null)
    setLastRefresh(snapshot.updatedAt ? new Date(snapshot.updatedAt) : new Date())
    setShowingCachedSnapshot(true)
  }, [snapshotStorageScope])

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 5000)
    return () => clearInterval(t)
  }, [refresh])

  async function updateStatus(orderIds: string[], status: string) {
    setUpdating(prev => new Set([...prev, ...orderIds]))
    try {
      await Promise.all(
        orderIds.map(id =>
          fetch(`/api/restaurant/pending/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ status }),
          })
        )
      )
      await refresh()
    } catch {}
    setUpdating(prev => {
      const next = new Set(prev)
      orderIds.forEach(id => next.delete(id))
      return next
    })
  }

  // Treat missing/null status as 'new' (guards against stale Prisma client not returning the field)
  const newTickets     = groupToTickets(orders.filter(o => !o.status || o.status === 'new'))
  const cookingTickets = groupToTickets(orders.filter(o => o.status === 'in_kitchen'))
  const readyTickets   = groupToTickets(orders.filter(o => o.status === 'ready'))

  const restaurantName = (session?.user as any)?.restaurantName ?? 'Kitchen'
  const snapshotUpdatedLabel = snapshotUpdatedAt
    ? new Date(snapshotUpdatedAt).toLocaleString('en-RW', { dateStyle: 'medium', timeStyle: 'short' })
    : null

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <RestaurantCloudSync />
      {showingCachedSnapshot && snapshotUpdatedLabel ? (
        <div className="mx-6 mt-4 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
          <p className="font-semibold">Showing last synced kitchen snapshot from this device</p>
          <p className="mt-1 text-xs opacity-90">Last synced snapshot: {snapshotUpdatedLabel}</p>
        </div>
      ) : null}

      {/* ── Header ────────────────────────────────────────────────────────────── */}
      <div className="bg-white border-b border-gray-200 px-4 sm:px-6 py-3 sm:py-4 flex items-center justify-between flex-wrap gap-2 flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="bg-gradient-to-br from-orange-500 to-red-600 rounded-xl p-2.5 shadow-sm">
            <ChefHat className="h-5 w-5 text-white" />
          </div>
          <div>
            <h1 className="font-bold text-gray-900 text-base sm:text-lg leading-tight">Kitchen Display</h1>
            <p className="text-xs text-gray-400">
              Auto-refreshes every 5 s &middot; last at{' '}
              {lastRefresh.toLocaleTimeString('en-RW', { hour: '2-digit', minute: '2-digit' })}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={refresh}
            className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800 bg-gray-100 hover:bg-gray-200 px-3 py-1.5 rounded-lg transition-colors"
          >
            <RefreshCw className="h-4 w-4" /> <span className="hidden sm:inline">Refresh</span>
          </button>
          <button
            onClick={() => signOut({ callbackUrl: '/login' })}
            className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-red-600 bg-gray-100 hover:bg-red-50 px-3 py-1.5 rounded-lg transition-colors"
          >
            <LogOut className="h-4 w-4" /> <span className="hidden sm:inline">Sign Out</span>
          </button>
        </div>
      </div>

      {/* ── Error banner ──────────────────────────────────────────────────────── */}
      {fetchError && (
        <div className="mx-6 mt-4 px-4 py-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg flex items-center gap-2">
          <span className="font-semibold">Connection error:</span> {fetchError} — retrying automatically.
        </div>
      )}

      {/* ── Waste button bar ─────────────────────────────────────────────────── */}
      <div className="flex justify-center px-6 pb-2">
        <button
          onClick={openWasteModal}
          className="flex items-center gap-2 bg-red-500 hover:bg-red-600 active:scale-95 text-white text-sm font-semibold px-5 py-3 rounded-xl shadow-sm transition-all"
        >
          <Trash2 className="h-4 w-4" />
          Log Wasted Item
        </button>
      </div>

      {/* ── Board ─────────────────────────────────────────────────────────────── */}
      <div className="flex-1 p-3 sm:p-6 grid grid-cols-1 sm:grid-cols-3 gap-4 sm:gap-6 overflow-auto">

        {/* NEW ORDERS */}
        <Column
          title="New Orders"
          count={newTickets.length}
          badgeColor="bg-orange-500"
          emptyIcon={<Flame className="h-10 w-10 mx-auto mb-2 opacity-20" />}
          emptyText="No new orders"
        >
          {newTickets.map(ticket => (
            <TicketCard
              key={ticket.tableKey}
              ticket={ticket}
              updating={updating}
            >
              <button
                onClick={() => updateStatus(ticket.items.map(i => i.id), 'in_kitchen')}
                disabled={ticket.items.some(i => updating.has(i.id))}
                className="flex-1 bg-orange-500 hover:bg-orange-600 active:scale-95 disabled:opacity-50 text-white text-base font-bold py-4 rounded-xl transition-all"
              >
                Start Cooking
              </button>
            </TicketCard>
          ))}
        </Column>

        {/* IN PROGRESS */}
        <Column
          title="In Progress"
          count={cookingTickets.length}
          badgeColor="bg-amber-400"
          emptyIcon={<Clock className="h-10 w-10 mx-auto mb-2 opacity-20" />}
          emptyText="Nothing cooking"
        >
          {cookingTickets.map(ticket => (
            <TicketCard
              key={ticket.tableKey}
              ticket={ticket}
              updating={updating}
            >
              <button
                onClick={() => updateStatus(ticket.items.map(i => i.id), 'ready')}
                disabled={ticket.items.some(i => updating.has(i.id))}
                className="flex-1 bg-green-500 hover:bg-green-600 active:scale-95 disabled:opacity-50 text-white text-base font-bold py-4 rounded-xl transition-all"
              >
                Mark Ready
              </button>
            </TicketCard>
          ))}
        </Column>

        {/* READY */}
        <Column
          title="Ready to Serve"
          count={readyTickets.length}
          badgeColor="bg-green-500"
          emptyIcon={<CheckCircle2 className="h-10 w-10 mx-auto mb-2 opacity-20" />}
          emptyText="Nothing ready yet"
        >
          {readyTickets.map(ticket => (
            <TicketCard
              key={ticket.tableKey}
              ticket={ticket}
              updating={updating}
            >
              <div className="flex items-center gap-1.5 text-green-600 text-sm font-semibold">
                <CheckCircle2 className="h-4 w-4" /> Waiting for pickup
              </div>
            </TicketCard>
          ))}
        </Column>

      </div>

      {/* ── Waste Modal ─────────────────────────────────────────────────────────── */}
      {showWaste && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="bg-red-100 p-1.5 rounded-lg"><Trash2 className="h-4 w-4 text-red-600"/></div>
                <h3 className="font-bold text-gray-900">Log Wasted Item</h3>
              </div>
              <button onClick={() => setShowWaste(false)}><X className="h-5 w-5 text-gray-400 hover:text-gray-600"/></button>
            </div>

            {wasteSuccess ? (
              <div className="py-6 text-center">
                <div className="text-green-500 text-4xl mb-2">✓</div>
                <p className="text-sm font-semibold text-green-700">Waste logged successfully!</p>
              </div>
            ) : (
              <form onSubmit={submitWaste} className="space-y-3">
                <div>
                  <label className="text-xs font-semibold text-gray-600 mb-1 block">Ingredient</label>
                  <select required value={wasteForm.ingredientId}
                    onChange={e => setWasteForm(f => ({ ...f, ingredientId: e.target.value }))}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-red-400 outline-none">
                    <option value="">Select ingredient…</option>
                    {wasteIngredients.map(i => (
                      <option key={i.id} value={i.id}>{i.name} ({i.unit})</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-semibold text-gray-600 mb-1 block">Quantity Wasted</label>
                  <input required type="number" min="0.01" step="any"
                    value={wasteForm.quantityWasted}
                    onChange={e => setWasteForm(f => ({ ...f, quantityWasted: e.target.value }))}
                    placeholder="e.g. 0.5"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-red-400 outline-none"/>
                </div>
                <div>
                  <label className="text-xs font-semibold text-gray-600 mb-1 block">Reason</label>
                  <select value={wasteForm.reason}
                    onChange={e => setWasteForm(f => ({ ...f, reason: e.target.value }))}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-red-400 outline-none">
                    <option>Spoilage</option>
                    <option>Overproduction</option>
                    <option>Expired</option>
                    <option>Dropped / Accident</option>
                    <option>Quality Issue</option>
                    <option>Other</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs font-semibold text-gray-600 mb-1 block">Notes <span className="font-normal text-gray-400">(optional)</span></label>
                  <input type="text" value={wasteForm.notes}
                    onChange={e => setWasteForm(f => ({ ...f, notes: e.target.value }))}
                    placeholder="e.g. fell on the floor"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-red-400 outline-none"/>
                </div>
                {wasteError && <p className="text-xs text-red-600 bg-red-50 px-3 py-2 rounded-lg">{wasteError}</p>}
                <div className="flex gap-2 pt-1">
                  <button type="button" onClick={() => setShowWaste(false)}
                    className="flex-1 border border-gray-300 text-gray-700 text-sm font-medium py-3 rounded-lg hover:bg-gray-50 transition-colors">Cancel</button>
                  <button type="submit" disabled={wasteSaving}
                    className="flex-1 bg-red-500 hover:bg-red-600 disabled:opacity-60 text-white text-sm font-semibold py-3 rounded-lg transition-colors flex items-center justify-center gap-1.5">
                    {wasteSaving ? 'Saving…' : <><Plus className="h-4 w-4"/>Log Waste</>}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/* ── Sub-components ─────────────────────────────────────────────────────────── */

function Column({
  title, count, badgeColor, emptyIcon, emptyText, children,
}: {
  title: string
  count: number
  badgeColor: string
  emptyIcon: React.ReactNode
  emptyText: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col min-w-0">
      <div className="flex items-center justify-between mb-4 pb-3 border-b border-gray-200">
        <p className="text-xs font-bold uppercase tracking-widest text-gray-500">{title}</p>
        {count > 0 && (
          <span className={`${badgeColor} text-white text-xs font-bold px-2 py-0.5 rounded-full`}>
            {count}
          </span>
        )}
      </div>
      <div className="space-y-3 flex-1">
        {count === 0 ? (
          <div className="text-center py-16 text-gray-300">
            {emptyIcon}
            <p className="text-sm">{emptyText}</p>
          </div>
        ) : children}
      </div>
    </div>
  )
}

function TicketCard({
  ticket, updating, children,
}: {
  ticket: Ticket
  updating: Set<string>
  children: React.ReactNode
}) {
  const isLoading = ticket.items.some(i => updating.has(i.id))
  return (
    <div className={`bg-white rounded-xl border border-gray-200 shadow-sm p-4 space-y-3 transition-opacity ${isLoading ? 'opacity-60' : ''}`}>
      <div className="flex items-center justify-between">
        <span className="font-bold text-gray-900 text-lg">{ticket.tableName}</span>
        <AgeTag addedAt={ticket.oldestAddedAt} />
      </div>
      <div className="space-y-1.5">
        {ticket.items.map(item => (
          <div key={item.id} className="flex items-center justify-between">
            <span className="text-base text-gray-800">{item.dishName}</span>
            <span className="text-base font-bold text-gray-500 bg-gray-100 px-2 py-0.5 rounded-md">
              ×{item.qty}
            </span>
          </div>
        ))}
      </div>
      {ticket.items[0]?.waiter?.name && (
        <p className="text-xs text-gray-400">by {ticket.items[0].waiter.name}</p>
      )}
      <div className="flex gap-2 pt-1">{children}</div>
    </div>
  )
}
